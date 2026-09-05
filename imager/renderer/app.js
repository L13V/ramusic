'use strict';

const $ = (id) => document.getElementById(id);
const state = { image: null, release: null, drive: null, platform: '', busy: false };

const fmt = (b) => {
  if (!b && b !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i < 2 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};

// ── Boot ─────────────────────────────────────────────────────
(async function init() {
  const info = await window.imager.info();
  state.platform = info.platform;

  if (info.platform === 'win32' && !info.elevated) {
    $('needs-admin').hidden = false;
    $('relaunch').onclick = async () => {
      $('relaunch-error').hidden = true;
      try { await window.imager.relaunchElevated(); }
      catch (err) {
        $('relaunch-error').textContent = cleanIpcError(err);
        $('relaunch-error').hidden = false;
      }
    };
    return;
  }
  $('app').hidden = false;

  loadLatest();
  refreshDrives();
  setInterval(() => { if (!state.busy) refreshDrives(); }, 4000);

  $('browse').onclick = pickFile;
  $('refresh').onclick = refreshDrives;
  $('write').onclick = startWrite;
  $('again').onclick = () => { $('done').hidden = true; refreshDrives(); };
  $('error-back').onclick = () => { $('error').hidden = true; };
  document.querySelectorAll('input[name=source]').forEach((r) => {
    r.onchange = () => { syncSource(); updateWriteButton(); };
  });

  window.imager.onDownloadProgress(({ phase, received, total }) => {
    showBusy(phase === 'checking' ? 'Checking the download…' : 'Downloading RAMTECH OS…',
      total ? received / total : 0,
      `${fmt(received)} of ${fmt(total)}`);
  });
  window.imager.onWriteProgress(onWriteProgress);
})();

// ── Step 1 ───────────────────────────────────────────────────
async function loadLatest() {
  try {
    state.release = await window.imager.latestRelease();
    $('latest-detail').textContent =
      `${state.release.version} · ${fmt(state.release.size)} · downloaded once, then cached`;
  } catch (err) {
    state.release = null;
    $('latest-detail').textContent = `Not available — ${err.message}`;
    document.querySelector('input[value=file]').checked = true;
  }
  syncSource();
  updateWriteButton();
}

async function pickFile() {
  document.querySelector('input[value=file]').checked = true;
  const picked = await window.imager.pickImage();
  if (picked) {
    state.image = picked;
    $('file-detail').textContent = `${picked.name} · ${fmt(picked.size)}`;
  }
  syncSource();
  updateWriteButton();
}

function usingLatest() { return document.querySelector('input[name=source]:checked').value === 'latest'; }

function syncSource() {
  if (usingLatest()) state.image = null;
}

// ── Step 2 ───────────────────────────────────────────────────
async function refreshDrives() {
  const { drives, error } = await window.imager.listDrives();
  const box = $('drives');

  if (error) { box.innerHTML = `<p class="muted pad">Could not list drives: ${esc(error)}</p>`; return; }
  if (!drives.length) {
    box.innerHTML = '<p class="muted pad">No removable USB drive found. Plug one in — it appears here on its own.</p>';
    state.drive = null; updateWriteButton(); return;
  }
  // Keep the current pick selected across the auto-refresh.
  if (state.drive && !drives.some((d) => d.id === state.drive.id)) state.drive = null;

  box.innerHTML = drives.map((d, i) => `
    <label class="row choice drive">
      <input type="radio" name="drive" value="${i}" ${state.drive && state.drive.id === d.id ? 'checked' : ''}>
      <span class="body">
        <strong>${esc(d.description)}</strong>
        <span class="size">${fmt(d.size)}${d.mounts.length ? ` · ${esc(d.mounts.join(', '))}` : ''} · ${esc(d.id)}</span>
      </span>
    </label>`).join('');

  box.querySelectorAll('input[name=drive]').forEach((input) => {
    input.onchange = () => { state.drive = drives[Number(input.value)]; updateWriteButton(); };
  });
  updateWriteButton();
}

// ── Step 3 ───────────────────────────────────────────────────
function updateWriteButton() {
  const haveImage = usingLatest() ? Boolean(state.release) : Boolean(state.image);
  const ok = haveImage && Boolean(state.drive) && !state.busy;
  $('write').disabled = !ok;
  $('write-hint').textContent = !haveImage ? 'Pick an image first.'
    : !state.drive ? 'Pick a USB stick first.'
    : `Erases ${state.drive.description} (${fmt(state.drive.size)}) completely.`;
}

async function startWrite() {
  const drive = state.drive;
  if (!confirm(`Erase ${drive.description} (${fmt(drive.size)}) and write RAMTECH OS to it?\n\nEverything on that stick will be lost.`)) return;

  state.busy = true;
  updateWriteButton();
  try {
    let src = state.image && state.image.path;
    if (usingLatest()) {
      showBusy('Downloading RAMTECH OS…', 0, '');
      const got = await window.imager.downloadImage(state.release);
      src = got.path;
    }
    showBusy('Preparing the drive…', 0, '');
    await window.imager.write({ src, dest: drive.id, verify: $('verify').checked });
  } catch (err) {
    finishBusy();
    showError(cleanIpcError(err));
  }
}

// An error thrown in the main process arrives with Electron's IPC preamble
// glued to the front of it; the sentence after that is the useful part.
function cleanIpcError(err) {
  const msg = (err && err.message) || String(err);
  return msg.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

function onWriteProgress(p) {
  if (p.phase === 'error') { finishBusy(); showError(p.error); return; }
  if (p.phase === 'done') { finishBusy(); $('done').hidden = false; return; }

  const frac = p.total ? p.written / p.total : 0;
  const rate = p.elapsed && p.bytesOnDevice ? `${fmt(p.bytesOnDevice / p.elapsed)}/s` : '';
  const titles = {
    starting: 'Asking for permission…',
    preparing: 'Preparing the drive…',
    writing: 'Writing to the USB stick…',
    verifying: 'Verifying the USB stick…',
  };
  showBusy(titles[p.phase] || 'Working…', frac,
    [`${Math.round(frac * 100)}%`, rate].filter(Boolean).join(' · '));
}

// ── Chrome ───────────────────────────────────────────────────
function showBusy(title, frac, detail) {
  state.busy = true;
  $('busy').hidden = false;
  $('busy-title').textContent = title;
  $('busy-fill').style.width = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
  $('busy-detail').textContent = detail || '';
}
function finishBusy() { state.busy = false; $('busy').hidden = true; updateWriteButton(); }
function showError(msg) { $('error-detail').textContent = msg; $('error').hidden = false; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
