// lib/spotify.js
// Two auth surfaces:
//   1) Web API tokens (lib/auth.js) -> reliable now-playing + queue + album art.
//      Sign-in happens through the /setup flow; auth.js caches + refreshes.
//   2) sp_dc web token              -> internal "social-connect" (Jam) endpoints:
//                                      join URL for the QR + per-track contributor names
//
// The Jam endpoints are undocumented and can change. Everything Jam-related
// degrades gracefully: if it fails, now-playing/queue still work and the QR
// falls back to JAM_URL_FALLBACK.

import { getAccessToken, getCreds } from './auth.js';
import { getWebToken as mintWebToken } from './webtoken.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────
//  Web player access token
//  Spotify blocks the old sp_dc->token call with an anti-scraping (TOTP) check,
//  so we mint it the legit way: the user's own logged-in browser (the remote
//  sign-in profile) fetches it and we read it back. See lib/webtoken.js.
// ─────────────────────────────────────────────────────────────
async function getWebToken(env) {
  // The token comes from the logged-in profile; sp_dc presence is our signal
  // that the user completed the remote sign-in that populated that profile.
  if (!getCreds(env).spDc) return null;
  return mintWebToken();
}

// ─────────────────────────────────────────────────────────────
//  Web API helpers
// ─────────────────────────────────────────────────────────────
async function api(env, path) {
  const tok = await getAccessToken(env);
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (res.status === 204) return null;          // nothing playing
  if (res.status === 429) return null;          // rate-limited, skip this tick
  if (!res.ok) throw new Error(`api ${path} ${res.status}`);
  return res.json();
}

function trackShape(t) {
  if (!t) return null;
  const imgs = t.album?.images || [];
  return {
    id: t.id,
    name: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    image: imgs[0]?.url || null,
    durationMs: t.duration_ms || 0,
    uri: t.uri,
  };
}

// ─────────────────────────────────────────────────────────────
//  Jam session (social-connect). Best-effort.
//  Returns { joinUrl, members:[{name,image}], contributors:{uri->name} }
//
//  Auto-create: instead of only *reading* the current session (which forces
//  someone to start a Jam from the phone app), we hit the same endpoint the
//  web player uses to open the Jam UI — current_or_new?activate=true — which
//  creates and activates a session on the fly when there's an active device.
//  If creation isn't possible (nothing playing, endpoint changed), we fall
//  back to reading whatever session exists, then back off for a bit so the
//  5-second poll doesn't hammer Spotify with doomed requests.
// ─────────────────────────────────────────────────────────────
// "Sticky" Jam: once a session exists, keep serving its join URL for a while
// even if a poll briefly can't see it (pause, device handoff, endpoint blip),
// so the QR stays ready instead of flickering back to "no active Jam".
// Members/contributors ride along in the sticky cache: a transient lookup blip
// must NOT report "0 guests" (that pauses the music and flips the TV to idle).
let lastJam = { joinUrl: null, seen: 0, members: [], contributors: {} };
let jamIdleUntil = 0;
const JAM_STICKY_MS = 10 * 60_000;
const JAM_IDLE_MS = 12_000; // when idle, don't refire create more often than this

// The Web Playback SDK device id, reported by the TV page. Attaching the Jam
// to the actual playing device is what makes current_or_new create a session.
let webDeviceId = null;
export function setWebDeviceId(id) { webDeviceId = id || null; }
export function getWebDeviceId() { return webDeviceId; }
/** The current Jam join link (fast, cached) for the /j redirect. */
export function currentJoinUrl() { return lastJam.joinUrl; }

