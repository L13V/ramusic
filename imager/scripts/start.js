// Launcher for `npm start`.
//
// VS Code's integrated terminal (and anything else spawned from an Electron
// host) exports ELECTRON_RUN_AS_NODE=1. Inheriting it makes Electron start as
// a plain Node process, so `require('electron')` returns a path string and the
// app dies on `app.whenReady()` with an error that names the wrong problem.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
