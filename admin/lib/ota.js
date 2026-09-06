// OTA update engine: checks GitHub Releases, launches the apply script as a
// detached transient systemd unit (survives restarts of this service — that's
// also how the admin updates itself), and reads back its progress file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, MOCK, run, appVersion } from './sys.js';

const SETTINGS = join(ROOT, 'data', 'admin', 'settings.json');
const STATUS = join(ROOT, 'ota', 'status.json');
const APPLY = join(ROOT, 'bin', 'ramtech-ota-apply.sh');
const ASSET_PREFIX = 'ramtech-app-';

export function settings() {
  try { return { repo: '', autoUpdate: false, ...JSON.parse(readFileSync(SETTINGS, 'utf8')) }; }
  catch { return { repo: process.env.RAMTECH_REPO || '', autoUpdate: false }; }
}

export function saveSettings(patch) {
  const s = { ...settings(), ...patch };
  if (s.repo && !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) return { ok: false, error: 'Repo must be "owner/name".' };
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  return { ok: true, settings: s };
}

// Anchored at BOTH ends. The old pattern only anchored the start, so a release
// tagged `v9.9.9/../../../etc` compared as 9.9.9, passed `newer()`, and was then
// used verbatim as a directory name by the apply script — which does `rm -rf`
// on that path as root.
const TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

function semver(tag) {
  const m = String(tag || '').match(TAG_RE);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** A release tag we are willing to hand to a shell script as a path segment. */
export function isSafeTag(tag) { return TAG_RE.test(String(tag || '')); }
export function newer(a, b) { // a > b ?
  const A = semver(a), B = semver(b);
  if (!A || !B) return false;
  for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] > B[i]; }
  return false;
}

export async function check() {
  const { repo } = settings();
  if (!repo) return { ok: false, error: 'No GitHub repo configured (Settings → owner/name).' };
  const current = appVersion();
  let rel;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ramtech-admin' },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 404) return { ok: false, error: 'Repo not found or it has no releases yet.' };
    if (r.status === 403) return { ok: false, error: 'GitHub API rate limit hit — try again later.' };
    if (!r.ok) return { ok: false, error: `GitHub API error ${r.status}.` };
    rel = await r.json();
  } catch (e) {
    return { ok: false, error: `Cannot reach GitHub: ${e?.message || e}` };
  }
  const asset = (rel.assets || []).find(a => a.name.startsWith(ASSET_PREFIX) && a.name.endsWith('.tar.gz'));
  if (!asset) return { ok: false, error: `Latest release has no ${ASSET_PREFIX}*.tar.gz asset.` };
  if (!isSafeTag(rel.tag_name)) {
    return { ok: false, error: `Release tag "${rel.tag_name}" is not a plain vX.Y.Z version — refusing it.` };
  }
  // The OS image is checked against a published .sha256; the app tarball was
  // not checked against anything. Pass the digest through so the apply script
  // can verify what it downloaded before unpacking it as root.
  const sum = (rel.assets || []).find(a => a.name === `${asset.name}.sha256`);
  return {
    ok: true, current, latest: rel.tag_name,
    updateAvailable: newer(rel.tag_name, current),
    url: asset.browser_download_url, notes: rel.body || '',
    sha256Url: sum ? sum.browser_download_url : null,
    publishedAt: rel.published_at,
  };
}

export function otaStatus() {
  try { return JSON.parse(readFileSync(STATUS, 'utf8')); }
  catch { return { state: 'idle' }; }
}

function writeStatus(obj) {
  mkdirSync(dirname(STATUS), { recursive: true });
  writeFileSync(STATUS, JSON.stringify(obj, null, 2));
}

async function launch(args, label) {
  if (MOCK) { // simulate the script's status progression
    writeStatus({ state: 'downloading', step: label, version: args[1] || '' });
    setTimeout(() => writeStatus({ state: 'installing', step: label }), 1500);
    setTimeout(() => writeStatus({ state: 'success', step: label, version: args[1] || '', finishedAt: new Date().toISOString() }), 4000);
    return { ok: true, mock: true };
  }
  if (!existsSync(APPLY)) return { ok: false, error: `${APPLY} missing.` };
  // Kill any leftover failed unit of the same name, then launch detached.
  await run('systemctl', ['reset-failed', 'ramtech-ota.service']);
  const r = await run('systemd-run', ['--unit=ramtech-ota', '--collect', APPLY, ...args]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

export async function apply() {
  const c = await check();
  if (!c.ok) return c;
  if (!c.updateAvailable) return { ok: false, error: `Already up to date (${c.current}).` };
  const cur = otaStatus();
  if (['downloading', 'installing', 'verifying'].includes(cur.state)) return { ok: false, error: 'An update is already running.' };
  return launch([c.url, c.latest, ...(c.sha256Url ? ['--sha256-url', c.sha256Url] : [])], 'update');
}

export async function rollback() {
  const cur = otaStatus();
  if (['downloading', 'installing', 'verifying'].includes(cur.state)) return { ok: false, error: 'An update is running — wait for it.' };
  return launch(['--rollback'], 'rollback');
}

export async function setAutoUpdate(on) {
  saveSettings({ autoUpdate: !!on });
  if (!MOCK) await run('systemctl', [on ? 'enable' : 'disable', '--now', 'ramtech-ota-check.timer']);
  return { ok: true, autoUpdate: !!on };
}
