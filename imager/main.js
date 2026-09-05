'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const drives = require('./lib/drives');
const releases = require('./lib/release');
const elevate = require('./lib/elevate');

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
  elevate.relaunchElevated();
  setTimeout(() => app.quit(), 500);
});

ipcMain.handle('app:open-external', (_e, url) => shell.openExternal(url));

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

// ── Step 2: the stick ────────────────────────────────────────
ipcMain.handle('drives:list', async () => {
  try { return { drives: await drives.list() }; }
  catch (err) { return { drives: [], error: err.message }; }
});

// ── Step 3: the write ────────────────────────────────────────
ipcMain.handle('write:start', async (_e, { src, dest, verify }) => {
  if (writing) throw new Error('A write is already running.');
  if (!fs.existsSync(src)) throw new Error('The image file has gone missing.');

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
        if (win) win.webContents.send('write:progress', {
          phase: 'error', done: true,
          error: 'The write could not be started — administrator rights were refused or unavailable.',
        });
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
