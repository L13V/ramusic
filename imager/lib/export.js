'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

/**
 * Check whether a file is already gzip-compressed by reading the first 2 bytes.
 */
function isGzipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } catch {
    return false;
  }
}

/**
 * Exports an image file to a destination path as .img.gz.
 * If the source is already gzipped, it performs a fast stream copy with progress.
 * If the source is uncompressed (.img / .iso), it compresses with gzip level 9 on the fly.
 * Writes to a temporary `.part` file and atomically renames on completion.
 *
 * @param {object} opts
 * @param {string} opts.src - Source image path
 * @param {string} opts.dest - Destination .img.gz path
 * @param {function} [opts.onProgress] - Callback ({ phase, written, total, rate, percent, elapsed })
 * @returns {Promise<{ path: string, size: number }>}
 */
async function exportImage({ src, dest, onProgress } = {}) {
  if (!src) throw new Error('No source image specified for export.');
  if (!dest) throw new Error('No destination path specified for export.');
  if (!fs.existsSync(src)) throw new Error(`Source image file not found: ${src}`);

  const resolvedSrc = path.resolve(src);
  const resolvedDest = path.resolve(dest);
  if (resolvedSrc.toLowerCase() === resolvedDest.toLowerCase()) {
    throw new Error('Destination file cannot be the same as the source file.');
  }

  const destDir = path.dirname(resolvedDest);
  fs.mkdirSync(destDir, { recursive: true });

  const stat = fs.statSync(resolvedSrc);
  const total = stat.size;
  const isCompressed = isGzipFile(resolvedSrc) || resolvedSrc.endsWith('.gz');

  const tmpDest = `${resolvedDest}.part-${Date.now()}`;
  const startTime = Date.now();
  let lastProgressTime = 0;
  let inBytes = 0;
  let outBytes = 0;

  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressTime < 150) return;
    lastProgressTime = now;
    const elapsed = Math.max(0.001, (now - startTime) / 1000);
    const rate = isCompressed ? outBytes / elapsed : inBytes / elapsed;
    const written = isCompressed ? outBytes : inBytes;
    const percent = total > 0 ? Math.min(1, written / total) : 0;

    if (onProgress) {
      onProgress({
        phase: 'exporting',
        written,
        total,
        percent,
        rate,
        elapsed,
        isCompressed,
        outBytes,
      });
    }
  };

  const inTracker = new Transform({
    transform(chunk, _encoding, callback) {
      inBytes += chunk.length;
      if (!isCompressed) emitProgress();
      callback(null, chunk);
    },
  });

  const outTracker = new Transform({
    transform(chunk, _encoding, callback) {
      outBytes += chunk.length;
      if (isCompressed) emitProgress();
      callback(null, chunk);
    },
  });

  try {
    const readStream = fs.createReadStream(resolvedSrc, { highWaterMark: 1024 * 1024 });
    const writeStream = fs.createWriteStream(tmpDest, { highWaterMark: 1024 * 1024 });

    if (isCompressed) {
      await pipeline(readStream, outTracker, writeStream);
    } else {
      const gzip = zlib.createGzip({ level: 9, memLevel: 8 });
      await pipeline(readStream, inTracker, gzip, outTracker, writeStream);
    }

    emitProgress(true);

    // If destination already exists, remove it before renaming (required on Windows)
    if (fs.existsSync(resolvedDest)) {
      try { fs.unlinkSync(resolvedDest); } catch {}
    }
    fs.renameSync(tmpDest, resolvedDest);

    const finalStat = fs.statSync(resolvedDest);
    return {
      path: resolvedDest,
      size: finalStat.size,
    };
  } catch (err) {
    try {
      if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
    } catch {}
    throw err;
  }
}

module.exports = {
  exportImage,
  isGzipFile,
};
