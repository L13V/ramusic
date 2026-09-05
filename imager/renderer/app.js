'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  image: null,
  release: null,
  build: null,
  buildStatus: null,
  forceRebuild: false,
  drive: null,
  platform: '',
  busy: false,
};

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
  loadBuildStatus();
  refreshDrives();
  setInterval(() => { if (!state.busy) refreshDrives(); }, 4000);

  $('browse').onclick = pickFile;
  $('rebuild').onclick = triggerRebuild;
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
  window.imager.onBuildProgress(({ phase, line, recent }) => {
    showBusy('Building RAMTECH OS…', 0, line || 'Compiling and packaging live image…', true);
    const box = $('busy-log');
    if (box && recent) {
      box.hidden = false;
      box.textContent = recent.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  });
  window.imager.onWriteProgress(onWriteProgress);
})();

// ── Step 1: Image Selection & Build ───────────────────────────
async function loadLatest() {
  try {
    state.release = await window.imager.latestRelease();
    $('latest-detail').textContent =
      `${state.release.version} · ${fmt(state.release.size)} · downloaded once, then cached`;
  } catch (err) {
    state.release = null;
    $('latest-detail').textContent = `Not available — ${err.message}`;
    if (usingLatest()) {
      document.querySelector('input[value=build]').checked = true;
    }
  }
  syncSource();
  updateWriteButton();
}

async function loadBuildStatus() {
  try {
    const status = await window.imager.buildStatus();
    state.buildStatus = status;
    if (status.local && status.local.exists) {
      state.build = status.local;
      $('build-detail').textContent = `${status.local.name} · ${fmt(status.local.size)} (built locally)`;
      $('rebuild').style.display = 'inline-block';
    } else if (status.docker && status.docker.available) {
      state.build = null;
      $('build-detail').textContent = 'Ready to build with Docker (~15-30m)';
      $('rebuild').style.display = 'none';
    } else {
      state.build = null;
      $('build-detail').textContent = 'Docker Desktop required to build from source';
      $('rebuild').style.display = 'none';
    }
  } catch (err) {
    state.build = null;
    $('build-detail').textContent = `Build check: ${err.message}`;
  }
  syncSource();
  updateWriteButton();
}

function triggerRebuild(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  document.querySelector('input[value=build]').checked = true;
  state.forceRebuild = true;
  $('build-detail').textContent = 'Will run clean rebuild with Docker before writing';
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

function usingLatest() {
  const el = document.querySelector('input[name=source]:checked');
  return el ? el.value === 'latest' : true;
}
function usingBuild() {
  const el = document.querySelector('input[name=source]:checked');
  return el ? el.value === 'build' : false;
}
function usingFile() {
  const el = document.querySelector('input[name=source]:checked');
  return el ? el.value === 'file' : false;
}

function syncSource() {
  if (usingLatest()) {
    state.image = null;
  } else if (usingBuild()) {
    state.image = state.forceRebuild ? null : state.build;
  }
}

// ── Step 2: Drive Selection ──────────────────────────────────
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

// ── Step 3: Write / Build & Write ────────────────────────────
function updateWriteButton() {
  let haveImage = false;
  if (usingLatest()) {
    haveImage = Boolean(state.release);
  } else if (usingBuild()) {
    haveImage = Boolean(
      (state.build && !state.forceRebuild) ||
      (state.buildStatus && state.buildStatus.docker && state.buildStatus.docker.available) ||
      state.forceRebuild
    );
  } else {
    haveImage = Boolean(state.image);
  }

  const ok = haveImage && Boolean(state.drive) && !state.busy;
  $('write').disabled = !ok;

  const willBuild = usingBuild() && (!state.build || state.forceRebuild);
  $('write').textContent = willBuild ? 'Build & Write to USB' : 'Write to USB';

  $('write-hint').textContent = !haveImage
    ? (usingBuild() ? 'Docker Desktop or an existing build is needed.' : 'Pick an image first.')
    : !state.drive ? 'Pick a USB stick first.'
    : willBuild
      ? `Builds RAMTECH OS and erases ${state.drive.description} (${fmt(state.drive.size)}).`
      : `Erases ${state.drive.description} (${fmt(state.drive.size)}) completely.`;
}

async function startWrite() {
  const drive = state.drive;
  const willBuild = usingBuild() && (!state.build || state.forceRebuild);
  const promptText = willBuild
    ? `Build RAMTECH OS from source and write it to ${drive.description} (${fmt(drive.size)})?\n\nEverything on that stick will be erased.`
    : `Erase ${drive.description} (${fmt(drive.size)}) and write RAMTECH OS to it?\n\nEverything on that stick will be lost.`;

  if (!confirm(promptText)) return;

  state.busy = true;
  updateWriteButton();
  try {
    let src = state.image && state.image.path;
    if (usingLatest()) {
      showBusy('Downloading RAMTECH OS…', 0, '');
      const got = await window.imager.downloadImage(state.release);
      src = got.path;
    } else if (usingBuild()) {
      if (!state.build || state.forceRebuild) {
        showBusy('Building RAMTECH OS from source…', 0, 'Starting Docker build container…', true);
        const built = await window.imager.startBuild({ clean: state.forceRebuild });
        state.build = built;
        state.forceRebuild = false;
        src = built.path;
        loadBuildStatus();
      } else {
        src = state.build.path;
      }
    }
    showBusy('Preparing the drive…', 0, '');
    await window.imager.write({ src, dest: drive.id, verify: $('verify').checked });
  } catch (err) {
    finishBusy();
    showError(cleanIpcError(err));
  }
}

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
function showBusy(title, frac, detail, showLog = false) {
  state.busy = true;
  $('busy').hidden = false;
  $('busy-title').textContent = title;
  $('busy-fill').style.width = `${Math.max(0, Math.min(1, frac || 0)) * 100}%`;
  $('busy-detail').textContent = detail || '';
  if (!showLog && $('busy-log')) $('busy-log').hidden = true;
}

function finishBusy() {
  state.busy = false;
  $('busy').hidden = true;
  if ($('busy-log')) {
    $('busy-log').hidden = true;
    $('busy-log').textContent = '';
  }
  updateWriteButton();
}

function showError(msg) { $('error-detail').textContent = msg; $('error').hidden = false; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
