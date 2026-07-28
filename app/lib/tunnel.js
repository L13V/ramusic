// lib/tunnel.js
// Cloudflare "quick tunnel" (trycloudflare.com) for the setup flow.
//
// Why: Spotify requires OAuth redirect URIs to be HTTPS. A quick tunnel gives
// the server a real public https URL (https://<random>.trycloudflare.com), so
// the phone sign-in works with no certificate warnings and a redirect URI the
// Spotify dashboard always accepts.
//
// Lifecycle: started only while the app still needs setting up, and shut down
// shortly after sign-in completes — the dashboard is never left exposed on a
// public URL. The URL is random per run (that's how quick tunnels work), so
// the setup page always shows the redirect URI to register *right now*.
//
// The cloudflared binary is used from PATH if installed, otherwise downloaded
// once into .data/ (official GitHub release for this platform).

import { spawn, spawnSync } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, rmSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data');

const state = { url: null, status: 'off', error: null, proc: null };
// status: 'off' | 'starting' | 'up' | 'error'

export const tunnelState = () => ({ url: state.url, status: state.status, error: state.error });

// ─────────────────────────────────────────────────────────────
//  Binary resolution: PATH first, else one-time download
// ─────────────────────────────────────────────────────────────
function assetName() {
  const p = process.platform, a = process.arch;
  if (p === 'win32') return a === 'x64' ? 'cloudflared-windows-amd64.exe' : 'cloudflared-windows-386.exe';
  if (p === 'darwin') return a === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (p === 'linux') {
    if (a === 'x64') return 'cloudflared-linux-amd64';
    if (a === 'arm64') return 'cloudflared-linux-arm64';
    return 'cloudflared-linux-arm'; // 32-bit Pi et al.
  }
  return null;
}

async function ensureBinary() {
  // Already on PATH?
  const onPath = spawnSync('cloudflared', ['--version'], { stdio: 'ignore', windowsHide: true });
  if (onPath.status === 0) return 'cloudflared';

  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = join(DATA_DIR, exe);
  if (existsSync(local)) return local;

  const name = assetName();
  if (!name) throw new Error(`no cloudflared build for ${process.platform}/${process.arch}`);

  console.log('      Downloading cloudflared (one-time, ~40 MB)…');
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`);
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);

  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = local + '.part';
  if (name.endsWith('.tgz')) {
    // macOS ships as a tarball containing a single "cloudflared" binary.
    const tgz = join(DATA_DIR, name);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tgz));
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', DATA_DIR]);
    rmSync(tgz, { force: true });
    if (tar.status !== 0) throw new Error('failed to extract cloudflared tarball');
  } else {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    renameSync(tmp, local);
  }
  if (process.platform !== 'win32') chmodSync(local, 0o755);
  console.log('      cloudflared ready.');
  return local;
}

// ─────────────────────────────────────────────────────────────
//  Start / stop
// ─────────────────────────────────────────────────────────────
/**
 * Start a quick tunnel to http://127.0.0.1:<port>. Resolves with the public
 * https URL, or null on failure (state.error explains why). Idempotent while
 * starting/up; a previous 'error' is only retried on an explicit new call
 * after reset via stopTunnel().
 */
export async function startTunnel(port) {
  if (state.status === 'up') return state.url;
  if (state.status === 'starting' || state.status === 'error') return null;
  state.status = 'starting';
  state.error = null;

  let bin;
  try {
    bin = await ensureBinary();
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    console.warn(`  ⚠  tunnel unavailable: ${e.message}`);
    return null;
  }

  return new Promise((resolve) => {
    const proc = spawn(
      bin,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    state.proc = proc;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.status = 'error';
      state.error = 'timed out waiting for the tunnel URL';
      try { proc.kill(); } catch { /* already dead */ }
      resolve(null);
    }, 60_000);

    const onData = (buf) => {
      // cloudflared prints the assigned URL (to stderr) once the tunnel is up.
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        state.url = m[0];
        state.status = 'up';
        console.log(`      Public setup link: ${m[0]}/setup`);
        resolve(m[0]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.status = 'error';
      state.error = e.message;
      resolve(null);
    });
    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        state.status = 'error';
        state.error = `cloudflared exited early (code ${code})`;
        resolve(null);
      } else if (state.proc === proc) {
        // died after being up (network blip etc.) — allow a later restart
        state.proc = null;
        state.url = null;
        state.status = 'off';
      }
    });
  });
}

export function stopTunnel() {
  try { state.proc?.kill(); } catch { /* already dead */ }
  state.proc = null;
  state.url = null;
  state.status = 'off';
  state.error = null;
}

// Don't leave orphaned cloudflared processes behind.
process.on('exit', () => { try { state.proc?.kill(); } catch { /* noop */ } });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopTunnel(); process.exit(0); });
}
