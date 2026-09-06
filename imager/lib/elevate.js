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

/**
 * Absolute path to a System32 tool. A 32-bit build on 64-bit Windows gets
 * silently redirected to SysWOW64, where the disk tools do not exist, so bare
 * names like `fltmc` fail with ENOENT and read as "not elevated" forever.
 */
function winTool(name) {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const wow64 = process.arch === 'ia32' && (process.env.PROCESSOR_ARCHITEW6432 ||
    process.env.PROCESSOR_ARCHITECTURE === 'AMD64');
  const dirs = wow64 ? ['Sysnative', 'System32'] : ['System32'];
  for (const d of dirs) {
    const p = path.join(root, d, name);
    if (fs.existsSync(p)) return p;
  }
  return name;   // let PATH resolution have the last word
}

function isElevated() {
  if (process.platform !== 'win32') return Boolean(process.getuid && process.getuid() === 0);
  try {
    // fltmc needs admin; its exit status is the cheapest reliable probe.
    execFileSync(winTool('fltmc.exe'), ['filters'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (err) {
    // ENOENT means the probe itself never ran — fall back to something that
    // only an elevated process can do, rather than reporting a false negative.
    if (err && err.code === 'ENOENT') {
      try { fs.closeSync(fs.openSync('\\\\.\\PHYSICALDRIVE0', 'r')); return true; }
      catch { /* genuinely unelevated, or no disk 0 */ }
    }
    return false;
  }
}

/**
 * Relaunch this app elevated (Windows only). Throws when the UAC prompt is
 * dismissed, so the caller can leave the current window alone.
 */
function relaunchElevated() {
  const exe = process.execPath;
  // In a packaged build argv is just the exe; running from source it is
  // `electron .`, where "." only resolves against the app directory. An
  // elevated Start-Process starts in System32, so both the argument and the
  // working directory have to be made absolute here.
  const appDir = path.resolve(__dirname, '..');
  const args = process.argv.slice(1)
    .filter((a) => !a.startsWith('--'))
    .map((a) => (a === '.' ? appDir : a));
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = [
    `Start-Process -FilePath ${q(exe)} -Verb RunAs -WorkingDirectory ${q(appDir)}`,
    args.length ? `-ArgumentList ${args.map(q).join(',')}` : '',
  ].filter(Boolean).join(' ');

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    throw new Error('The Administrator prompt was dismissed. Choose Yes on it, or right-click the app and pick "Run as administrator".');
  }
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
    // The app is already elevated by the time a write can be started. Keep the
    // child's stderr: when it dies before it can write the progress file, that
    // text is the only account of why.
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'], detached: false, windowsHide: true,
    });
    child.stderrText = '';
    child.stderr.on('data', (b) => { child.stderrText = (child.stderrText + b).slice(-4000); });
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

// POSIX single-quote escaping: close the quoted run, emit a literal quote,
// reopen it — the four characters ' \ ' '. Deliberately a normal string, not a
// template literal: in a template `\'` collapses to a bare quote, so the old
// version emitted ''' and produced unbalanced quoting for any path containing
// an apostrophe ("Dad's stick.img.gz"), breaking every macOS/Linux write.
function shq(s) { return "'" + String(s).split("'").join("'\\''") + "'"; }

module.exports = { isElevated, relaunchElevated, startWriter, winTool };
