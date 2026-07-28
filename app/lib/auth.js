// lib/auth.js
// Server-side Spotify sign-in (Authorization Code + PKCE) so nobody ever has
// to hand-copy a refresh token again.
//
// Flow:  TV shows "Scan to set up" QR  ->  phone opens /setup on this server
//        -> taps "Sign in with Spotify" (/login) -> Spotify auth on the phone
//        -> Spotify redirects back to /callback on this server -> we exchange
//        the code for tokens and persist them in .data/auth.json. Done.
//
// Spotify requires OAuth redirect URIs to be HTTPS (or http://127.0.0.1
// loopback), so the server also listens on a self-signed HTTPS port for the
// phone flow. The cert is generated once and cached in .data/.
//
// Values entered in the setup UI are stored in .data/auth.json and take
// precedence over .env; .env acts as a seed / fallback.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '.data');
const STORE_FILE = join(DATA_DIR, 'auth.json');
const TLS_FILE = join(DATA_DIR, 'tls.json');

// Read scopes power the dashboard; streaming + modify let the TV itself act as
// a Spotify Connect device (Web Playback SDK) and control playback.
export const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'streaming',
  'user-read-email',
  'user-read-private',
].join(' ');

// ─────────────────────────────────────────────────────────────
//  Tiny JSON store  (.data/auth.json)
// ─────────────────────────────────────────────────────────────
let storeCache = null;

export function loadStore() {
  if (storeCache) return storeCache;
  try {
    storeCache = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
  } catch {
    storeCache = {};
  }
  return storeCache;
}

export function saveStore(patch) {
  const next = { ...loadStore(), ...patch };
  // Drop empty-string keys so "clearing" a field actually clears it.
  for (const k of Object.keys(next)) if (next[k] === '' || next[k] == null) delete next[k];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(next, null, 2));
  storeCache = next;
  return next;
}

/** Merged credentials: setup-UI values (store) win, .env is the fallback. */
export function getCreds(env) {
  const s = loadStore();
  return {
    clientId: s.clientId || env.SPOTIFY_CLIENT_ID || null,
    clientSecret: s.clientSecret || env.SPOTIFY_CLIENT_SECRET || null,
    refreshToken: s.refreshToken || env.SPOTIFY_REFRESH_TOKEN || null,
    spDc: s.spDc || env.SPOTIFY_SP_DC || null,
  };
}

/** True once we have everything needed to talk to the Web API. */
export function isConfigured(env) {
  const c = getCreds(env);
  return !!(c.clientId && c.refreshToken);
}

// ─────────────────────────────────────────────────────────────
//  PKCE login  (state -> verifier kept in memory, 10 min TTL)
// ─────────────────────────────────────────────────────────────
const pending = new Map();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function prunePending() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

/** Build the Spotify authorize URL for a login started from `origin`. */
export function createLoginUrl(env, origin) {
  const { clientId } = getCreds(env);
  if (!clientId) throw new Error('No Client ID saved yet — finish step 1 on the setup page.');
  prunePending();

  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const redirectUri = `${origin}/callback`;
  pending.set(state, { verifier, redirectUri, exp: Date.now() + 10 * 60_000 });

  const u = new URL('https://accounts.spotify.com/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', challenge);
  return u.toString();
}

async function tokenRequest(env, body) {
  const { clientId, clientSecret } = getCreds(env);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    // Confidential client: authenticate with the secret.
    headers.Authorization =
      'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  } else {
    // Public (PKCE-only) client: client_id goes in the body.
    body.set('client_id', clientId);
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers,
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.error_description || json.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.error;
    throw err;
  }
  return json;
}

/** /callback handler guts: exchange the code, persist tokens. */
export async function exchangeCode(env, { code, state }) {
  const entry = pending.get(state);
  if (!entry) throw new Error('Login expired or state mismatch — go back and try again.');
  pending.delete(state);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    code_verifier: entry.verifier,
  });
  const j = await tokenRequest(env, body);
  if (!j.refresh_token) throw new Error('Spotify returned no refresh token.');
  saveStore({ refreshToken: j.refresh_token, connectedAt: new Date().toISOString() });
  access = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  profileCache = null;
  return j;
}

// ─────────────────────────────────────────────────────────────
//  Access-token cache (refresh grant, rotation-safe)
// ─────────────────────────────────────────────────────────────
let access = { value: null, exp: 0 };

export async function getAccessToken(env) {
  if (access.value && Date.now() < access.exp - 30_000) return access.value;
  const { refreshToken } = getCreds(env);
  if (!refreshToken) throw new Error('not signed in');

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  let j;
  try {
    j = await tokenRequest(env, body);
  } catch (e) {
    // Revoked / invalid grant -> forget the stored token so the TV flips back
    // to the "Scan to set up" screen instead of silently showing nothing.
    if (e.code === 'invalid_grant') {
      saveStore({ refreshToken: null });
      profileCache = null;
    }
    throw e;
  }
  access = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  if (j.refresh_token) saveStore({ refreshToken: j.refresh_token }); // rotation
  return access.value;
}

/** Forget the sign-in (keeps client id/secret so re-connecting is one tap). */
export function disconnect() {
  saveStore({ refreshToken: null, connectedAt: null });
  access = { value: null, exp: 0 };
  profileCache = null;
}

// ─────────────────────────────────────────────────────────────
//  "Connected as …" for the setup UI
// ─────────────────────────────────────────────────────────────
let profileCache = null;

export async function getProfile(env) {
  if (profileCache) return profileCache;
  try {
    const tok = await getAccessToken(env);
    const r = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    // Dev-mode apps only serve users on their allowlist; otherwise 403
    // "not registered for this application". Surface that instead of a blank UI.
    if (r.status === 403) {
      const t = await r.text().catch(() => '');
      if (/not registered/i.test(t)) return { notRegistered: true }; // don't cache; may be fixed live
    }
    if (!r.ok) return null;
    const j = await r.json();
    profileCache = { name: j.display_name || j.id, image: j.images?.[0]?.url || null };
    return profileCache;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Networking helpers
// ─────────────────────────────────────────────────────────────
/** Best-guess LAN IPv4 of this machine (what the phone can reach). */
export function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) {
        return i.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Self-signed cert for the HTTPS listener (phone OAuth redirect must be
 * https). Generated once and cached so the phone only sees the certificate
 * warning the first time.
 */
export async function getTls() {
  if (existsSync(TLS_FILE)) {
    try {
      const t = JSON.parse(readFileSync(TLS_FILE, 'utf8'));
      if (t.key && t.cert) return t;
    } catch { /* regenerate below */ }
  }
  const { default: selfsigned } = await import('selfsigned');
  const ip = lanIp();
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'spotify-tv-jam' }],
    {
      days: 3650,
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },       // DNS
            { type: 7, ip: '127.0.0.1' },          // IP
            { type: 7, ip },
          ],
        },
      ],
    }
  );
  const t = { key: pems.private, cert: pems.cert };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TLS_FILE, JSON.stringify(t, null, 2));
  return t;
}
