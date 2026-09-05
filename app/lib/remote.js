// lib/remote.js
// "Remote-desktop for one browser window" so the phone can drive a REAL Spotify
// login that runs on the PC.
//
// Why this and not a proxy: Spotify's login runs Google reCAPTCHA, whose site
// key is domain-locked to accounts.spotify.com. A reverse proxy puts the page
// on our domain, so reCAPTCHA refuses ("Oops, something went wrong"). Here the
// login runs in a Chrome we launch on the PC that is *actually* on
// accounts.spotify.com, so reCAPTCHA is happy. The phone never touches Spotify
// directly — it just sees a screen-share of that window and sends taps/keys,
// relayed over the Chrome DevTools Protocol. When Spotify sets sp_dc, we read it
// straight out of the browser (no cookie-store decryption) and save it.
//
// Everything is local: the PC drives its own Chrome; the phone is a thin remote.

import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import net from 'net';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(__dirname, '..', '.data', 'remote-login');
// The same logged-in profile is reused to mint the web-player token (webtoken.js).
export const REMOTE_PROFILE_DIR = PROFILE_DIR;
const LOGIN_URL =
  'https://accounts.spotify.com/en/login?continue=' +
  encodeURIComponent('https://open.spotify.com/');

const VW = 420, VH = 760; // login-form-sized viewport

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find a Chromium-family browser we can drive over CDP, on any OS.
export function findBrowser() {
  const has = (p) => { try { return p && existsSync(p); } catch { return false; } };
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pfx = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LOCALAPPDATA'] || '';
    return [
      join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      join(pfx, 'Google\\Chrome\\Application\\chrome.exe'),
      lad && join(lad, 'Google\\Chrome\\Application\\chrome.exe'),
      join(pfx, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    ].filter(Boolean).find(has) || null;
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ].find(has) || null;
  }
  // Linux / other (incl. Orange Pi / Raspberry Pi): common locations, then PATH.
  const fixed = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  ].find(has);
  if (fixed) return fixed;
  for (const n of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'microsoft-edge']) {
    try {
      const r = spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' });
      const p = (r.stdout || '').trim();
      if (p && has(p)) return p;
    } catch { /* keep trying */ }
  }
  return null;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Minimal CDP client. Every request has an 8s timeout so a dead browser can
// never hang a caller (that was what wedged /api/remote/stop).
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = new Map();
    let id = 0;
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          const to = setTimeout(() => { pending.delete(mid); rej(new Error(`CDP timeout: ${method}`)); }, 8000);
          pending.set(mid, { res, rej, to });
          try { ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }
          catch (e) { clearTimeout(to); pending.delete(mid); rej(e); }
        });
      },
      on(method, handler) {
        if (!handlers.has(method)) handlers.set(method, new Set());
        handlers.get(method).add(handler);
        return () => handlers.get(method)?.delete(handler);
      },
      close() { try { ws.close(); } catch {} },
    });
    ws.onerror = (e) => reject(new Error('CDP error: ' + (e?.message || 'ws')));
    ws.onclose = () => { for (const { rej, to } of pending.values()) { clearTimeout(to); rej(new Error('CDP closed')); } pending.clear(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data?.toString()); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej, to } = pending.get(m.id); clearTimeout(to); pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && handlers.has(m.method)) {
        for (const h of handlers.get(m.method)) {
          try { h(m.params); } catch {}
        }
      }
    };
  });
}

// ── single active session ──
let session = null; // { child, conn, browserConn, frame, frameBuffer, seq, frames, meta, subscribers: Set, status, message, onCapture, triggerCapture }

export const remoteState = () => ({
  active: !!session,
  status: session?.status || 'idle',
  message: session?.message || '',
  frames: session?.frames || 0,
  seq: session?.seq || 0,
});

export function broadcast(msg) {
  if (!session?.subscribers) return;
  const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of session.subscribers) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(payload); } catch {}
    }
  }
}

export function setSessionStatus(status, message) {
  if (!session) return;
  session.status = status;
  if (message !== undefined) session.message = message;
  broadcast({ type: 'status', ...remoteState() });
}

