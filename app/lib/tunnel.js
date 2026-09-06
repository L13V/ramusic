// lib/tunnel.js
// localtunnel HTTPS reverse tunnel for the setup flow and Jam QR code.
//
// Why: Spotify requires OAuth redirect URIs to be HTTPS. localtunnel provides
// a public HTTPS URL on port 443 (e.g. https://<subdomain>.loca.lt) via pure
// HTTP/HTTPS & WebSockets.
//
// Protocol: Uses HTTP/HTTPS over port 443 — DOES NOT use SSH (port 22). This allows
// tunneling through firewalls, proxies, and networks where outbound SSH is blocked.

import localtunnel from 'localtunnel';

const state = {
  url: null,
  status: 'off',   // 'off' | 'starting' | 'up' | 'error'
  error: null,
  since: 0,        // when the current attempt started (setup screen waits on this)
  attempts: 0,     // consecutive failures, drives the retry backoff
  retryAt: 0,      // don't re-attempt before this
};

let tunnelInstance = null;
let inFlight = false;

export const tunnelState = () => ({ ...state });

// A failed attempt must never be terminal: the Pi often boots before the network
// is usable, and loca.lt itself has slow spells. Back off linearly, cap at 2 min,
// so /api/state's ensureTunnel() keeps trying for the whole session.
const backoffMs = () => Math.min(15_000 * state.attempts, 120_000);

/** True while it's still worth showing "preparing your link…" instead of the LAN URL. */
export const tunnelPending = () =>
  state.status === 'starting' ||
  (state.status !== 'up' && state.since > 0 && Date.now() - state.since < 30_000);

function adopt(tunnel) {
  if (tunnelInstance && tunnelInstance !== tunnel) {
    try { tunnelInstance.close(); } catch {}
  }
  tunnelInstance = tunnel;
  state.url = tunnel.url;
  state.status = 'up';
  state.error = null;
  state.attempts = 0;
  state.retryAt = 0;
  console.log(`      Public link: ${state.url} (setup + Jam QR, via localtunnel:443, no SSH)`);

  tunnel.on('error', (err) => {
    console.warn(`  ⚠  localtunnel error: ${err.message}`);
    if (tunnelInstance === tunnel) {
      state.error = err.message;
      state.status = 'off';   // 'off' => ensureTunnel() reconnects on the next poll
      state.url = null;
      tunnelInstance = null;
    }
  });

  tunnel.on('close', () => {
    if (tunnelInstance === tunnel) {
      state.status = 'off';
      state.url = null;
      tunnelInstance = null;
    }
  });
}

/**
 * Start a reverse tunnel via localtunnel over port 443 (HTTP/HTTPS, non-SSH).
 * Resolves with the public https URL, or null if it isn't up yet. Safe to call
 * on every poll — it self-throttles and retries after a failure.
 */
export async function startTunnel(port) {
  if (state.status === 'up') return state.url;
  if (inFlight) return null;
  if (state.status === 'error' && Date.now() < state.retryAt) return null;

  inFlight = true;
  state.status = 'starting';
  state.error = null;
  state.since = Date.now();
  state.attempts += 1;

  // localtunnel's handshake regularly needs >10s on a cold Pi; the old 10s cap
  // was the main reason the public link never appeared for the setup screen.
  const timeoutMs = Number(process.env.TUNNEL_TIMEOUT_MS) || 25_000;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    // Report "not up yet" so callers fall back to the LAN address — but DON'T
    // kill the attempt. If it lands late, adopt() still promotes it and the next
    // /api/state poll swaps the QR over to the public link.
    const timer = setTimeout(() => {
      state.status = 'error';
      state.error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      state.retryAt = Date.now() + backoffMs();
      console.warn('  ⚠  localtunnel is slow to connect — using the local network for now, still trying');
      finish(null);
    }, timeoutMs);

    (async () => {
      try {
        const opts = {
          port: Number(port) || 3000,
          // Crucial: localtunnel defaults internally to localtunnel.me which is dead/unresponsive.
          // We target https://loca.lt directly.
          host: process.env.LOCALTUNNEL_HOST || 'https://loca.lt',
        };
        if (process.env.LOCALTUNNEL_SUBDOMAIN) {
          opts.subdomain = process.env.LOCALTUNNEL_SUBDOMAIN;
        }

        const tunnel = await localtunnel(opts);
        clearTimeout(timer);
        adopt(tunnel);
        finish(state.url);
      } catch (err) {
        clearTimeout(timer);
        state.status = 'error';
        state.error = err.message;
        state.retryAt = Date.now() + backoffMs();
        console.warn(`  ⚠  localtunnel failed to start: ${err.message} (retrying in ${Math.round(backoffMs() / 1000)}s)`);
        finish(null);
      } finally {
        inFlight = false;
      }
    })();
  });
}

export function stopTunnel() {
  try {
    tunnelInstance?.close();
  } catch {}
  tunnelInstance = null;
  state.url = null;
  state.status = 'off';
  state.error = null;
  state.since = 0;
  state.attempts = 0;
  state.retryAt = 0;
}

// Clean up tunnel on process exit
process.on('exit', () => {
  try { tunnelInstance?.close(); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopTunnel();
    process.exit(0);
  });
}
