// RAMTECH admin service — device management web UI (default port 8080).
// Independent from the jam app so it can update/restart it safely.
import http from 'node:http';
import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sys from './lib/sys.js';
import * as auth from './lib/auth.js';
import * as ota from './lib/ota.js';
import * as net from './lib/net.js';
import * as audio from './lib/audio.js';
import * as vnc from './lib/vnc.js';
import * as dns from './lib/dns.js';
import * as terminal from './lib/terminal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ADMIN_PORT || 8080);
const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use('/novnc', express.static(join(__dirname, 'node_modules', '@novnc', 'novnc')));

// Brand logo lives in the app package (sibling dir in every release).
app.get('/logo.png', (_req, res) => {
  for (const p of [
    join(__dirname, '..', 'app', 'public', 'ramtech-logo.png'),
    join(__dirname, 'public', 'ramtech-logo.png'),
  ]) if (existsSync(p)) return res.sendFile(p);
  res.status(404).end();
});

// ── Auth ─────────────────────────────────────────────────────
app.post('/api/login', (req, res) => res.json(auth.login(req, res, req.body?.password)));
app.post('/api/logout', (req, res) => { auth.logout(res); res.json({ ok: true }); });
app.get('/api/session', (req, res) =>
  res.json({ authed: auth.isAuthed(req), mustChange: auth.isAuthed(req) ? auth.mustChange() : undefined }));
app.post('/api/password', (req, res, next) => auth.requireAuth(req, res, next),
  (req, res) => res.json(auth.changePassword(req.body?.current, req.body?.next)));

// Everything below requires a session AND a password that is no longer the
// shipped default — the change is forced, so it has to actually be enforced.
app.use('/api', (req, res, next) => auth.requireAuth(req, res, next));
app.use('/api', (req, res, next) => auth.requirePasswordSet(req, res, next));

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(400).json({ ok: false, error: e?.message || String(e) }); }
};

// ── Status / services / logs ─────────────────────────────────
app.get('/api/status', wrap(() => sys.status()));
app.get('/api/services', wrap(() => sys.services()));
app.post('/api/services/:unit/:action', wrap((req) => sys.serviceAction(req.params.unit, req.params.action)));
app.get('/api/logs/:unit', wrap(async (req) => ({ ok: true, text: await sys.logs(req.params.unit, req.query.lines) })));

// ── Network ──────────────────────────────────────────────────
app.get('/api/network', wrap(() => net.info()));
app.get('/api/network/wifi/scan', wrap(() => net.wifiScan()));
app.post('/api/network/wifi/connect', wrap((req) => net.wifiConnect(req.body?.ssid, req.body?.password)));
app.post('/api/network/hostname', wrap((req) => net.setHostname(req.body?.hostname)));

// ── Updates (OTA) ────────────────────────────────────────────
app.get('/api/update/settings', wrap(() => ota.settings()));
app.post('/api/update/settings', wrap((req) => ota.saveSettings({ repo: String(req.body?.repo || '').trim() })));
app.post('/api/update/auto', wrap((req) => ota.setAutoUpdate(!!req.body?.enabled)));
app.get('/api/update/check', wrap(() => ota.check()));
app.post('/api/update/apply', wrap(() => ota.apply()));
app.post('/api/update/rollback', wrap(() => ota.rollback()));
app.get('/api/update/status', wrap(() => ota.otaStatus()));

// ── Audio ────────────────────────────────────────────────────
app.get('/api/audio', wrap(() => audio.getAudioOutputs()));
app.post('/api/audio/default', wrap((req) => audio.setDefaultAudioOutput(req.body?.sink)));
app.post('/api/audio/volume', wrap((req) => audio.setVolume(req.body?.sink, req.body?.volume)));
app.post('/api/audio/mute', wrap((req) => audio.setMute(req.body?.sink, req.body?.mute)));

// ── Remote Desktop (VNC) ─────────────────────────────────────
app.get('/api/vnc/status', wrap(() => vnc.vncStatus()));
app.post('/api/vnc/start', wrap(() => vnc.ensureVncServer()));
app.post('/api/vnc/stop', wrap(() => { vnc.stopVncServer(); return { ok: true }; }));

// ── DNS over HTTPS (DoH) ─────────────────────────────────────
app.get('/api/dns', wrap(() => dns.status()));
app.post('/api/dns', wrap((req) => dns.updateSettings(req.body)));
app.post('/api/dns/test', wrap((req) => dns.testResolution(req.body?.domain)));

// ── Console Terminal ─────────────────────────────────────────
app.post('/api/terminal/exec', wrap((req) => terminal.execCommand(req.body?.command, { timeout: req.body?.timeout })));

// ── OS packages / power ──────────────────────────────────────
app.post('/api/apt/upgrade', wrap(() => sys.startAptUpgrade()));
app.get('/api/apt/status', wrap(() => sys.jobStatus('apt') || { running: false, log: '', code: null }));
app.post('/api/power/:action', wrap((req) => sys.power(req.params.action)));

const server = http.createServer(app);
const WS_PATHS = ['/ws/vnc', '/ws/terminal'];
vnc.setupVncWebSocket(server);
terminal.setupTerminalWebSocket(server);

// Both handlers above ignore paths that aren't theirs, which is the only thing
// they can do with a sibling listening on the same event — but that left an
// upgrade to any other path connected and unanswered forever. Registered last,
// so the real handlers have already had their turn.
server.on('upgrade', (req, socket) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (WS_PATHS.includes(pathname)) return;   // handled above
  } catch { /* unparseable: close it */ }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RAMTECH admin listening on http://0.0.0.0:${PORT}${sys.MOCK ? '  [MOCK MODE]' : ''}`);
});