export function addRemoteSubscriber(ws) {
  if (!session) {
    ws.send(JSON.stringify({ type: 'status', active: false, status: 'idle', message: '' }));
    return;
  }
  session.subscribers.add(ws);
  ws.send(JSON.stringify({ type: 'status', ...remoteState() }));
  if (session.frame) {
    ws.send(JSON.stringify({
      type: 'frame',
      seq: session.seq,
      data: session.frame,
      mimeType: session.mimeType || 'image/jpeg',
    }));
  }
  ws.on('message', async (data) => {
    try {
      const raw = typeof data === 'string' ? data : data.toString();
      const msg = JSON.parse(raw);
      if (msg.type === 'input') {
        await sendInput(msg.input || msg);
      }
    } catch {}
  });
  ws.on('close', () => {
    session?.subscribers?.delete(ws);
  });
}

/** Latest frame as Buffer (or null). Supports ?since= for 304 caching. */
export const getFrame = (sinceSeq) => {
  if (!session?.frameBuffer) return null;
  if (sinceSeq != null && Number(sinceSeq) >= session.seq) {
    return { notModified: true, seq: session.seq };
  }
  return {
    buffer: session.frameBuffer,
    seq: session.seq,
    mimeType: session.mimeType || 'image/jpeg',
  };
};

export async function pageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        const list = await r.json();
        const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (p) return p.webSocketDebuggerUrl;
      }
    } catch {}
    await sleep(300);
  }
  return null;
}

// Browser-level websocket: stable across page navigations, so cookie reads
// survive the final accounts.spotify.com -> loopback /callback hop.
async function browserTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { const j = await r.json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; }
    } catch {}
    await sleep(300);
  }
  return null;
}

/**
 * Launch the browser + start the screen-share.
 * @param {object} opts
 * @param {string} [opts.startUrl]   First URL to load. Point this at the local
 *   /login route so the whole OAuth completes over a STATIC loopback redirect
 *   (http://127.0.0.1:PORT/callback) — signing in there also sets sp_dc, so one
 *   sign-in covers both the Web API tokens and Jam.
 * @param {(spDc:string)=>void} opts.onCapture  Called once with sp_dc.
 * @param {()=>boolean} [opts.isOauthDone]  Returns true when the Web API OAuth
 *   has completed. Defaults to always-true (sp_dc-only mode).
 * @param {boolean} [opts.wantSpDc=true]  Whether this run should also capture
 *   sp_dc. The session finishes when OAuth is done AND (sp_dc captured or not
 *   wanted), or after a hard timeout.
 * @param {number} [opts.maxMs]  Hard cap before giving up (default 5 min).
 */
