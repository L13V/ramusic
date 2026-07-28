// lib/webtoken.js
// Mint the Spotify "web player" access token the LEGITIMATE way: briefly run the
// user's own logged-in browser (the profile from the remote sign-in), let
// Spotify's real web player fetch its token, and read that token back off the
// network. No reverse-engineering of Spotify's anti-scraping TOTP — their own
// client does the work; we just reuse the session the user already granted.
//
// The token is needed for the Jam / social-connect endpoints. It's cached until
// shortly before it expires; refresh spins the browser up again (~hourly).

import { spawn } from 'child_process';
import { findBrowser, freePort, pageTarget, REMOTE_PROFILE_DIR } from './remote.js';
import { getCreds, saveStore } from './auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal CDP client with request/response AND event handlers (needed to watch
// network responses).
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
          const to = setTimeout(() => { pending.delete(mid); rej(new Error('CDP timeout: ' + method)); }, 10_000);
          pending.set(mid, { res, rej, to });
          try { ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }
          catch (e) { clearTimeout(to); pending.delete(mid); rej(e); }
        });
      },
      on(method, fn) { handlers.set(method, fn); },
      close() { try { ws.close(); } catch {} },
    });
    ws.onerror = (e) => reject(new Error('CDP error: ' + (e?.message || 'ws')));
    ws.onclose = () => { for (const { rej, to } of pending.values()) { clearTimeout(to); rej(new Error('CDP closed')); } pending.clear(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const { res, rej, to } = pending.get(m.id); clearTimeout(to); pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method && handlers.has(m.method)) {
        handlers.get(m.method)(m.params);
      }
    };
  });
}

// ── cache + single-flight ──
let cache = { token: null, exp: 0 };
let inflight = null;

/** Returns a valid web-player access token, refreshing via the browser if needed. */
export async function getWebToken() {
  if (cache.token && Date.now() < cache.exp - 60_000) return cache.token;
  if (inflight) return inflight;
  inflight = mint().finally(() => { inflight = null; });
  return inflight;
}

export function clearWebToken() { cache = { token: null, exp: 0 }; }

async function mint() {
  const spDc = getCreds(process.env).spDc;
  if (!spDc) throw new Error('web token: no sp_dc — sign in on /setup first');
  const browser = findBrowser();
  if (!browser) throw new Error('web token: no Chrome/Edge found on this PC');
  const port = await freePort();
  // Start on a blank page so we can inject sp_dc BEFORE Spotify loads, making
  // the session logged-in from our stored cookie regardless of profile state.
  const child = spawn(browser, [
    `--user-data-dir=${REMOTE_PROFILE_DIR}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--disable-gpu',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});

  let conn = null;
  try {
    const wsUrl = await pageTarget(port, Date.now() + 20_000);
    if (!wsUrl) throw new Error('web token: could not attach to browser');
    conn = await cdp(wsUrl);

    await conn.send('Network.enable').catch(() => {});
    await conn.send('Page.enable').catch(() => {});
    // Inject the login cookie so open.spotify.com sees a signed-in session.
    await conn.send('Network.setCookie', {
      name: 'sp_dc', value: spDc, domain: '.spotify.com', path: '/',
      httpOnly: true, secure: true, sameSite: 'None',
    }).catch(() => {});

    // Watch for the token response Spotify's own player fetches on load.
    const result = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('web token: timed out waiting for token')), 30_000);
      const wanted = new Set(); // requestIds for /api/token or get_access_token
      conn.on('Network.responseReceived', (p) => {
        const url = p.response?.url || '';
        if (/\/(api\/token|get_access_token)\b/.test(url)) wanted.add(p.requestId);
      });
      conn.on('Network.loadingFinished', async (p) => {
        if (!wanted.has(p.requestId)) return;
        try {
          const body = await conn.send('Network.getResponseBody', { requestId: p.requestId });
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          const j = JSON.parse(text);
          if (j.accessToken && !j.isAnonymous) {
            clearTimeout(deadline);
            resolve({ token: j.accessToken, exp: j.accessTokenExpirationTimestampMs || Date.now() + 55 * 60_000 });
          } else if (j.isAnonymous) {
            clearTimeout(deadline);
            // sp_dc no longer valid -> forget it so /setup prompts a fresh sign-in.
            saveStore({ spDc: null }); clearWebToken();
            reject(new Error('web token: sp_dc invalid/expired — redo the sign-in on /setup'));
          }
        } catch { /* not the body we want; keep waiting */ }
      });
      conn.send('Page.navigate', { url: 'https://open.spotify.com/' }).catch(() => {});
    });

    cache = result;
    return result.token;
  } finally {
    try { conn?.close(); } catch {}
    try { if (child.pid) process.kill(child.pid); } catch {}
  }
}
