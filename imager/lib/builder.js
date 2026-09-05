'use strict';
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OS_DIR = path.join(REPO_ROOT, 'os');
const OUT_DIR = path.join(OS_DIR, 'out');
const BUILD_SCRIPT = path.join(OS_DIR, 'build.sh');

let currentBuild = null;

function findLocalBuild() {
  try {
    if (!fs.existsSync(OUT_DIR)) return { exists: false };
    const files = fs.readdirSync(OUT_DIR)
      .filter((f) => f.endsWith('.img.gz'))
      .map((f) => {
        const full = path.join(OUT_DIR, f);
        const stat = fs.statSync(full);
        return { path: full, name: f, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      return { exists: true, ...files[0] };
    }
  } catch {}
  return { exists: false };
}

function checkDocker() {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { windowsHide: true, timeout: 5000 }, (err) => {
      if (err) {
        resolve({
          available: false,
          error: 'Docker is not running or not installed. Please start Docker Desktop to build RAMTECH OS locally.',
        });
      } else {
        resolve({ available: true });
      }
    });
  });
}

function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'bash.exe',
  ];
  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) && fs.existsSync(c)) return c;
    } catch {}
  }
  return 'bash.exe';
}

function startBuild({ clean = false } = {}, onProgress) {
  if (currentBuild) throw new Error('A build is already in progress.');

  return new Promise((resolve, reject) => {
    const bash = findBash();
    const args = [BUILD_SCRIPT.replace(/\\/g, '/')];
    if (clean) args.push('--clean');

    const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
    const child = spawn(bash, args, {
      cwd: REPO_ROOT,
      env,
      windowsHide: true,
    });

    let recentLogs = [];
    const pushLog = (line) => {
      const cleanLine = line.trim();
      if (!cleanLine) return;
      recentLogs.push(cleanLine);
      if (recentLogs.length > 50) recentLogs.shift();
      if (onProgress) onProgress({ phase: 'building', line: cleanLine, recent: recentLogs.slice(-5) });
    };

    let stdoutBuf = '';
    child.stdout.on('data', (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      lines.forEach(pushLog);
    });

    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop();
      lines.forEach(pushLog);
    });

    child.on('error', (err) => {
      currentBuild = null;
      reject(new Error(`Failed to start build process: ${err.message}`));
    });

    child.on('close', (code) => {
      currentBuild = null;
      if (stdoutBuf && stdoutBuf.trim()) pushLog(stdoutBuf);
      if (stderrBuf && stderrBuf.trim()) pushLog(stderrBuf);

      if (code !== 0) {
        const tail = recentLogs.slice(-10).join('\n');
        return reject(new Error(`Build failed (exit code ${code}):\n${tail}`));
      }

      const local = findLocalBuild();
      if (!local.exists) {
        return reject(new Error('Build succeeded, but no .img.gz was found in os/out/.'));
      }
      resolve(local);
    });

    currentBuild = child;
  });
}

function cancelBuild() {
  if (currentBuild) {
    try { currentBuild.kill('SIGTERM'); } catch {}
    currentBuild = null;
  }
}

module.exports = {
  findLocalBuild,
  checkDocker,
  startBuild,
  cancelBuild,
  REPO_ROOT,
};
