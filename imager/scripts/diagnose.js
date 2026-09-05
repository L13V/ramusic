'use strict';
// Read-only report for a stick the imager cannot open. Prints what the imager
// itself sees, then what Windows says underneath it — Node collapses a dozen
// distinct Win32 failures into one errno, and they need different answers.
//
//   npm run diagnose            (from the imager directory, as Administrator)
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const drives = require('../lib/drives');
const elevate = require('../lib/elevate');

function heading(text) { console.log(`\n== ${text} ==`); }

(async function main() {
  console.log('RAMTECH Imager — drive diagnostics (nothing is written)\n');
  console.log(`platform     ${process.platform} ${process.arch}`);
  console.log(`node         ${process.version}`);
  console.log(`elevated     ${elevate.isElevated()}`);

  heading('Drives the imager offers');
  let list = [];
  try {
    list = await drives.list();
    if (!list.length) console.log('  (none — the imager would show "no removable USB drive found")');
    for (const d of list) {
      // JSON-quoted: a stray character in the device path is invisible otherwise.
      console.log(`  ${JSON.stringify(d.id)}  ${(d.size / 1e9).toFixed(1)} GB  ${d.description}` +
        `${d.mounts.length ? `  mounted ${d.mounts.join(', ')}` : ''}`);
    }
  } catch (err) {
    console.log(`  listing failed: ${err.message}`);
  }

  heading('Opening each one from Node, the way the writer does');
  for (const d of list) {
    for (const [flags, label] of [['r', 'read'], ['r+', 'read+write']]) {
      try {
        fs.closeSync(fs.openSync(d.id, flags));
        console.log(`  ${d.id}  ${label.padEnd(10)} OK`);
      } catch (err) {
        console.log(`  ${d.id}  ${label.padEnd(10)} ${err.code}: ${err.message}`);
      }
    }
  }

  if (process.platform !== 'win32') return;
  const ps = path.join(__dirname, 'diagnose.ps1');
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`\n${out.trim()}`);
  } catch (err) {
    console.log(`\nWindows-level checks failed: ${err.message}`);
    if (err.stdout) console.log(String(err.stdout).trim());
  }
  console.log('\nSend this whole output along when reporting the problem.');
})();