function pickJoinUrl(session) {
  // Build the PUBLIC, camera-scannable link. Spotify also hands back internal
  // forms a phone camera can't open — join_session_url is `hm://…` (Hermes) and
  // join_session_uri is `spotify:socialsession:…` — so never use those directly.
  // The web link `https://open.spotify.com/socialsession/<token>` redirects into
  // the Spotify app (via spotify.app.link), which is what real Jam QRs do.
  const fromUri =
    typeof session.join_session_uri === 'string' && session.join_session_uri.startsWith('spotify:socialsession:')
      ? session.join_session_uri.split(':').pop() : null;
  const fromHm =
    typeof session.join_session_url === 'string' && session.join_session_url.includes('/sessions/join/')
      ? session.join_session_url.split('/').pop() : null;
  const token = session.join_session_token || fromUri || fromHm || session.session_id;
  // The share params matter: ssp=1 (+ share utm) is what makes the socialsession
  // page hand off into the app-link chain (open.spotify.com -> spotify.app.link
  // -> Spotify app) on iPhones. A bare /socialsession/<token> can dead-end in
  // Safari. Format captured from a real "share Jam" link.
  if (token) return `https://open.spotify.com/socialsession/${token}?utm_source=share-options-sheet&utm_medium=share-link&ssp=1`;

  // Only fall back to links that are already public http(s).
  for (const u of [session.join_session_url, session.join_url, session.session_url]) {
    if (typeof u === 'string' && /^https?:\/\//.test(u)) return u;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  Who-queued-what. The session object stopped carrying queue data; the web
//  player now reads it from the connect-state player state, which requires a
//  dealer-websocket connection id. We keep one dealer socket alive (with pings)
//  and PUT a hidden observer device each poll to read next_tracks[].metadata
//  .queued_by (a username — mapped to a display name via session_members).
// ─────────────────────────────────────────────────────────────
const SPCLIENT = 'https://spclient.wg.spotify.com';
let dWs = null, dConnId = null, dTok = null, dOpening = null, dPing = null;

function dealerClose() {
  try { clearInterval(dPing); } catch {}
  try { dWs?.close(); } catch {}
  dWs = null; dConnId = null; dTok = null; dPing = null;
}

function dealerConnId(tok) {
  if (dConnId && dWs?.readyState === 1 && dTok === tok) return Promise.resolve(dConnId);
  if (dOpening) return dOpening;
  dealerClose();
  dOpening = new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(`wss://dealer.spotify.com/?access_token=${encodeURIComponent(tok)}`); }
    catch { return resolve(null); }
    const to = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 10_000);
    ws.onmessage = (ev) => {
      try {
        const id = JSON.parse(ev.data)?.headers?.['Spotify-Connection-Id'];
        if (id) {
          clearTimeout(to);
          dWs = ws; dConnId = id; dTok = tok;
          // The dealer drops idle sockets — ping every 30s to keep it alive.
          dPing = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 30_000);
          resolve(id);
        }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(to); resolve(null); };
    ws.onclose = () => { if (dWs === ws) { clearInterval(dPing); dWs = null; dConnId = null; dTok = null; } };
  }).finally(() => { dOpening = null; });
  return dOpening;
}

