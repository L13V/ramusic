// public/player.js — turns this TV page into a Spotify Connect device using
// the Web Playback SDK, so the dashboard can play music itself and host the
// Jam with no other device needed. Requires Spotify Premium.
//
// Autoplay note: browsers block audio until a user gesture, so the first time
// we show a "Play on this TV" button. On a kiosk you can skip that by launching
// Chromium with --autoplay-policy=no-user-gesture-required (see README), and
// the page will start playback on its own.

(function () {
  const $ = (id) => document.getElementById(id);

  let cfg = null;          // filled from the first /api/state poll
  let sdkReady = false;    // Spotify SDK script finished loading
  let player = null;
  let deviceId = null;
  let started = false;     // playback has begun on this device at least once
  let activating = false;

  // app.js sets window.__cfg on every poll; we watch for web-player config.
  const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';

  window.onSpotifyWebPlaybackSDKReady = () => { sdkReady = true; tryInit(); };

  // Called by app.js after each state poll with the latest config.
  window.__onConfig = (c) => {
    cfg = c;
    if (cfg?.webPlayer) {
      loadSdk();
      tryInit();
      updateButton();
    } else {
      hideButton();
    }
  };

  function loadSdk() {
    if (document.getElementById('spotify-sdk')) return;
    const s = document.createElement('script');
    s.id = 'spotify-sdk';
    s.src = SDK_SRC;
    s.async = true;
    document.head.appendChild(s);
  }

  async function getToken() {
    const r = await fetch('/api/token', { cache: 'no-store' });
    if (!r.ok) throw new Error('token ' + r.status);
    const j = await r.json();
    return j.accessToken;
  }

  function tryInit() {
    if (player || !sdkReady || !cfg?.webPlayer || !window.Spotify) return;
    player = new Spotify.Player({
      name: cfg.deviceName || 'TV Jam',
      volume: 0.8,
      getOAuthToken: (cb) => { getToken().then(cb).catch(() => {}); },
    });

    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      reportDevice(device_id);       // let the server attach the Jam to this device
      setStatus('ready');
      updateButton();
      // If the browser allows gesture-free autoplay (kiosk flag), go straight in.
      // ensureActive also starts a default context when nothing is queued, so the
      // Jam is always ready even before anyone picks a song.
      if (!started) ensureActive().catch(() => {});
    });
    player.addListener('not_ready', () => { setStatus('offline'); reportDevice(null); });
    player.addListener('player_state_changed', (st) => {
      if (st && !st.paused) { started = true; hideButton(); }
    });
    player.addListener('authentication_error', ({ message }) => {
      // Almost always: signed in before the streaming scope was added.
      setStatus('reauth');
      showButton('Reconnect Spotify to enable playback', true);
      console.warn('[web player] auth error — reconnect at /setup:', message);
    });
    player.addListener('account_error', () => {
      setStatus('premium');
      showButton('Spotify Premium required for playback', true);
    });
    player.addListener('initialization_error', ({ message }) => {
      setStatus('unsupported');
      console.warn('[web player] init error (browser may lack EME/Widevine):', message);
    });

    player.connect();
  }

  function reportDevice(id) {
    fetch('/api/player/device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: id }),
    }).catch(() => {});
  }

  async function transferHere(play) {
    if (!deviceId) return;
    await fetch('/api/player/transfer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, play: !!play }),
    });
  }

  // Make this TV the active device. `force` = start a default even if nothing's
  // queued (used by the manual play button); without it, boot respects
  // JAM_AUTOSTART so the TV doesn't auto-play.
  async function ensureActive(force) {
    if (!deviceId) return;
    await fetch('/api/player/ensure', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, force: !!force }),
    });
  }

  // Volume control for the dashboard. Sets the SDK device volume instantly and
  // also nudges the active-device volume via the Web API as a fallback.
  let volFetchT = null;
  window.__setVolume = async (pct) => {
    const v = Math.max(0, Math.min(1, (Number(pct) || 0) / 100));
    try { if (player?.setVolume) await player.setVolume(v); } catch {}          // instant, local
    clearTimeout(volFetchT);                                                    // debounce the API nudge
    volFetchT = setTimeout(() => {
      fetch('/api/player/volume?percent=' + Math.round(v * 100), { method: 'PUT' }).catch(() => {});
    }, 400);
  };
  window.__getVolume = async () => {
    try { if (player?.getVolume) return Math.round((await player.getVolume()) * 100); } catch {}
    return null;
  };

  // ── activate button (satisfies the autoplay gesture requirement) ──
  function btn() { return $('tv-play'); }
  function showButton(label, disabled) {
    const b = btn(); if (!b) return;
    b.querySelector('.tv-play-label').textContent = label || 'Play on this TV';
    b.hidden = false;
    b.classList.toggle('is-note', !!disabled);
  }
  function hideButton() { const b = btn(); if (b) b.hidden = true; }
  function updateButton() {
    if (started) return hideButton();
    if (deviceId) showButton('▶  Play on this TV');
  }

  function setStatus(s) {
    const el = $('tv-device'); if (!el) return;
    const map = {
      ready: 'This TV is a Spotify device',
      offline: '',
      reauth: 'Reconnect Spotify to play here',
      premium: 'Premium needed to play here',
      unsupported: '',
    };
    el.textContent = map[s] || '';
    el.style.display = el.textContent ? 'flex' : 'none';
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('#tv-play');
    if (!b || b.classList.contains('is-note') || activating) return;
    activating = true;
    try {
      // Unlock audio in this tab, then hand playback here (force-start a default
      // if nothing's queued) so the Jam comes up right away.
      if (player?.activateElement) { try { await player.activateElement(); } catch {} }
      await ensureActive(true);
      // Give Spotify a beat; player_state_changed will hide the button.
      setTimeout(() => { activating = false; }, 1500);
    } catch {
      activating = false;
    }
  });
})();
