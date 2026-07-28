// server.js
import 'dotenv/config';
import express from 'express';
import https from 'https';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import crypto from 'crypto';
import { getState, setWebDeviceId, getWebDeviceId, currentJoinUrl } from './lib/spotify.js';
import { demoState } from './lib/demo.js';
import { getWeather } from './lib/weather.js';
import {
  isConfigured, getCreds, saveStore, disconnect,
  createLoginUrl, exchangeCode, getProfile, getAccessToken, lanIp, getTls,
} from './lib/auth.js';
import { startTunnel, stopTunnel, tunnelState } from './lib/tunnel.js';
import { startRemote, stopRemote, getFrame, sendInput, remoteState } from './lib/remote.js';
import { getWebToken as prewarmWebToken } from './lib/webtoken.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const HTTPS_PORT = Number(env.HTTPS_PORT) || PORT + 443; // 3443 by default

const app = express();
app.set('trust proxy', true); // cloudflared sits in front during setup
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const isDemo = () => String(env.DEMO).toLowerCase() === 'true' || env.DEMO === '1';
const tunnelEnabled = () => String(env.TUNNEL ?? 'true').toLowerCase() !== 'false';
const webPlayerEnabled = () => String(env.WEBPLAYER ?? 'true').toLowerCase() !== 'false';

// Client-facing config, shared by every /api/state response.
const clientConfig = () => ({
  clock24h: String(env.CLOCK_24H).toLowerCase() === 'true',
  refreshMs: Number(env.REFRESH_MS) || 5000,
  city: env.WEATHER_CITY || '',
  webPlayer: webPlayerEnabled() && !isDemo(),
  deviceName: env.WEBPLAYER_NAME || 'TV Jam',
  // Volume/playback exist whenever an account is connected — covers the Pi's
  // librespot device even when the browser Web Playback SDK is off.
  canPlay: !isDemo() && isConfigured(env),
});

// Keep a public Cloudflare tunnel up the whole time (not just for setup): it's
// the address the phone uses for sign-in AND the one the Jam QR points at, so
// scanners can reach it from anywhere — not only the TV's local network. The TV
// itself stays a plain web client on localhost. Set TUNNEL=false to disable
// (then the QR falls back to the LAN address, same-Wi-Fi only).
function ensureTunnel() {
  if (tunnelEnabled() && !isDemo() && tunnelState().status === 'off') {
    startTunnel(PORT); // fire and forget; /api/state picks the URL up when ready
  }
}
// The public base URL scanners/phones use: the tunnel when it's up, else LAN.
const publicBase = () =>
  tunnelState().status === 'up' ? tunnelState().url : `http://${lanIp()}:${PORT}`;

// ── QR cache (jam link + setup link both go through here) ──
const qrCache = new Map();
async function qrFor(url) {
  if (!url) return null;
  if (qrCache.has(url)) return qrCache.get(url);
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 520,
    color: { dark: '#0a0a0aff', light: '#ffffffff' },
  });
  if (qrCache.size > 8) qrCache.delete(qrCache.keys().next().value);
  qrCache.set(url, dataUrl);
  return dataUrl;
}

let httpsUp = false;
// Best available setup origin: public tunnel > self-signed LAN https > LAN http.
const setupOrigin = () => {
  const t = tunnelState();
  if (t.status === 'up') return t.url;
  if (httpsUp) return `https://${lanIp()}:${HTTPS_PORT}`;
  return `http://${lanIp()}:${PORT}`;
};

