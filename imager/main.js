'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const drives = require('./lib/drives');
const releases = require('./lib/release');
const elevate = require('./lib/elevate');
const builder = require('./lib/builder');
const exporter = require('./lib/export');

let win = null;
let writing = null;   // { progressPath, timer, child }

function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 760, minWidth: 720, minHeight: 520,
    backgroundColor: '#0b0f14',
    title: 'RAMTECH Imager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Environment ──────────────────────────────────────────────
ipcMain.handle('app:info', () => ({
  platform: process.platform,
  elevated: elevate.isElevated(),
  repo: releases.DEFAULT_REPO,
  version: app.getVersion(),
}));

ipcMain.handle('app:relaunch-elevated', () => {
  // Throws when the UAC prompt is dismissed — leave this window up in that case
  // so there is something on screen to read the reason in.
  elevate.relaunchElevated();
  setTimeout(() => app.quit(), 500);
});

ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:show-item', (_e, targetPath) => {
  if (targetPath) shell.showItemInFolder(targetPath);
  return true;
});

// ── Step 1: the image ────────────────────────────────────────
ipcMain.handle('release:latest', async () => releases.latest());

ipcMain.handle('image:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a RAMTECH OS image',
    properties: ['openFile'],
    filters: [{ name: 'Disk images', extensions: ['gz', 'img', 'iso'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, name: path.basename(p), size: fs.statSync(p).size };
});

ipcMain.handle('image:download', async (_e, release) => {
  const cache = path.join(app.getPath('userData'), 'images');
  const out = await releases.download(release, cache, (p) => win && win.webContents.send('image:progress', p));
  return { ...out, name: release.name, version: release.version };
});

ipcMain.handle('build:status', async () => {
  const local = builder.findLocalBuild();
  const docker = await builder.checkDocker();
  return { local, docker };
});

ipcMain.handle('build:start', async (_e, opts) => {
  return await builder.startBuild(opts, (progress) => {
    if (win) win.webContents.send('build:progress', progress);
  });
});

ipcMain.handle('build:cancel', () => {
  builder.cancelBuild();
  return true;
});

ipcMain.handle('image:save-dialog', async (_e, { defaultName } = {}) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Export as .img.gz',
    defaultPath: defaultName || 'ramtech-os-x86_64.img.gz',
    filters: [
      { name: 'Gzipped Disk Image (*.img.gz)', extensions: ['img.gz', 'gz'] },
      { name: 'All Files (*.*)', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});

ipcMain.handle('image:export', async (_e, { src, dest }) => {
  return await exporter.exportImage({
    src,
    dest,
    onProgress: (progress) => {
      if (win) win.webContents.send('export:progress', progress);
    },
  });
});

// ── Step 2: the stick ────────────────────────────────────────
ipcMain.handle('drives:list', async () => {
  try { return { drives: await drives.list() }; }
  catch (err) { return { drives: [], error: err.message }; }
});

// ── Step 3: the write ────────────────────────────────────────
ipcMain.handle('write:start', async (_e, { src, dest, verify }) => {
  if (writing) throw new Error('A write is already running.');
  if (!fs.existsSync(src)) throw new Error('The image file has gone missing.');
  if (process.platform === 'win32' && !elevate.isElevated()) {
    throw new Error('This window is not running as Administrator. Close the imager, right-click it and choose "Run as administrator", then try again.');
  }

  const { progress, child } = elevate.startWriter({ src, dest, verify });
  let lastRaw = '';
  const timer = setInterval(() => {
    let raw;
    try { raw = fs.readFileSync(progress, 'utf8'); } catch { return; }
    if (raw === lastRaw) return;
    lastRaw = raw;
    let state;
    try { state = JSON.parse(raw); } catch { return; }
    if (win) win.webContents.send('write:progress', state);
    if (state.done) finish();
  }, 200);

  // The elevated child is a grandchild on macOS/Linux, so a clean exit of the
  // wrapper is not proof of success — only the progress file is authoritative.
  child.on('exit', (code) => {
    if (code !== 0 && writing) {
      setTimeout(() => {
        if (!writing) return;
        let state = null;
        try { state = JSON.parse(fs.readFileSync(progress, 'utf8')); } catch {}
        if (state && state.done) return;
        // Nothing in the progress file means the writer died before it could
        // say why. Its stderr is then the only account there is; guessing at
        // "administrator rights" here hid the real cause for every failure.
        const stderr = (child.stderrText || '').trim();
        const error = stderr
          ? `The writer stopped unexpectedly (exit ${code}):\n${stderr.split('\n').slice(-8).join('\n')}`
          : process.platform === 'win32'
            // Windows elevates the whole app, so by here rights are not the
            // suspect — antivirus and disk-protection tools are.
            ? `The writer stopped unexpectedly (exit ${code}) without reporting a reason. Check that no antivirus or disk-protection tool is blocking raw disk writes.`
            // Elsewhere the wrapper is the authorization prompt, and a refused
            // prompt is exactly what a silent non-zero exit looks like.
            : 'The write could not be started — administrator rights were refused or unavailable.';
        if (win) win.webContents.send('write:progress', { phase: 'error', done: true, error });
        finish();
      }, 1500);
    }
  });

  function finish() {
    clearInterval(timer);
    try { fs.unlinkSync(progress); } catch {}
    writing = null;
  }

  writing = { progress, timer, child };
  return true;
});
