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

const state = { url: null, status: 'off', error: null };
// status: 'off' | 'starting' | 'up' | 'error'

let tunnelInstance = null;

export const tunnelState = () => ({ url: state.url, status: state.status, error: state.error });

/**
 * Start a reverse tunnel via localtunnel over port 443 (HTTP/HTTPS, non-SSH).
 * Resolves with the public https URL, or null on failure.
 */
export async function startTunnel(port) {
  if (state.status === 'up') return state.url;
  if (state.status === 'starting' || state.status === 'error') return null;
  state.status = 'starting';
  state.error = null;

  const timeoutMs = 10_000; // 10s timeout ensures TV never hangs on "preparing setup link"

  return new Promise(async (resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.status = 'error';
      state.error = 'timed out waiting for localtunnel';
      console.warn('  ⚠  localtunnel connection timed out, falling back to local network');
      try { tunnelInstance?.close(); } catch {}
      tunnelInstance = null;
      resolve(null);
    }, timeoutMs);

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
      if (settled) {
        try { tunnel.close(); } catch {}
        return;
      }

      settled = true;
      clearTimeout(timer);
      tunnelInstance = tunnel;
      state.url = tunnel.url;
      state.status = 'up';
      console.log(`      Public setup link: ${state.url}/setup (via localtunnel:443, no SSH)`);

      tunnel.on('error', (err) => {
        console.warn(`  ⚠  localtunnel error: ${err.message}`);
        if (tunnelInstance === tunnel) {
          state.error = err.message;
          state.status = 'off';
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

      resolve(state.url);
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.status = 'error';
      state.error = err.message;
      console.warn(`  ⚠  localtunnel failed to start: ${err.message}`);
      resolve(null);
    }
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