// ─────────────────────────────────────────────────────────────
//  TV state
// ─────────────────────────────────────────────────────────────
app.get('/api/state', async (_req, res) => {
  try {
    const weatherP = getWeather(env);
    ensureTunnel(); // keep the public tunnel up (for setup AND the Jam QR)

    // Not signed in yet (and not demo) -> tell the TV to show the setup screen.
    if (!isDemo() && !isConfigured(env)) {
      // While the public link is still being provisioned, tell the TV to show
      // a "preparing" message instead of a QR that would change seconds later.
      const pending = tunnelEnabled() && tunnelState().status === 'starting';
      const url = pending ? null : `${setupOrigin()}/setup`;
      res.json({
        ok: true,
        needsSetup: true,
        setup: { url, qr: await qrFor(url), pending },
        weather: await weatherP,
        config: clientConfig(),
      });
      return;
    }

    const [state, weather] = await Promise.all([
      isDemo() ? Promise.resolve(demoState()) : getState(env),
      weatherP,
    ]);
    // The QR points at our /j redirect on the PUBLIC base (Cloudflare tunnel when
    // up, else LAN) so scanning it starts playback on the TV and forwards into
    // the live Jam — reachable from anywhere, not just the TV's Wi-Fi. Only shown
    // once a Jam exists.
    const scanUrl = state.jam.joinUrl ? `${publicBase()}/j` : null;
    const qr = await qrFor(scanUrl);
    kickJamPlayback(state); // play only while a guest is in the Jam (fire-and-forget)
    res.json({
      ok: true,
      needsSetup: false,
      ...state,
      jam: { ...state.jam, qr },
      weather,
      config: clientConfig(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────────────────────────────────────────────────
//  Web Playback SDK support (the TV becomes a Spotify Connect device)
// ─────────────────────────────────────────────────────────────

// Short-lived access token for the Web Playback SDK running in the TV page.
// Same trust boundary as the dashboard itself (a LAN app); the token carries
// the streaming/playback scopes so keep this server on a trusted network.
app.get('/api/token', async (_req, res) => {
  if (isDemo() || !webPlayerEnabled()) return res.status(404).json({ ok: false });
  try {
    const accessToken = await getAccessToken(env);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, accessToken });
  } catch (e) {
    res.status(401).json({ ok: false, error: e.message });
  }
});

// The TV page reports its SDK device id here so the server can attach the Jam
// to the exact device that's playing (current_or_new?local_device_id=…).
app.post('/api/player/device', (req, res) => {
  const { deviceId } = req.body || {};
  setWebDeviceId(deviceId ? String(deviceId) : null);
  res.json({ ok: true });
});

// Hand playback to a device (the TV's SDK device) and start it. Called once
// the SDK reports ready, so the TV actually produces sound and — because it's
// now the active device — the Jam can auto-create against it.
app.put('/api/player/transfer', async (req, res) => {
  if (isDemo() || !webPlayerEnabled()) return res.status(404).json({ ok: false });
  const { deviceId, play = true } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });
  try {
    const tok = await getAccessToken(env);
    const r = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [deviceId], play: !!play }),
    });
    // 202/204 = accepted; 404 = no active playback context to resume (that's ok)
    res.json({ ok: r.ok || r.status === 404, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// A Jam plays through its host; if the host (this TV) isn't playing, guests see
// "waiting for host to start playback". JAM_AUTOSTART controls whether we play
// on boot (default off — see the /j redirect, which starts playback on scan);
// JAM_DEFAULT_URI sets what plays. Playing needs Spotify Premium, and gesture-
// free start needs the kiosk flag (start.bat provides it).
const jamAutostart = () => String(env.JAM_AUTOSTART ?? 'false').toLowerCase() === 'true';
const jamDefaultUri = () => env.JAM_DEFAULT_URI || 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';

// Make the TV the active device and (when forced, or JAM_AUTOSTART is on) start
// a default context if nothing is loaded. Returns a short status string.
async function ensurePlaying(deviceId, { force = false } = {}) {
  if (!deviceId) return 'no-device';
  const tok = await getAccessToken(env);
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  // 1) Hand playback to the TV, resuming whatever context exists.
  await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT', headers: H, body: JSON.stringify({ device_ids: [deviceId], play: true }),
  });
  // 2) Start a default only if asked (scan / manual play / JAM_AUTOSTART) and
  //    nothing is already loaded — never clobbers an existing track.
  if (!force && !jamAutostart()) return 'resumed';
  await new Promise((r) => setTimeout(r, 1200)); // let the transfer settle
  const cur = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { Authorization: `Bearer ${tok}` } });
  let hasTrack = false;
  if (cur.status === 200) { const j = await cur.json().catch(() => null); hasTrack = !!j?.item; }
  if (hasTrack) return 'resumed';
  const pr = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    { method: 'PUT', headers: H, body: JSON.stringify({ context_uri: jamDefaultUri() }) }
  );
  return pr.ok ? 'default' : `default-failed-${pr.status}`;
}