export async function startRemote({ startUrl, onCapture, isOauthDone, wantSpDc = true, maxMs = 5 * 60_000 } = {}) {
  await stopRemote(); // one at a time
  const browser = findBrowser();
  if (!browser) throw new Error('No Chrome/Edge found on this PC.');
  mkdirSync(PROFILE_DIR, { recursive: true });
  const port = await freePort();

  const launch = (dbgPort, headless) => {
    const args = [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${dbgPort}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      // Look like an ordinary browser so reCAPTCHA doesn't keep challenging.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,MediaRouter',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      `--window-size=${VW},${VH}`,
    ];
    // The phone only ever sees CDP screencast frames, so headless Chromium serves
    // the remote just as well when there's no (working) display.
    if (headless) args.push('--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
    args.push(startUrl || LOGIN_URL);
    const c = spawn(browser, args, { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    return c;
  };

  // Headed if an X/Wayland display is plausible; otherwise straight to headless.
  const hasDisplay = process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
  let dbgPort = port;
  let child = launch(dbgPort, !hasDisplay);
  let nextWake = null;
  const triggerCapture = () => {
    if (nextWake) {
      const fn = nextWake;
      nextWake = null;
      fn();
    }
  };

  session = {
    child,
    conn: null,
    browserConn: null,
    frame: null,
    frameBuffer: null,
    seq: 0,
    frames: 0,
    meta: { deviceWidth: VW, deviceHeight: VH },
    status: 'starting',
    message: 'Opening Spotify sign-in on the PC…',
    onCapture,
    subscribers: new Set(),
    triggerCapture,
  };

  let wsUrl = await pageTarget(dbgPort, Date.now() + 25_000);
  if (!wsUrl && hasDisplay && process.platform === 'linux') {
    // DISPLAY was set but the browser never came up (X dead / container) —
    // retry headless on a fresh port before giving up.
    try { if (child.pid) process.kill(child.pid); } catch {}
    dbgPort = await freePort();
    child = launch(dbgPort, true);
    if (session) session.child = child;
    wsUrl = await pageTarget(dbgPort, Date.now() + 25_000);
  }
  if (!wsUrl) { await stopRemote(); throw new Error('Could not attach to the browser.'); }
  const conn = await cdp(wsUrl);
  session.conn = conn;

  // Separate browser-level connection for cookie reads (survives page swaps).
  let cookieConn = conn;
  try {
    const bUrl = await browserTarget(dbgPort, Date.now() + 5000);
    if (bUrl) { cookieConn = await cdp(bUrl); session.browserConn = cookieConn; }
  } catch {}

  await conn.send('Page.enable').catch(() => {});
  await conn.send('Network.enable').catch(() => {});
  await conn.send('Page.bringToFront').catch(() => {});

  // Anti-detection script to pass Google reCAPTCHA
  await conn.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = window.chrome || { runtime: {} };
    `,
  }).catch(() => {});

  // Track the REAL css viewport for input mapping (no device-metrics override —
  // that override is what made the window flicker and threw off clicks). Input
  // uses normalized 0..1 coords, so this maps them to page coordinates.
  const refreshViewport = async () => {
    try {
      const m = await conn.send('Page.getLayoutMetrics');
      // Visual viewport = exactly what the screenshot shows, so taps map cleanly.
      const vp = m.cssVisualViewport || m.cssLayoutViewport || m.layoutViewport;
      const w = vp?.clientWidth || vp?.width, h = vp?.clientHeight || vp?.height;
      if (w && h) session.meta = { deviceWidth: w, deviceHeight: h };
    } catch {}
  };
  await refreshViewport();

  setSessionStatus('live', 'Sign in — you are driving the PC browser.');

  // Screencast stream: hardware-accelerated 30-60 FPS JPEG push directly from the compositor.
  let screencastActive = false;
  conn.on('Page.screencastFrame', (params) => {
    screencastActive = true;
    conn.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (session && session.conn === conn && params.data) {
      session.frame = params.data;
      session.frameBuffer = Buffer.from(params.data, 'base64');
      session.mimeType = 'image/jpeg';
      session.seq = (session.seq || 0) + 1;
      session.frames++;
      if (params.metadata?.deviceWidth && params.metadata?.deviceHeight) {
        session.meta = { deviceWidth: params.metadata.deviceWidth, deviceHeight: params.metadata.deviceHeight };
      }
      broadcast({
        type: 'frame',
        seq: session.seq,
        data: session.frame,
        mimeType: 'image/jpeg',
      });
    }
  });

  try {
    await conn.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: VW,
      maxHeight: VH,
      everyNthFrame: 1,
    });
    screencastActive = true;
  } catch {
    screencastActive = false;
  }

  // Fallback screenshot polling loop if screencast is unsupported
  (async () => {
    let tick = 0;
    while (session && session.conn === conn) {
      if (!screencastActive) {
        try {
          const r = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
          if (r?.data && session && session.conn === conn) {
            if (r.data !== session.frame) {
              session.frame = r.data;
              session.frameBuffer = Buffer.from(r.data, 'base64');
              session.mimeType = 'image/jpeg';
              session.seq = (session.seq || 0) + 1;
              session.frames++;
              broadcast({
                type: 'frame',
                seq: session.seq,
                data: session.frame,
                mimeType: 'image/jpeg',
              });
            }
          }
        } catch {}
      }
      if ((++tick % 15) === 0) await refreshViewport();

      await new Promise((resolve) => {
        const to = setTimeout(() => { nextWake = null; resolve(); }, screencastActive ? 500 : 150);
        nextWake = () => { clearTimeout(to); resolve(); };
      });
    }
  })();

  // Completion loop: grab sp_dc whenever it appears; finish when OAuth is done
  // AND (sp_dc captured or not wanted), or after the hard timeout.
  const findSpDc = (cookies) => (cookies || []).find((k) => k.name === 'sp_dc' && k.value &&
    /(^|\.)spotify\.com$/.test((k.domain || '').replace(/^\./, '')));
  const readCookies = async () => {
    // Storage.getCookies works at the browser level and survives page swaps;
    // fall back to the page's Network.getAllCookies if needed.
    try { return (await cookieConn.send('Storage.getCookies')).cookies; }
    catch { return (await conn.send('Network.getAllCookies')).cookies; }
  };
  const hardDeadline = Date.now() + maxMs;
  (async () => {
    let gotSpDc = false;
    while (session && session.conn === conn) {
      try {
        const c = findSpDc(await readCookies());
        if (c && !gotSpDc) { gotSpDc = true; try { onCapture(c.value); } catch {} }
      } catch { /* keep polling */ }

      const oauthOk = isOauthDone ? isOauthDone() : true;
      const spOk = !wantSpDc || gotSpDc;
      const timedOut = Date.now() > hardDeadline;

      if ((oauthOk && spOk) || timedOut) {
        setSessionStatus('captured', !oauthOk ? 'Timed out before sign-in finished.'
          : (wantSpDc && !gotSpDc) ? 'Signed in (Jam cookie not found — optional).'
          : 'Signed in — all set.');
        await sleep(600);
        await stopRemote();
        return;
      }
      // Nudge the message once the account is connected but we're still waiting.
      if (oauthOk && wantSpDc && !gotSpDc) setSessionStatus('live', 'Signed in — enabling Jam…');
      await sleep(1500);
    }
  })();

  return { ok: true };
}

// Translate a phone gesture into a CDP input event.
export async function sendInput(ev) {
  if (!session?.conn) return;
  const conn = session.conn;
  const dw = session.meta?.deviceWidth || VW;
  const dh = session.meta?.deviceHeight || VH;
  try {
    if (ev.type === 'click') {
      const x = Math.max(0, Math.min(1, ev.nx)) * dw;
      const y = Math.max(0, Math.min(1, ev.ny)) * dh;
      // Move first (hover + a trusted motion), then a deliberate press/release —
      // more reliable than a bare press, and reads as a real click.
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await sleep(15);
      await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(25);
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    } else if (ev.type === 'wheel') {
      const x = (ev.nx ?? 0.5) * dw, y = (ev.ny ?? 0.5) * dh;
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: ev.dy || 0 });
    } else if (ev.type === 'text') {
      await conn.send('Input.insertText', { text: String(ev.text || '') });
    } else if (ev.type === 'key') {
      const map = { Enter: 13, Backspace: 8, Tab: 9 };
      const vk = map[ev.key] || 0;
      const base = { windowsVirtualKeyCode: vk, code: ev.key, key: ev.key };
      const n = Math.max(1, ev.n || 1);
      for (let i = 0; i < n; i++) {
        await conn.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ev.key === 'Enter' ? '\r' : undefined });
        await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      }
    }
  } catch {}
  // Trigger immediate frame capture so the UI responds instantaneously to user input
  session?.triggerCapture?.();
}

export async function stopRemote() {
  const s = session;
  session = null;
  if (!s) return;
  try {
    for (const client of (s.subscribers || [])) {
      try {
        client.send(JSON.stringify({ type: 'status', active: false, status: 'closed', message: 'Session closed' }));
        client.close();
      } catch {}
    }
    s.subscribers?.clear();
  } catch {}
  try { s.conn?.close(); } catch {}
  try { s.browserConn?.close(); } catch {}
  try { if (s.child?.pid) process.kill(s.child.pid); } catch {}
}
