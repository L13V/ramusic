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

  try {
    const opts = {
      port: Number(port) || 3000,
    };
    if (process.env.LOCALTUNNEL_SUBDOMAIN) {
      opts.subdomain = process.env.LOCALTUNNEL_SUBDOMAIN;
    }
    if (process.env.LOCALTUNNEL_HOST) {
      opts.host = process.env.LOCALTUNNEL_HOST;
    }

    const tunnel = await localtunnel(opts);
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

    return state.url;
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    console.warn(`  ⚠  localtunnel failed to start: ${err.message}`);
    return null;
  }
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