// ── Jam-driven playback ──────────────────────────────────────
// Music plays only while someone ELSE is in the Jam. On each poll we look at the
// members: a non-owner present -> start playing on the Pi's player (librespot,
// matched by name) / the web player; nobody left -> pause what we started.
const autoPlayOnGuest = () => String(env.JAM_PLAY_ON_GUEST ?? 'true').toLowerCase() !== 'false';
let jamAuto = { started: false, deviceId: null, devTs: 0 };

// The device to play through: the browser Web Playback SDK if present, else the
// Spotify Connect device whose name matches WEBPLAYER_NAME (that's librespot on
// the Pi). Cached briefly to avoid hammering the devices endpoint.
async function resolvePlaybackDevice() {
  const sdk = getWebDeviceId();
  if (sdk) return sdk;
  if (jamAuto.deviceId && Date.now() - jamAuto.devTs < 10_000) return jamAuto.deviceId;
  try {
    const tok = await getAccessToken(env);
    const r = await fetch('https://api.spotify.com/v1/me/player/devices', { headers: { Authorization: `Bearer ${tok}` } });
    if (r.ok) {
      const j = await r.json();
      const want = (env.WEBPLAYER_NAME || 'TV Jam').toLowerCase();
      const dev = (j.devices || []).find((d) => (d.name || '').toLowerCase() === want)
               || (j.devices || []).find((d) => d.is_active);
      jamAuto.deviceId = dev?.id || null;
      jamAuto.devTs = Date.now();
      return jamAuto.deviceId;
    }
  } catch { /* offline / not allowlisted */ }
  return null;
}

async function pausePlayback() {
  try {
    const tok = await getAccessToken(env);
    await fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers: { Authorization: `Bearer ${tok}` } });
  } catch { /* nothing to pause */ }
}

