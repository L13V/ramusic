'use strict';
// The privileged half of the imager. Runs as a separate elevated process
// (Administrator / root) and streams a gzipped raw image straight onto a block
// device. Progress is written to a file rather than stdout because the
// elevation wrappers on macOS and Linux swallow a child's stdout until it exits.
//
//   writer-child.js --src <image.img.gz> --dest <device> --progress <file> [--verify]
//
// Emits {phase, written, total, done, error, ...} as JSON to --progress.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const elevate = require('./elevate');
const winProbe = require('./win-probe');

const SECTOR = 512;
const CHUNK = 4 * 1024 * 1024;
const FOUR_GIB = 4294967296;

const args = parseArgs(process.argv.slice(2));
const progressPath = args.progress;

function report(state) {
  try {
    fs.writeFileSync(progressPath, JSON.stringify(state));
  } catch {
    try {
      fs.writeFileSync(progressPath + '.tmp', JSON.stringify(state));
      fs.renameSync(progressPath + '.tmp', progressPath);
    } catch { /* the UI just shows the last good sample */ }
  }
}

// Nothing may leave this process without an explanation in the progress file:
// the parent can only see the exit status, and "it exited non-zero" used to be
// reported to the user as refused Administrator rights whatever went wrong.
function fail(err) {
  report({ phase: 'error', done: true, error: explain(err) });
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

/**
 * What to tell the person at the keyboard: the advice for this errno, followed
 * by whatever the failing step attached as `err.detail`. Advice replaced the
 * detail here until it cost a report the disk state that had been collected
 * for it — the two are additive, never alternatives.
 */
function explain(err) {
  const detail = (err && err.detail) || '';
  return [advice(err), detail].filter(Boolean).join('\n\n');
}

function advice(err) {
  const msg = (err && err.message) || String(err);
  switch (err && err.code) {
    case 'EPERM':
    case 'EACCES':
      return process.platform === 'win32'
        ? `Windows refused access to the drive (${err.code}). Close anything that might be holding it — Explorer windows, antivirus, backup or sync tools — then unplug the stick, plug it back in and try again.`
        : `The system refused access to the device (${err.code}).`;
    case 'EBUSY':
      return 'The drive is still in use — the system has not let go of it yet. Unplug the stick, plug it back in and try again.';
    case 'ENOENT':
      return `Not found: ${msg}. The stick may have been unplugged.`;
    case 'ENOSPC':
      return 'The USB stick is too small for this image. Use an 8 GB or larger stick.';
    case 'EIO':
      // Not necessarily a dead stick. Windows answers with the same I/O device
      // error for a disk it has parked offline, and by the time this can happen
      // diskpart has just written to the stick successfully — so the media
      // itself was reachable moments earlier. The Win32 codes in the detail
      // below are what separates the two; the advice covers both.
      return 'Windows reported an I/O device error on this stick, so the write could not start. Unplug it and try a different port — one on the PC itself rather than a hub or a front-panel socket — then try again. If it fails the same way in a second port, the stick is worn out: use another one.';
    case 'EINVAL':
      return 'Windows rejected the handle on this disk, which is neither a permissions problem nor a worn-out stick. Run diagnose.bat (next to imager.bat) as Administrator — it reports the underlying Windows error code, which says which it is.';
    default:
      return msg;
  }
}

// ── How big the image really is ──────────────────────────────
// The progress bar needs a denominator in the units the write actually happens
// in, and for a .gz that is not the size of the .gz. A RAMTECH image ends in a
// 4 GiB persistence partition that is empty, so it costs ~9 MB of the .gz and
// 4 GiB of the write: measured against the compressed file the bar reaches 100%
// with 82% of the write still to go, then sits there for minutes looking hung.
//
// gzip records the uncompressed size in its last four bytes, but only modulo
// 4 GiB — and this image is over that. The image's own partition table says
// roughly how big the disk it describes is, which is all that is needed to
// recover the multiple of 4 GiB the footer dropped.

/** Decompress just enough of the front of the image to hold its boot sectors. */
function gunzipHead(src) {
  try {
    const fd = fs.openSync(src, 'r');
    let raw = Buffer.alloc(256 * 1024);
    try { raw = raw.subarray(0, fs.readSync(fd, raw, 0, raw.length, 0)); }
    finally { fs.closeSync(fd); }
    // Z_SYNC_FLUSH: the input is a deliberately truncated member, and without it
    // zlib treats the missing tail as a corrupt stream instead of a short read.
    return zlib.gunzipSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch { return null; }
}

/** The size of the disk an image's partition table describes, or 0. */
function declaredDiskSize(head) {
  if (!head || head.length < 512 || head.readUInt16LE(510) !== 0xaa55) return 0;
  let end = 0;
  for (let i = 0; i < 4; i++) {
    const e = 446 + i * 16;
    const start = head.readUInt32LE(e + 8);
    const count = head.readUInt32LE(e + 12);
    // 0xffffffff is what a protective MBR puts here when the real size does not
    // fit the field; it describes nothing.
    if (count && count !== 0xffffffff) end = Math.max(end, (start + count) * SECTOR);
  }
  // A GPT disk records its own last sector. Taken as a maximum rather than a
  // preference because an isohybrid image carries a stale one, left pointing at
  // the end of the ISO it was grown from.
  if (head.length >= 1024 && head.toString('latin1', 512, 520) === 'EFI PART') {
    const alt = Number(head.readBigUInt64LE(544));
    if (Number.isSafeInteger(alt) && alt > 0) end = Math.max(end, (alt + 1) * SECTOR);
  }
  return end;
}

/** Bytes this image will occupy once written. Falls back to the footer's own
 *  value, which the writer corrects as it goes if it turns out to be short. */
function uncompressedSize(src) {
  const size = fs.statSync(src).size;
  if (!src.endsWith('.gz')) return size;
  let isize;
  try {
    const fd = fs.openSync(src, 'r');
    try {
      const tail = Buffer.alloc(4);
      fs.readSync(fd, tail, 0, 4, size - 4);
      isize = tail.readUInt32LE(0);
    } finally { fs.closeSync(fd); }
  } catch { return size; }

  const hint = declaredDiskSize(gunzipHead(src));
  const wraps = hint > isize ? Math.max(0, Math.round((hint - isize) / FOUR_GIB)) : 0;
  return isize + wraps * FOUR_GIB;
}

function parseArgs(argv) {
  const out = { verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify') out.verify = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// ── Making the device writable ───────────────────────────────
// Every OS hands out a block device only once nothing else has it mounted.
function isDevice(dest) {
  return process.platform === 'win32'
    ? /^\\\\[.?]\\PHYSICALDRIVE\d+$/i.test(dest)
    : dest.startsWith('/dev/');
}

// Kept for the failure report: whether the prepare step really did what it said
// is the first thing anyone needs to know when the open afterwards fails.
let lastPrepareOutput = '';
let lastRepairOutput = '';

function unmount(dest) {
  // A plain file target is a valid destination (it is how the write path is
  // tested); there is nothing mounted to release.
  if (!isDevice(dest)) return;
  if (process.platform === 'win32') {
    const index = /(\d+)$/.exec(dest)[1];

    // Remove drive letters so Explorer and antivirus drop all locks on the volumes
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Partition -DiskNumber ${index} -ErrorAction SilentlyContinue | ` +
        `Where-Object DriveLetter | ForEach-Object { ` +
        `Remove-PartitionAccessPath -AccessPath ("{0}:\\" -f $_.DriveLetter) -ErrorAction SilentlyContinue }`],
        { windowsHide: true, timeout: 8000, stdio: 'ignore' });
    } catch {}

    // On removable media (USB flash drives), `offline` and `convert` fail with
    // "The operation is not supported on removable media". Use clean with readonly
    // clear and online (with noerr) to reliably prepare both fixed and removable disks.
    const script = [
      `select disk ${index}`,
      'attributes disk clear readonly noerr',
      'online disk noerr',
      'clean',
      'attributes disk clear readonly noerr',
      'online disk noerr',
      'exit',
    ].join('\n') + '\n';
    const tmp = path.join(os.tmpdir(), `ramtech-dp-${process.pid}.txt`);
    fs.writeFileSync(tmp, script);
    try {
      const out = String(execFileSync(elevate.winTool('diskpart.exe'), ['/s', tmp],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
      lastPrepareOutput = tidy(out);
      if (!/succeeded in cleaning the disk/i.test(out)) {
        throw new Error(`Could not prepare the USB stick for writing.\n${tidy(out)}`);
      }
    } catch (err) {
      if (err.stdout === undefined && err.stderr === undefined) throw err;
      throw new Error(`Could not prepare the USB stick for writing.\n${
        tidy(String(err.stdout || '') + String(err.stderr || '')) || explain(err)}`);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  } else if (process.platform === 'darwin') {
    execFileSync('diskutil', ['unmountDisk', 'force', dest], { stdio: 'ignore' });
  } else {
    // Best effort: a stick with nothing mounted makes umount fail, harmlessly.
    try { execFileSync('sh', ['-c', `umount ${dest}?* 2>/dev/null || true`], { stdio: 'ignore' }); } catch {}
  }
}

/** Put a disk Windows has parked offline — or flipped to read-only — back the
 *  way it was. Fast and targeted: no global bus rescan. */
function reonline(dest) {
  if (process.platform !== 'win32') return;
  const index = /(\d+)$/.exec(dest)[1];
  const script = [
    `select disk ${index}`,
    'attributes disk clear readonly noerr',
    'online disk noerr',
    'exit',
  ].join('\n') + '\n';
  const tmp = path.join(os.tmpdir(), `ramtech-dp-online-${process.pid}.txt`);
  try {
    fs.writeFileSync(tmp, script);
    lastRepairOutput = tidy(String(execFileSync(elevate.winTool('diskpart.exe'), ['/s', tmp],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })));
  } catch (err) {
    lastRepairOutput = tidy(String((err && err.stdout) || '') + String((err && err.stderr) || ''))
      || `putting the disk back online failed: ${(err && err.message) || err}`;
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

/** diskpart leads with three lines of version banner before anything useful.
 *  Of what is left, the verdicts are worth more than the tail: `clean`'s
 *  success line sits four lines above the end of the script, and it is the one
 *  that says whether the stick took a write at all. */
function tidy(text) {
  const lines = String(text).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Microsoft DiskPart|Copyright|On computer:)/i.test(l));
  const keep = new Set();
  lines.forEach((l, i) => {
    if (!/succe|fail|error|cannot|denied|refus|no media/i.test(l)) return;
    keep.add(i);
    // "Virtual Disk Service error:" carries its actual complaint on the line
    // after it, which on its own matches nothing.
    if (/:$/.test(l) && lines[i + 1]) keep.add(i + 1);
  });
  for (let i = Math.max(0, lines.length - 4); i < lines.length; i++) keep.add(i);
  return lines.filter((_, i) => keep.has(i)).slice(-8).join('\n');
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Wiping the partition table makes Windows tear the disk down and enumerate it
// again, and for the seconds that takes the device answers with whatever state
// it happens to be in mid-reset: still locked (EBUSY/EACCES), briefly absent
// (ENOENT), faulting (EIO), or refusing the request outright (EINVAL). Which
// one surfaces depends on how far through the teardown the open lands, so an
// allow-list of "the transient ones" is the wrong shape — it was missing EIO,
// then EINVAL, each looking like a hard failure only because it was not waited
// out. The disk was opened successfully moments earlier, before diskpart ran;
// nothing here says it cannot be opened, only that it cannot be opened yet.
// Every error is therefore worth retrying until the deadline, after which the
// real one is reported unchanged.

/** Open the target for writing, waiting out a device that is still settling. */
function openTarget(target, isDev) {
  const deadline = Date.now() + (isDev ? 30000 : 0);
  let attempt = 0;
  for (;;) {
    try {
      return fs.openSync(target, 'r+');
    } catch (err) {
      attempt++;
      // After clean, give Windows a moment to re-enumerate the device handle.
      // If still failing after 3 attempts (~2 seconds), try re-onlining.
      if (isDev && process.platform === 'win32' && attempt >= 3) {
        reonline(target);
      }
      if (Date.now() >= deadline) {
        if (isDev) {
          const state = diskState(target);
          const probe = winProbe.probeOpen(target);
          err.detail = [
            `Details: ${err.code} opening ${JSON.stringify(target)}`,
            state && `Windows reports this disk as: ${state}`,
            lastPrepareOutput && `diskpart said:\n${lastPrepareOutput}`,
            lastRepairOutput && `putting it back online said:\n${lastRepairOutput}`,
            probe && `opening it directly, outside Node:\n${probe}`,
          ].filter(Boolean).join('\n');
        }
        throw err;
      }
      report({ phase: 'preparing', written: 0, total: 0, done: false });
      sleep(attempt === 1 ? 500 : Math.min(1000, 250 * attempt));
    }
  }
}

/** How Windows currently sees the disk — offline and read-only are the two
 *  states that make a healthy stick unopenable. */
function diskState(dest) {
  if (process.platform !== 'win32') return '';
  try {
    const index = /(\d+)$/.exec(dest)[1];
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Disk -Number ${index} | ForEach-Object { '{0}; offline={1}; read-only={2}; {3}; health {4}; partition style {5}' -f ` +
      '$_.FriendlyName,$_.IsOffline,$_.IsReadOnly,$_.OperationalStatus,$_.HealthStatus,$_.PartitionStyle }'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).trim();
  } catch { return ''; }
}

function settle(dest) {
  try {
    if (!isDevice(dest)) return;
    if (process.platform === 'win32') {
      const index = /(\d+)$/.exec(dest)[1];
      // Tell Windows storage stack to reload its cached partition table now that the raw write is complete
      const script = [`select disk ${index}`, 'online disk noerr', 'rescan', 'exit'].join('\n') + '\n';
      const tmp = path.join(os.tmpdir(), `ramtech-dp-settle-${process.pid}.txt`);
      try {
        fs.writeFileSync(tmp, script);
        execFileSync(elevate.winTool('diskpart.exe'), ['/s', tmp],
          { windowsHide: true, timeout: 15000, stdio: 'ignore' });
      } finally { try { fs.unlinkSync(tmp); } catch {} }
    } else if (process.platform === 'darwin') {
      execFileSync('diskutil', ['eject', dest], { stdio: 'ignore' });
    } else {
      execFileSync('blockdev', ['--rereadpt', dest], { stdio: 'ignore' });
    }
  } catch { /* cosmetic */ }
}

async function main() {
  const { src, dest, verify } = args;

  // A device write that starts unprivileged only fails once it reaches the
  // device, with a bare errno. Saying so up front is the difference between a
  // fix and a guess.
  if (isDevice(dest) && !elevate.isElevated()) {
    throw new Error(process.platform === 'win32'
      ? 'This copy of the imager is not running as Administrator, so Windows will not allow a raw disk write. Close it, right-click RAMTECH Imager (or imager.bat) and choose "Run as administrator".'
      : 'The writer is not running as root, so the device cannot be opened.');
  }

  let imageTotal = uncompressedSize(src);

  report({ phase: 'preparing', written: 0, total: imageTotal, done: false });
  unmount(dest);

  // On Windows, raw physical devices (\\.\PHYSICALDRIVE<n>) cannot be opened via
  // Node's fs.openSync because Windows UCRT's _open_osfhandle rejects raw block
  // devices with EINVAL, causing libuv to fail with UV_UNKNOWN.
  // We delegate Windows physical disk writes to win-writer.ps1 which uses native
  // Win32 CreateFileW, WriteFile, ReadFile, and FlushFileBuffers.
  if (process.platform === 'win32' && isDevice(dest)) {
    const winWriter = path.join(__dirname, 'win-writer.ps1');
    const psArgs = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', winWriter,
      '-Src', src,
      '-Dest', dest,
      '-Progress', progressPath,
      '-Total', String(imageTotal),
    ];
    if (verify) psArgs.push('-Verify');

    try {
      execFileSync('powershell.exe', psArgs, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      let state = null;
      try { state = JSON.parse(fs.readFileSync(progressPath, 'utf8')); } catch {}
      if (!state || !state.error) {
        const stderr = String((err && (err.stderr || err.stdout)) || (err && err.message) || '').trim();
        throw new Error(stderr || 'Windows disk write failed.');
      }
      process.exit(1);
    }

    settle(dest);
    return;
  }

  // macOS writes an order of magnitude faster through the raw character device.
  const target = process.platform === 'darwin' && isDevice(dest)
    ? dest.replace('/dev/disk', '/dev/rdisk')
    : dest;
  if (!isDevice(dest) && !fs.existsSync(target)) fs.closeSync(fs.openSync(target, 'w'));
  const fd = openTarget(target, isDevice(dest));

  const hash = crypto.createHash('sha256');
  let offset = 0;              // bytes written to the device (may include a padded tail)
  let imageLen = 0;            // bytes of actual image, i.e. what the hash covers
  let pending = Buffer.alloc(0);
  const started = Date.now();
  let lastReport = 0;

  const isGz = src.endsWith('.gz');
  const source = fs.createReadStream(src, { highWaterMark: CHUNK });
  const dataStream = isGz ? source.pipe(zlib.createGunzip({ chunkSize: CHUNK })) : source;

  const flush = (buf) => {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done, offset + done);
    offset += buf.length;
  };

  try {
    for await (const chunk of dataStream) {
      hash.update(chunk);
      imageLen += chunk.length;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      if (pending.length >= CHUNK) {
        const usable = Math.floor(pending.length / SECTOR) * SECTOR;
        flush(pending.subarray(0, usable));
        pending = Buffer.from(pending.subarray(usable));
      }
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        // The footer only pinned the size modulo 4 GiB; if the estimate was
        // short, recover the missing multiple rather than run past the end.
        while (imageLen > imageTotal) imageTotal += FOUR_GIB;
        report({
          phase: 'writing', written: imageLen, total: imageTotal, done: false,
          bytesOnDevice: offset, elapsed: (now - started) / 1000,
        });
      }
    }
    if (pending.length) {
      // Block devices only accept whole sectors; pad the tail with zeroes.
      const padded = Buffer.alloc(Math.ceil(pending.length / SECTOR) * SECTOR);
      pending.copy(padded);
      flush(padded);
    }
    // Anything the kernel still has cached drains here, which on a slow stick
    // takes long enough that a bar frozen at 100% reads as a hang.
    report({ phase: 'flushing', written: imageLen, total: imageLen, done: false,
      bytesOnDevice: offset, elapsed: (Date.now() - started) / 1000 });
    fs.fsyncSync(fd);
    // Verify against the image's own length, not the zero-padded write length.
    const imageBytes = imageLen;
    const expected = hash.digest('hex');

    if (verify) {
      report({ phase: 'verifying', written: 0, total: imageBytes, done: false });
      fs.closeSync(fd);
      const rfd = fs.openSync(target, 'r');
      const back = crypto.createHash('sha256');
      const buf = Buffer.alloc(CHUNK);
      let pos = 0;
      try {
        while (pos < imageBytes) {
          const want = Math.min(CHUNK, imageBytes - pos);
          // Windows only reads whole sectors from a physical drive, and the last
          // chunk of the image is almost never a multiple of one — so read up to
          // the sector boundary and hash only the bytes the image actually owns.
          const aligned = Math.ceil(want / SECTOR) * SECTOR;
          let got = 0;
          while (got < aligned) {
            const n = fs.readSync(rfd, buf, got, aligned - got, pos + got);
            if (n <= 0) throw new Error('device returned no data during verification');
            got += n;
          }
          back.update(buf.subarray(0, want));
          pos += want;
          const now = Date.now();
          if (now - lastReport > 250) {
            lastReport = now;
            report({ phase: 'verifying', written: pos, total: imageBytes, done: false });
          }
        }
      } finally { fs.closeSync(rfd); }
      // The write padded the last sector, so compare only the image's own bytes.
      if (back.digest('hex') !== expected) {
        throw new Error('Verification failed — the stick did not read back what was written. Try another USB port or another stick.');
      }
    } else {
      fs.closeSync(fd);
    }

    settle(dest);
    report({ phase: 'done', written: imageBytes, total: imageBytes, done: true, bytesOnDevice: imageBytes });
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    throw err;
  }
}

main().catch(fail);
