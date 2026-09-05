// lib/tunnel.js
// localhost.run SSH reverse tunnel for the setup flow and Jam QR code.
//
// Why: Spotify requires OAuth redirect URIs to be HTTPS. localhost.run provides
// an instant, zero-dependency public HTTPS URL on port 443 (e.g. https://<id>.lhr.life)
// via standard OpenSSH reverse port forwarding. Traffic arriving on port 443 at
// localhost.run's edge has TLS terminated and is forwarded over SSH to the local
// HTTP port (default 3000).
//
// Zero external binaries: uses standard OpenSSH client pre-installed on Linux,
// macOS, and Windows. No ~40 MB cloudflared binary downloads needed.

import { spawn, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data');

const state = { url: null, status: 'off', error: null, proc: null };
// status: 'off' | 'starting' | 'up' | 'error'

export const tunnelState = () => ({ url: state.url, status: state.status, error: state.error });

/**
 * Remove any legacy cloudflared binary downloads from .data to free disk space.
 */
function cleanLegacyBinaries() {
  try {
    for (const f of ['cloudflared', 'cloudflared.exe', 'cloudflared.part']) {
      const p = join(DATA_DIR, f);
      if (existsSync(p)) rmSync(p, { force: true });
    }
  } catch {}
}

/**
 * Verify OpenSSH client is available on PATH.
 */
function ensureSsh() {
  const chk = spawnSync('ssh', ['-V'], { stdio: 'ignore', windowsHide: true });
  if (chk.error || chk.status !== 0) {
    throw new Error('OpenSSH client (ssh) is not installed or not found on PATH');
  }
}

/**
 * Start a reverse SSH tunnel via localhost.run to forward public port 443 (HTTPS)
 * to http://127.0.0.1:<port>. Resolves with the public https URL, or null on failure.
 */
export async function startTunnel(port) {
  if (state.status === 'up') return state.url;
  if (state.status === 'starting' || state.status === 'error') return null;
  state.status = 'starting';
  state.error = null;

  try {
    ensureSsh();
    cleanLegacyBinaries();
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    console.warn(`  ⚠  tunnel unavailable: ${e.message}`);
    return null;
  }

  const knownHosts = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const sshUser = process.env.LOCALHOST_RUN_USER || 'nokey';
  const sshHost = process.env.LOCALHOST_RUN_HOST || 'localhost.run';
  const targetHost = sshUser ? `${sshUser}@${sshHost}` : sshHost;

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-R', `80:localhost:${port}`,
    targetHost,
    '--',
    '--output', 'json'
  ];

  if (process.env.LOCALHOST_RUN_KEY) {
    args.unshift('-i', process.env.LOCALHOST_RUN_KEY);
  }

  return new Promise((resolve) => {
    const proc = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.proc = proc;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.status = 'error';
      state.error = 'timed out waiting for the localhost.run tunnel URL';
      try { proc.kill(); } catch {}
      resolve(null);
    }, 45_000);

    const parseOutput = (data) => {
      if (settled) return;
      const text = String(data);

      // 1. Try parsing JSON lines (from --output json)
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.status === 'fail' || obj.type === 'unauthorized') {
            settled = true;
            clearTimeout(timer);
            state.status = 'error';
            state.error = obj.message || 'localhost.run authorization failed';
            resolve(null);
            return;
          }
          if (obj.address && typeof obj.address === 'string' && (obj.status === 'success' || obj.event === 'tcpip-forward' || obj.type === 'opened')) {
            settled = true;
            clearTimeout(timer);
            state.url = obj.address.startsWith('http') ? obj.address : `https://${obj.address}`;
            state.status = 'up';
            console.log(`      Public setup link: ${state.url}/setup (via localhost.run:443)`);
            resolve(state.url);
            return;
          }
        } catch {
          // not JSON line, proceed to regex
        }
      }

      // 2. Fallback regex match for text output:
      // Must match assigned user tunnel (e.g. *.lhr.life or *.localhost.run),
      // ignoring localhost.run informational links (admin.localhost.run, localhost.run/docs).
      const m = text.match(/https:\/\/[a-z0-9-]+\.lhr\.life/i) ||
                text.match(/([a-z0-9-]+\.lhr\.life)\s+tunneled/i) ||
                text.match(/https:\/\/(?!admin\b|www\b|docs\b)[a-z0-9-]+\.localhost\.run/i);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        const urlStr = m[0].startsWith('http') ? m[0] : `https://${m[1]}`;
        state.url = urlStr;
        state.status = 'up';
        console.log(`      Public setup link: ${state.url}/setup (via localhost.run:443)`);
        resolve(state.url);
      }
    };

    proc.stdout.on('data', parseOutput);
    proc.stderr.on('data', parseOutput);

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
        state.error = `ssh exited early (code ${code})`;
        resolve(null);
      } else if (state.proc === proc) {
        // Disconnected after being up — allow a later restart
        state.proc = null;
        state.url = null;
        state.status = 'off';
      }
    });
  });
}

export function stopTunnel() {
  try { state.proc?.kill(); } catch {}
  state.proc = null;
  state.url = null;
  state.status = 'off';
  state.error = null;
}

// Don't leave orphaned ssh processes behind
process.on('exit', () => { try { state.proc?.kill(); } catch {} });
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { stopTunnel(); process.exit(0); });
}