// What's the account's active device actually doing right now?
async function playerStatus() {
  try {
    const tok = await getAccessToken(env);
    const r = await fetch('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 204) return { playing: false, deviceId: null };
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return { playing: !!j?.is_playing, deviceId: j?.device?.id || null };
  } catch { return null; }
}

// Idle unless a guest is in the Jam. Guest present -> the Pi's player is playing;
// nobody but the owner -> the Pi is paused (idle). Scoped to the Pi's own device
// so it never touches music playing on your phone/other speakers.
async function manageJamPlayback(state) {
  if (isDemo() || !autoPlayOnGuest()) return;
  const guests = (state.jam?.members || []).filter((m) => !m.isOwner).length;

  if (guests > 0) {
    const dev = await resolvePlaybackDevice();
    if (!dev) return;
    const ps = await playerStatus();
    const piPlaying = ps && ps.playing && ps.deviceId === dev;
    if (!piPlaying) { await ensurePlaying(dev, { force: true }); jamAuto.started = true; }
    return;
  }

  // No guests -> enforce idle. Only act if something is actually playing.
  if (!state.isPlaying) { jamAuto.started = false; return; }
  const dev = await resolvePlaybackDevice();
  const ps = await playerStatus();
  const piPlaying = ps && ps.playing && dev && ps.deviceId === dev;
  if (piPlaying || jamAuto.started) {    // the Pi (jam host) is playing -> stop it
    await pausePlayback();
    jamAuto.started = false;
  }
}
let jamMgmtBusy = false;
function kickJamPlayback(state) {
  if (jamMgmtBusy) return;               // single-flight across overlapping polls
  jamMgmtBusy = true;
  manageJamPlayback(state).catch(() => {}).finally(() => { jamMgmtBusy = false; });
}

app.put('/api/player/ensure', async (req, res) => {
  if (isDemo() || !webPlayerEnabled()) return res.status(404).json({ ok: false });
  const { deviceId, force } = req.body || {};
  if (!deviceId) return res.status(400).json({ ok: false, error: 'deviceId required' });
  try {
    const started = await ensurePlaying(deviceId, { force: !!force });
    res.json({ ok: true, started });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Set the TV/active-device volume from the dashboard (Web API fallback; the TV
// page controls its own SDK volume directly for instant response).
app.put('/api/player/volume', async (req, res) => {
  if (isDemo() || !webPlayerEnabled()) return res.status(404).json({ ok: false });
  const pct = Math.max(0, Math.min(100, Math.round(Number(req.query.percent ?? req.body?.percent))));
  if (Number.isNaN(pct)) return res.status(400).json({ ok: false, error: 'percent required' });
  try {
    const tok = await getAccessToken(env);
    const r = await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${pct}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${tok}` },
    });
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Scan target for the Jam QR: kick off playback on the TV (so the Jam has a
// host), then forward the phone straight into the Jam. This is how the QR
// "starts playing" without auto-playing on boot.
// Scan target for the Jam QR: forward the phone straight into the live Jam.
// Playback is NOT started here — the server starts it once the scanner actually
// shows up as a member (see manageJamPlayback), so music only plays with guests.
// Touch controls on the TV: act on whatever device is playing via the Web API.
app.post('/api/player/control/:action', async (req, res) => {
  const map = {
    play: ['PUT', '/me/player/play'],
    pause: ['PUT', '/me/player/pause'],
    next: ['POST', '/me/player/next'],
    previous: ['POST', '/me/player/previous'],
  };
  const m = map[req.params.action];
  if (!m) return res.status(400).json({ ok: false, error: 'bad action' });
  try {
    const tok = await getAccessToken(env);
    const r = await fetch(`https://api.spotify.com/v1${m[1]}`, {
      method: m[0], headers: { Authorization: `Bearer ${tok}` },
    });
    res.json({ ok: r.ok || r.status === 204, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/j', async (_req, res) => {
  let url = currentJoinUrl();
  if (!url) { try { url = (await getState(env)).jam?.joinUrl; } catch {} }
  res.redirect(url || 'https://open.spotify.com');
});

// ─────────────────────────────────────────────────────────────
//  Setup OTP gate — because the tunnel makes /setup publicly reachable, any
//  *change* requires a one-time code that is shown ONLY on the TV screen (so you
//  must physically see the TV to make changes). Requests coming straight from
//  the TV itself (loopback) are trusted and skip the code.
// ─────────────────────────────────────────────────────────────
const setupGate = { otp: null, otpExp: 0, tokens: new Map() };
const OTP_TTL = 5 * 60_000;       // code is valid for 5 min after it's shown
const SESSION_TTL = 30 * 60_000;  // once entered, changes stay unlocked 30 min

// Direct request from the TV/host itself (not forwarded by the tunnel).
function isLoopback(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
function beginOtp() {
  setupGate.otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  setupGate.otpExp = Date.now() + OTP_TTL;
  return setupGate.otpExp;
}
function verifyOtp(code) {
  if (!setupGate.otp || Date.now() > setupGate.otpExp) return null;
  if (String(code || '').trim() !== setupGate.otp) return null;
  setupGate.otp = null;                                   // single use
  const token = crypto.randomBytes(24).toString('hex');
  setupGate.tokens.set(token, Date.now() + SESSION_TTL);
  return token;
}
function tokenValid(token) {
  const exp = token && setupGate.tokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { setupGate.tokens.delete(token); return false; }
  return true;
}
function setupUnlocked(req) {
  return isLoopback(req) || tokenValid(req.headers['x-setup-token']);
}
function requireSetupAuth(req, res, next) {
  if (setupUnlocked(req)) return next();
  res.status(401).json({ ok: false, error: 'setup-locked', needOtp: true });
}

// Phone opens /setup -> it calls this to make a fresh code appear on the TV.
app.post('/api/setup/otp/begin', (_req, res) => res.json({ ok: true, expiresAt: beginOtp() }));
// Phone submits the code it read off the TV -> gets an unlock token.
app.post('/api/setup/otp/verify', (req, res) => {
  const token = verifyOtp((req.body || {}).code);
  if (!token) return res.status(401).json({ ok: false, error: 'Wrong or expired code — check the TV.' });
  res.json({ ok: true, token });
});
// TV-ONLY: the dashboard (on loopback) reads the active code to display it. The
// public tunnel gets nothing, so the code can't be grabbed remotely.
app.get('/api/tv/otp', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false });
  const active = setupGate.otp && Date.now() < setupGate.otpExp;
  res.json({ ok: true, otp: active ? setupGate.otp : null });
});

// ─────────────────────────────────────────────────────────────
//  Setup flow (phone-friendly)
// ─────────────────────────────────────────────────────────────
app.get('/setup', (_req, res) => res.sendFile(join(__dirname, 'public', 'setup.html')));

app.get('/api/setup/status', async (req, res) => {
  const c = getCreds(env);
  const configured = isConfigured(env);
  const t = tunnelState();

  // The exact redirect URIs to whitelist in the Spotify developer dashboard,
  // best option first. The tunnel one is what the phone flow actually uses.
  const redirectUris = [];
  if (t.status === 'up') redirectUris.push(`${t.url}/callback`);
  if (httpsUp) redirectUris.push(`https://${lanIp()}:${HTTPS_PORT}/callback`);
  redirectUris.push(`http://127.0.0.1:${PORT}/callback`);

  res.json({
    ok: true,
    configured,
    demo: isDemo(),
    hasClientId: !!c.clientId,
    hasClientSecret: !!c.clientSecret,
    hasSpDc: !!c.spDc,
    clientIdPreview: c.clientId ? c.clientId.slice(0, 6) + '…' : null,
    profile: configured ? await getProfile(env) : null,
    redirectUris,
    origin: `${req.protocol}://${req.get('host')}`,
    httpsUp,
    tunnel: t,
    locked: !setupUnlocked(req), // client must enter the TV code before changes
  });
});

app.post('/api/setup/creds', requireSetupAuth, (req, res) => {
  const { clientId, clientSecret, spDc } = req.body || {};
  const patch = {};
  if (clientId !== undefined) patch.clientId = String(clientId).trim();
  if (clientSecret !== undefined) patch.clientSecret = String(clientSecret).trim();
  if (spDc !== undefined) patch.spDc = String(spDc).trim();
  saveStore(patch);
  res.json({ ok: true });
});

app.post('/api/setup/disconnect', requireSetupAuth, (_req, res) => {
  disconnect();
  res.json({ ok: true });
});

// ── Remote sign-in: phone drives a real Spotify login running on the PC, so
//    reCAPTCHA passes (real domain) and we read sp_dc straight off that browser.
app.get('/remote', (_req, res) => res.sendFile(join(__dirname, 'public', 'remote.html')));

app.post('/api/remote/start', requireSetupAuth, async (_req, res) => {
  if (isDemo()) return res.status(404).json({ ok: false });
  if (!getCreds(env).clientId) {
    return res.status(400).json({ ok: false, error: 'Save your Client ID first (step 1).' });
  }
  try {
    // Build the authorize URL with a STATIC loopback redirect URI
    // (http://127.0.0.1:PORT/callback) and launch the PC browser DIRECTLY on
    // accounts.spotify.com — same-site through the interactive sign-in, so the
    // screen-share stays alive. The redirect URI never changes between restarts,
    // and the same sign-in also yields sp_dc for Jam.
    const authUrl = createLoginUrl(env, `http://127.0.0.1:${PORT}`);
    await startRemote({
      startUrl: authUrl,
      onCapture: (spDc) => saveStore({ spDc }),
      isOauthDone: () => isConfigured(env),
      wantSpDc: !getCreds(env).spDc,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Latest screen frame as a raw JPEG (tunnel-proof polling; no SSE buffering).
app.get('/api/remote/frame', (_req, res) => {
  const b64 = getFrame();
  if (!b64) return res.status(204).end();
  res.set('Cache-Control', 'no-store').type('jpeg').send(Buffer.from(b64, 'base64'));
});

app.post('/api/remote/input', async (req, res) => {
  await sendInput(req.body || {});
  res.json({ ok: true });
});

app.get('/api/remote/status', (_req, res) => res.json(remoteState()));
app.post('/api/remote/stop', async (_req, res) => { await stopRemote(); res.json({ ok: true }); });

// Kick off the OAuth dance. The redirect URI is derived from whatever origin
// the user opened the page on (phone https / desktop 127.0.0.1) so the
// round-trip always comes back to the right listener.
// Spotify rejects "localhost" redirect URIs (only the literal loopback IP is
// allowed over http), so normalize it — the kiosk browses http://localhost.
app.get('/login', (req, res) => {
  try {
    const origin = `${req.protocol}://${req.get('host')}`
      .replace(/^http:\/\/localhost(?=[:/]|$)/i, 'http://127.0.0.1');
    res.redirect(createLoginUrl(env, origin));
  } catch (e) {
    res.redirect('/setup?error=' + encodeURIComponent(e.message));
  }
});

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/setup?error=' + encodeURIComponent(String(error)));
  try {
    await exchangeCode(env, { code: String(code), state: String(state) });
    res.redirect('/setup?done=1');
  } catch (e) {
    res.redirect('/setup?error=' + encodeURIComponent(e.message));
  }
});

// ─────────────────────────────────────────────────────────────
//  Listeners: HTTP for the TV, self-signed HTTPS for phone OAuth
// ─────────────────────────────────────────────────────────────
// Record our PID so stop.bat / stop.sh can end exactly this server on any OS.
const PID_FILE = join(__dirname, '.data', 'server.pid');
try { mkdirSync(join(__dirname, '.data'), { recursive: true }); writeFileSync(PID_FILE, String(process.pid)); } catch {}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { rmSync(PID_FILE, { force: true }); } catch {}; process.exit(0); });
}

app.listen(PORT, async () => {
  console.log(`\n  🎧  spotify-tv-jam running`);
  console.log(`      TV view:     http://localhost:${PORT}   (kiosk / full-screen this)`);

  try {
    const tls = await getTls();
    await new Promise((resolve, reject) => {
      https.createServer(tls, app).listen(HTTPS_PORT, resolve).on('error', reject);
    });
    httpsUp = true;
    console.log(`      Setup page:  https://${lanIp()}:${HTTPS_PORT}/setup   (phone sign-in)`);
  } catch (e) {
    console.warn(`  ⚠  HTTPS listener failed (${e.message}) — phone sign-in falls back to`);
    console.warn(`      http://127.0.0.1:${PORT}/setup on this computer.`);
  }

  if (isDemo()) {
    console.log('      DEMO mode is on — showing fake data. Set DEMO=false for the real thing.');
  } else if (!isConfigured(env)) {
    console.log('      Not signed in yet — the TV will show a "Scan to set up" QR code.');
  } else if (!getCreds(env).spDc) {
    console.log('  ⚠  sp_dc not set — Jam QR/contributors disabled (optional, see /setup).');
  }

  // Keep a public tunnel up the whole session — it's the address the Jam QR uses
  // so phones can scan it from anywhere (not just the local network).
  if (tunnelEnabled() && !isDemo()) {
    console.log('      Opening a public Cloudflare tunnel (used for setup + the Jam QR)…');
    ensureTunnel();
  }
  console.log('');

  // Pre-warm the Jam web token so the first dashboard poll isn't slow (it mints
  // via a brief background browser). Best-effort.
  if (!isDemo() && getCreds(env).spDc) prewarmWebToken().catch(() => {});
});
