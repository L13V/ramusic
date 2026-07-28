// public/app.js — polls /api/state and paints the TV.
const $ = (id) => document.getElementById(id);
let cfg = { clock24h: false, refreshMs: 5000 };
let lastArt = null, lastTrackId = null, lastQueueSig = '';

// ── Clock ticks locally every second (no network) ──
function tickClock() {
  const now = new Date();
  let h = now.getHours();
  const m = String(now.getMinutes()).padStart(2, '0');
  let suffix = '';
  if (!cfg.clock24h) { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12 || 12; }
  $('time').textContent = `${cfg.clock24h ? String(h).padStart(2,'0') : h}:${m}${suffix}`;
  $('date').textContent = now.toLocaleDateString(undefined,
    { weekday: 'long', month: 'long', day: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

const fmt = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const initials = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

function paintWeather(w) {
  if (!w || w.error) { $('w-temp').textContent = '--°'; $('w-meta').textContent = w?.error ? '' : '—'; return; }
  $('w-ic').textContent = w.icon;
  $('w-temp').textContent = `${w.temp}°${w.unit}`;
  $('w-meta').innerHTML = `${w.label}<br>${w.city} · H${w.hi}° L${w.lo}°`;
}

function paintNow(s) {
  const t = s.nowPlaying;
  const art = $('art'), empty = $('art-empty');
  if (!t) {
    $('track').textContent = 'Nothing playing';
    $('artist').textContent = 'Start the music on Spotify';
    $('now-status').textContent = 'PAUSED';
    art.style.display = 'none'; empty.style.display = 'grid';
    $('scrub-fill').style.width = '0%';
    $('t-cur').textContent = '0:00'; $('t-dur').textContent = '0:00';
    $('now-added').innerHTML = '';
    return;
  }
  $('now-status').textContent = s.isPlaying ? 'NOW PLAYING' : 'PAUSED';
  $('track').textContent = t.name;
  $('artist').textContent = t.artists;
  if (t.image && t.image !== lastArt) {
    art.src = t.image; art.style.display = 'block'; empty.style.display = 'none';
    $('bg').style.backgroundImage = `url("${t.image}")`;
    lastArt = t.image;
  } else if (!t.image) { art.style.display = 'none'; empty.style.display = 'grid'; }
  const pct = t.durationMs ? Math.min(100, (s.progressMs / t.durationMs) * 100) : 0;
  $('scrub-fill').style.width = pct + '%';
  $('t-cur').textContent = fmt(s.progressMs);
  $('t-dur').textContent = fmt(t.durationMs);
  $('now-added').innerHTML = t.addedBy ? `Added by <b>${escapeHtml(t.addedBy)}</b>` : '';
  lastTrackId = t.id;
}

function paintIdle(idle) {
  document.body.classList.toggle('is-idle', idle);
  if (idle) {
    $('now-status').textContent = 'IDLE · WAITING FOR THE JAM';
    $('track').textContent = 'Waiting for someone to join';
    $('artist').textContent = 'Scan the QR — the music starts the moment you join';
    $('jam-sub').textContent = 'Scan to join — playback begins when you do';
  }
}

function paintQueue(q) {
  const ul = $('queue'), empty = $('queue-empty');
  $('q-count').textContent = q.length ? `· ${q.length}` : '';
  const sig = q.map((t) => t.id).join(',');
  if (sig === lastQueueSig) return;       // avoid re-animating on every poll
  lastQueueSig = sig;
  ul.innerHTML = '';
  empty.style.display = q.length ? 'none' : 'block';
  for (const t of q) {
    const li = document.createElement('li');
    const by = t.addedBy
      ? `<div class="q-by"><span class="av" style="display:grid;place-items:center;font-size:11px;font-weight:700">${initials(t.addedBy)}</span>${escapeHtml(t.addedBy)}</div>`
      : '';
    li.innerHTML = `
      <img class="q-art" src="${t.image || ''}" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="q-txt">
        <div class="q-name">${escapeHtml(t.name)}</div>
        <div class="q-art-name">${escapeHtml(t.artists)}</div>
      </div>${by}`;
    ul.appendChild(li);
  }
}

function paintJam(j) {
  const qr = $('qr'), qe = $('qr-empty');
  if (j.qr) { qr.src = j.qr; qr.style.display = 'block'; qe.style.display = 'none'; }
  else { qr.style.display = 'none'; qe.style.display = 'grid'; qe.textContent = j.auto ? 'Starting…' : 'No active Jam'; }
  $('jam-sub').textContent = j.active
    ? 'Add songs to the queue from your phone'
    : (j.auto ? 'Starting automatically — just press play on Spotify'
              : 'Start a Jam on your phone to activate');
  const mem = $('members');
  mem.innerHTML = '';
  for (const m of j.members || []) {
    const el = document.createElement('div');
    el.className = 'm' + (m.isOwner ? ' owner' : '');
    const av = m.image
      ? `<img src="${m.image}" alt=""/>`
      : `<span class="m-av">${initials(m.name)}</span>`;
    el.innerHTML = `${av}<span>${escapeHtml(m.name)}</span>`;
    mem.appendChild(el);
  }
}

// First-run "Scan to set up" overlay — auto-shows until the server is signed in.
let lastSetupQr = null;
function paintSetup(d) {
  const ov = $('setup-overlay');
  if (!d.needsSetup) { ov.hidden = true; return; }
  ov.hidden = false;
  const pending = !!d.setup?.pending || !d.setup?.qr;
  $('setup-qr-wait').style.display = pending ? 'grid' : 'none';
  $('setup-qr').style.display = pending ? 'none' : 'block';
  if (d.setup?.qr && d.setup.qr !== lastSetupQr) {
    $('setup-qr').src = d.setup.qr;
    lastSetupQr = d.setup.qr;
  }
  $('setup-url').textContent = d.setup?.url ? `or open ${d.setup.url}` : '';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Volume control (drives the TV web player) ──
function setupVolume() {
  const range = $('vol-range'), val = $('vol-val');
  const apply = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    range.value = pct; val.textContent = pct + '%';
    if (window.__setVolume) window.__setVolume(pct);
  };
  range.addEventListener('input', () => apply(Number(range.value)));
  $('vol-up').addEventListener('click', () => apply(Number(range.value) + 5));
  $('vol-down').addEventListener('click', () => apply(Number(range.value) - 5));
}
setupVolume();

// Setup code display — /api/tv/otp only answers on loopback (the TV itself), so
// the code can never be read through the public tunnel.
async function pollOtp() {
  try {
    const r = await fetch('/api/tv/otp', { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      const ov = $('otp-overlay');
      if (j.otp) { $('otp-code').textContent = j.otp; ov.hidden = false; }
      else ov.hidden = true;
    }
  } catch { /* not local / offline */ }
  setTimeout(pollOtp, 2500);
}
pollOtp();

async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'server error');
    cfg = d.config || cfg;
    if (window.__onConfig) window.__onConfig(cfg); // web-player hook
    $('vol').hidden = !(cfg.webPlayer || cfg.canPlay); // volume for SDK or librespot
    paintWeather(d.weather);
    paintSetup(d);
    if (!d.needsSetup) {
      paintNow(d);
      paintQueue(d.queue || []);
      paintJam(d.jam || {});
      // Idle = a Jam is up but nobody but the owner is in it; nothing plays until
      // someone joins. Make that state read as "waiting", not "broken".
      const guests = (d.jam?.members || []).filter((m) => !m.isOwner).length;
      paintIdle(!!(d.jam?.active && guests === 0));
    }
    $('err').textContent = '';
  } catch (e) {
    $('err').textContent = 'offline: ' + e.message;
  } finally {
    setTimeout(poll, cfg.refreshMs || 5000);
  }
}
poll();