async function fetchQueuedBy(tok) {
  const put = async (connId) => fetch(`${SPCLIENT}/connect-state/v1/devices/hobs_ramtechtvobserver`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${tok}`, 'User-Agent': UA, Accept: 'application/json',
      'Content-Type': 'application/json', 'x-spotify-connection-id': connId,
    },
    body: JSON.stringify({
      member_type: 'CONNECT_STATE',
      device: { device_info: { capabilities: { can_be_player: false, hidden: true, needs_full_player_state: true } } },
    }),
  });
  try {
    let connId = await dealerConnId(tok);
    if (!connId) return null;
    let r = await put(connId);
    if (!r.ok) { // stale connection id — reopen once
      dealerClose();
      connId = await dealerConnId(tok);
      if (!connId) return null;
      r = await put(connId);
      if (!r.ok) return null;
    }
    const ps = (await r.json())?.player_state || {};
    const out = {};
    const grab = (t) => { const who = t?.metadata?.queued_by; if (t?.uri && who) out[t.uri] = who; };
    grab(ps.track);                                  // the queued song now playing
    for (const t of ps.next_tracks || []) grab(t);
    return out;
  } catch { return null; }
}

// The TV polls every ~2s for a snappy UI, but the jam/social-connect calls are
// heavier (undocumented endpoints + the dealer socket) — cache their result so
// they still run at most every ~4s.
let jamCache = { data: null, ts: 0 };
const JAM_CACHE_MS = 4000;
async function getJam(env) {
  if (jamCache.data && Date.now() - jamCache.ts < JAM_CACHE_MS) return jamCache.data;
  const out = await getJamUncached(env);
  jamCache = { data: out, ts: Date.now() };
  return out;
}

async function getJamUncached(env) {
  const debug = String(env.JAM_DEBUG).toLowerCase() === 'true';
  const out = { joinUrl: null, members: [], contributors: {} };
  if (debug) out.debug = { attempts: [], deviceId: webDeviceId };
  let tok;
  try {
    tok = await getWebToken(env);
  } catch (e) {
    out.error = e.message;
    if (debug) out.debug.tokenError = e.message;
    // Keep the last good link AND members alive through a transient hiccup.
    if (lastJam.joinUrl && Date.now() - lastJam.seen < JAM_STICKY_MS) {
      out.joinUrl = lastJam.joinUrl;
      out.members = lastJam.members;
      out.contributors = lastJam.contributors;
      out.stale = true;
    }
    return out;
  }
  if (!tok) { out.error = 'no sp_dc web token'; return out; }

  const stickyFresh = lastJam.joinUrl && Date.now() - lastJam.seen < JAM_STICKY_MS;
  // While idle (no session lately) throttle the create attempts. But once a
  // Jam is up we re-check every poll so members/contributors stay live.
  if (!stickyFresh && Date.now() < jamIdleUntil) return out;

  const headers = { Authorization: `Bearer ${tok}`, 'User-Agent': UA, Accept: 'application/json' };

  const autoCreate = String(env.JAM_AUTO_CREATE ?? 'true').toLowerCase() !== 'false';
  const dev = webDeviceId ? `&local_device_id=${encodeURIComponent(webDeviceId)}` : '';
  // current_or_new *activates* (creates) a session; attach it to the TV's own
  // playback device when we know it. Keep hitting it every poll so the Jam
  // comes up the instant Spotify has an active device.
  const paths = autoCreate
    ? [
        `/social-connect/v2/sessions/current_or_new?activate=true${dev}`,
        '/social-connect/v2/sessions/current_or_new?activate=true',
        '/social-connect/v2/sessions/current',
      ]
    : ['/social-connect/v2/sessions/current'];
  // Try a few known hosts; Spotify shards these by region.
  const hosts = [
    'https://spclient.wg.spotify.com',
    'https://gew1-spclient.spotify.com',
    'https://guc3-spclient.spotify.com',
  ];
  let session = null;
  outer: for (const p of paths) {
    for (const h of hosts) {
      try {
        const r = await fetch(`${h}${p}`, { headers });
        let j = null, text = '';
        if (r.ok) { text = await r.text(); try { j = JSON.parse(text); } catch {} }
        if (debug) {
          out.debug.attempts.push({
            path: p.split('?')[0].replace('/social-connect/v2/sessions/', '') + (p.includes('local_device_id') ? '+dev' : ''),
            host: h.replace('https://', '').split('.')[0],
            status: r.status,
            keys: j ? Object.keys(j).slice(0, 12) : (text ? text.slice(0, 60) : ''),
          });
        }
        if (j && (j.session_id || j.join_session_token)) { session = j; break outer; }
        if (r.ok) break; // this host answered; don't try the others for this path
      } catch (e) {
        if (debug) out.debug.attempts.push({ path: p.split('?')[0], host: h.replace('https://', '').split('.')[0], err: e.message });
      }
    }
  }

  if (!session) {
    jamIdleUntil = Date.now() + JAM_IDLE_MS; // back off the create attempts a bit
    if (!out.error) out.error = 'no session (nothing playing, or Jam not available for this account/region)';
    if (debug) console.warn('[jam] no session —', JSON.stringify(out.debug.attempts));
    // Fall back to the sticky link + members if fresh so pauses/handoffs don't
    // blank the QR or masquerade as "all guests left".
    if (stickyFresh) {
      out.joinUrl = lastJam.joinUrl;
      out.members = lastJam.members;
      out.contributors = lastJam.contributors;
      out.stale = true;
    }
    return out;
  }

  out.joinUrl = pickJoinUrl(session);
  if (debug && !out.joinUrl) out.debug.sessionKeys = Object.keys(session);

  out.members = (session.session_members || []).map((m) => ({
    name: m.display_name || m.name || 'Guest',
    image: m.image_url || null,
    isOwner: !!m.is_owner || m.id === session.session_owner_id,
  }));

  // Map track uri -> contributor display name.
  // Legacy shape: some session revisions carried the queue inline.
  for (const q of session.queue || session.queue_items || []) {
    const uri = q.metadata?.uri || q.uri || q.track_uri;
    const who =
      q.added_by?.display_name || q.metadata?.added_by || q.provider_display_name;
    if (uri && who) out.contributors[uri] = who;
  }
  // Current shape: queued_by usernames live in the connect-state player state;
  // session_members translates username -> display name.
  const nameOf = {};
  for (const m of session.session_members || []) {
    if (m.username) nameOf[m.username] = m.display_name || m.name || m.username;
  }
  const queuedBy = await fetchQueuedBy(tok);
  if (queuedBy) {
    for (const [uri, user] of Object.entries(queuedBy)) {
      out.contributors[uri] = nameOf[user] || user;
    }
  }
  if (debug) out.debug.queuedBy = queuedBy ? Object.keys(queuedBy).length : null;
  if (out.joinUrl) lastJam = { joinUrl: out.joinUrl, seen: Date.now(), members: out.members, contributors: out.contributors };
  return out;
}

// ─────────────────────────────────────────────────────────────
//  Public: assemble the whole state the TV needs
// ─────────────────────────────────────────────────────────────
export async function getState(env) {
  const [nowRes, queueRes, jam] = await Promise.allSettled([
    api(env, '/me/player/currently-playing'),
    api(env, '/me/player/queue'),
    getJam(env),
  ]);

  const now = nowRes.status === 'fulfilled' ? nowRes.value : null;
  const queue = queueRes.status === 'fulfilled' ? queueRes.value : null;
  const jamData =
    jam.status === 'fulfilled' ? jam.value : { joinUrl: null, members: [], contributors: {} };

  const contributors = jamData.contributors || {};
  const attach = (t) => {
    const s = trackShape(t);
    if (s) s.addedBy = contributors[s.uri] || null;
    return s;
  };

  const nowPlaying = attach(now?.item);

  const queueTracks = (queue?.queue || [])
    .filter((t) => t && t.type === 'track')
    .slice(0, 12)
    .map(attach);

  return {
    isPlaying: !!now?.is_playing,
    progressMs: now?.progress_ms || 0,
    nowPlaying,
    queue: queueTracks,
    jam: {
      active: !!jamData.joinUrl,
      joinUrl: jamData.joinUrl || env.JAM_URL_FALLBACK || null,
      members: jamData.members || [],
      usingFallback: !jamData.joinUrl && !!env.JAM_URL_FALLBACK,
      // sp_dc present -> the server can create the Jam itself once music plays
      auto: !!getCreds(env).spDc,
      error: jamData.error || null,
      ...(jamData.debug ? { debug: jamData.debug } : {}),
    },
    ts: Date.now(),
  };
}
