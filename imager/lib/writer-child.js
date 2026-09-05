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
const { execFileSync } = require('child_process');

const SECTOR = 512;
const CHUNK = 4 * 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const progressPath = args.progress;

function report(state) {
  try {
    fs.writeFileSync(progressPath + '.tmp', JSON.stringify(state));
    fs.renameSync(progressPath + '.tmp', progressPath);
  } catch { /* the UI just shows the last good sample */ }
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

function unmount(dest) {
  // A plain file target is a valid destination (it is how the write path is
  // tested); there is nothing mounted to release.
  if (!isDevice(dest)) return;
  if (process.platform === 'win32') {
    // `clean` wipes the partition table, which is also the only reliable way to
    // make Windows drop every volume lock on the disk.
    const index = /(\d+)$/.exec(dest)[1];
    const script = `select disk ${index}\nclean\nrescan\nexit\n`;
    const tmp = require('path').join(require('os').tmpdir(), `ramtech-dp-${process.pid}.txt`);
    fs.writeFileSync(tmp, script);
    try { execFileSync('diskpart', ['/s', tmp], { stdio: 'ignore' }); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  } else if (process.platform === 'darwin') {
    execFileSync('diskutil', ['unmountDisk', 'force', dest], { stdio: 'ignore' });
  } else {
    // Best effort: a stick with nothing mounted makes umount fail, harmlessly.
    try { execFileSync('sh', ['-c', `umount ${dest}?* 2>/dev/null || true`], { stdio: 'ignore' }); } catch {}
  }
}

function settle(dest) {
  try {
    if (!isDevice(dest) || process.platform === 'win32') return;
    if (process.platform === 'darwin') execFileSync('diskutil', ['eject', dest], { stdio: 'ignore' });
    else execFileSync('blockdev', ['--rereadpt', dest], { stdio: 'ignore' });
  } catch { /* cosmetic */ }
}

async function main() {
  const { src, dest, verify } = args;
  const compressedTotal = fs.statSync(src).size;

  report({ phase: 'preparing', written: 0, total: compressedTotal, done: false });
  unmount(dest);

  // macOS writes an order of magnitude faster through the raw character device.
  const target = process.platform === 'darwin' && isDevice(dest)
    ? dest.replace('/dev/disk', '/dev/rdisk')
    : dest;
  if (!isDevice(dest) && !fs.existsSync(target)) fs.closeSync(fs.openSync(target, 'w'));
  const fd = fs.openSync(target, 'r+');

  const hash = crypto.createHash('sha256');
  let offset = 0;              // bytes written to the device (may include a padded tail)
  let imageLen = 0;            // bytes of actual image, i.e. what the hash covers
  let readCompressed = 0;      // bytes consumed from the .gz, for the progress bar
  let pending = Buffer.alloc(0);
  const started = Date.now();
  let lastReport = 0;

  const source = fs.createReadStream(src, { highWaterMark: CHUNK });
  source.on('data', (b) => { readCompressed += b.length; });
  const gunzip = source.pipe(zlib.createGunzip({ chunkSize: CHUNK }));

  const flush = (buf) => {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(fd, buf, done, buf.length - done, offset + done);
    offset += buf.length;
  };

  try {
    for await (const chunk of gunzip) {
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
        report({
          phase: 'writing', written: readCompressed, total: compressedTotal, done: false,
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
    report({ phase: 'done', written: compressedTotal, total: compressedTotal, done: true, bytesOnDevice: imageBytes });
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    report({ phase: 'error', done: true, error: err.message || String(err) });
    process.exitCode = 1;
  }
}

main();
