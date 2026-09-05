'use strict';
// Getting the writer child to run with the rights a raw disk write needs.
// Windows elevates the whole app (the packaged build asks for it in its
// manifest); macOS and Linux elevate just the child, so the GUI keeps running
// unprivileged.
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHILD = path.join(__dirname, 'writer-child.js');

function isElevated() {
  if (process.platform !== 'win32') return process.getuid && process.getuid() === 0;
  try {
    // fltmc needs admin; its exit status is the cheapest reliable probe.
    execFileSync('fltmc', ['filters'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** Relaunch this app elevated (Windows only) and return true if the prompt was accepted. */
function relaunchElevated() {
  const exe = process.execPath;
  const args = process.argv.slice(1).filter((a) => !a.startsWith('--'));
  const list = args.length ? args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',') : '';
  const ps = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs` +
             (list ? ` -ArgumentList ${list}` : '');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
}

/**
 * Start the privileged writer. Resolves once the child has been launched — the
 * caller watches the progress file for what happens next.
 */
function startWriter({ src, dest, verify }) {
  const progress = path.join(os.tmpdir(), `ramtech-imager-${Date.now()}.progress`);
  fs.writeFileSync(progress, JSON.stringify({ phase: 'starting', done: false }));

  const argv = [CHILD, '--src', src, '--dest', dest, '--progress', progress];
  if (verify) argv.push('--verify');

  if (process.platform === 'win32') {
    // The app is already elevated by the time a write can be started.
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore', detached: false,
    });
    return { progress, child };
  }

  const cmd = [process.execPath, ...argv].map(shq).join(' ');
  if (process.platform === 'darwin') {
    // osascript buffers a child's output until it exits, which is exactly why
    // progress goes to a file; here the command is backgrounded so the
    // authorization dialog closes immediately.
    const script = `do shell script ${JSON.stringify(
      `ELECTRON_RUN_AS_NODE=1 ${cmd} >/dev/null 2>&1 &`
    )} with administrator privileges`;
    const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
    return { progress, child };
  }

  const child = spawn('pkexec', ['env', 'ELECTRON_RUN_AS_NODE=1', process.execPath, ...argv],
    { stdio: 'ignore' });
  return { progress, child };
}

function shq(s) { return `'${String(s).replace(/'/g, `'\''`)}'`; }

module.exports = { isElevated, relaunchElevated, startWriter };
