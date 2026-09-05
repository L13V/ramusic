'use strict';
// Finding and fetching the published RAMTECH OS image. The build publishes
// ramtech-os-<version>-x86_64.img.gz plus a .sha256 alongside it, so the imager
// can name the version it is about to write and prove the download is intact.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const DEFAULT_REPO = process.env.RAMTECH_REPO || 'L13V/ramusic';
const ASSET_RE = /^ramtech-os-.*-x86_64\.img\.gz$/;

async function latest(repo = DEFAULT_REPO) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ramtech-imager' },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${repo}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => ASSET_RE.test(a.name));
  if (!asset) {
    throw new Error(`Release ${rel.tag_name} has no ramtech-os-*.img.gz asset yet.`);
  }
  const sums = (rel.assets || []).find((a) => a.name.endsWith('.img.gz.sha256'));
  return {
    version: rel.tag_name,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size,
    sha256Url: sums ? sums.browser_download_url : null,
    notesUrl: rel.html_url,
  };
}

/**
 * Download to a cache directory, skipping the transfer when a previous run
 * already left a byte-identical copy there.
 */
async function download(release, cacheDir, onProgress) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, release.name);

  let expected = null;
  if (release.sha256Url) {
    const r = await fetch(release.sha256Url, { headers: { 'user-agent': 'ramtech-imager' } });
    if (r.ok) {
      const line = (await r.text()).split('\n').find((l) => l.includes(release.name));
      if (line) expected = line.trim().split(/\s+/)[0];
    }
  }

  if (fs.existsSync(dest) && fs.statSync(dest).size === release.size) {
    onProgress({ phase: 'checking', received: 0, total: release.size });
    if (!expected || (await sha256File(dest, (n) =>
      onProgress({ phase: 'checking', received: n, total: release.size }))) === expected) {
      return { path: dest, cached: true };
    }
  }

  const res = await fetch(release.url, { headers: { 'user-agent': 'ramtech-imager' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || release.size;
  let received = 0;
  const counter = new (require('stream').Transform)({
    transform(chunk, _enc, cb) { received += chunk.length; onProgress({ phase: 'downloading', received, total }); cb(null, chunk); },
  });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));

  if (expected) {
    onProgress({ phase: 'checking', received: 0, total });
    const got = await sha256File(tmp, (n) => onProgress({ phase: 'checking', received: n, total }));
    if (got !== expected) {
      fs.unlinkSync(tmp);
      throw new Error('The downloaded image failed its SHA-256 check. Try again.');
    }
  }
  fs.renameSync(tmp, dest);
  return { path: dest, cached: false };
}

function sha256File(file, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let n = 0;
    fs.createReadStream(file)
      .on('data', (b) => { h.update(b); n += b.length; if (onBytes) onBytes(n); })
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { latest, download, DEFAULT_REPO };
