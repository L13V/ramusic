// System access layer for the RAMTECH admin service.
// Every shell/OS touch goes through here so the whole UI can run in mock mode
// (RAMTECH_MOCK=1, auto-enabled on Windows) for development without a Pi.
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const MOCK = process.env.RAMTECH_MOCK === '1' ||
  (process.env.RAMTECH_MOCK !== '0' && process.platform === 'win32');

export const ROOT = process.env.RAMTECH_ROOT || '/opt/ramtech';

// Units the UI may inspect/control — nothing else is ever passed to systemctl.
export const UNITS = ['spotify-tv-jam', 'ramtech-admin', 'raspotify'];
const ACTIONS = ['start', 'stop', 'restart'];

export function run(cmd, args = [], { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

// ── Status ───────────────────────────────────────────────────
function cpuTempC() {
  if (MOCK) return 47.2;
  try {
    const base = '/sys/class/thermal';
    const temps = readdirSync(base).filter(d => d.startsWith('thermal_zone'))
      .map(d => { try { return parseInt(readFileSync(join(base, d, 'temp'), 'utf8'), 10) / 1000; } catch { return NaN; } })
      .filter(Number.isFinite);
    return temps.length ? Math.max(...temps) : null;
  } catch { return null; }
}

function disk() {
  try {
    const s = statfsSync(MOCK ? os.homedir() : ROOT);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, used: total - free };
  } catch { return null; }
}

function readOsName() {
  if (MOCK) return 'RAMTECH OS (mock)';
  try {
    const rel = readFileSync('/etc/armbian-release', 'utf8');
    const m = rel.match(/^VENDOR=(.*)$/m);
    if (m) return `${m[1].replace(/"/g, '')} OS`;
  } catch {}
  try {
    const m = readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)"?$/m);
    return m ? m[1] : 'Linux';
  } catch { return 'Linux'; }
}

export function appVersion() {
  try { return readFileSync(join(ROOT, 'current', 'VERSION'), 'utf8').trim(); }
  catch { return MOCK ? 'v1.0.0' : null; }
}

function ips() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {}))
    for (const a of addrs || [])
      if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, ip: a.address });
  return out;
}

export async function status() {
  return {
    hostname: os.hostname(),
    os: readOsName(),
    appVersion: appVersion(),
    uptimeSec: Math.round(os.uptime()),
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem: { total: os.totalmem(), free: os.freemem() },
    disk: disk(),
    tempC: cpuTempC(),
    ips: ips(),
    mock: MOCK,
  };
}

// ── Services ─────────────────────────────────────────────────
const mockSvc = Object.fromEntries(UNITS.map(u => [u, { active: 'active', enabled: 'enabled', installed: true }]));

export async function services() {
  const out = {};
  for (const u of UNITS) {
    if (MOCK) { out[u] = mockSvc[u]; continue; }
    const [act, en] = await Promise.all([
      run('systemctl', ['is-active', u]), run('systemctl', ['is-enabled', u])]);
    const activeStr = act.stdout.trim() || 'unknown';
    const enabledStr = en.stdout.trim() || 'unknown';
    const installed = enabledStr !== 'not-found' && activeStr !== 'not-found';
    out[u] = { active: activeStr, enabled: enabledStr, installed };
  }
  return out;
}

export async function serviceAction(unit, action) {
  if (!UNITS.includes(unit) || !ACTIONS.includes(action)) throw new Error('not allowed');
  if (MOCK) {
    mockSvc[unit].active = action === 'stop' ? 'inactive' : 'active';
    return { ok: true, mock: true };
  }
  const en = await run('systemctl', ['is-enabled', unit]);
  if (en.stdout.trim() === 'not-found') {
    return { ok: false, error: `Service ${unit} is not installed on this system` };
  }
  const r = await run('systemctl', [action, unit]);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
}

// ── Logs ─────────────────────────────────────────────────────
export async function logs(unit, lines = 200) {
  if (!UNITS.includes(unit)) throw new Error('not allowed');
  lines = Math.min(Math.max(parseInt(lines, 10) || 200, 10), 2000);
  if (MOCK) return `-- mock journal for ${unit} --\n` +
    Array.from({ length: 8 }, (_, i) => `2026-07-27T21:0${i}:00 ramtech ${unit}[123]: mock log line ${i + 1}`).join('\n');
  const en = await run('systemctl', ['is-enabled', unit]);
  if (en.stdout.trim() === 'not-found') {
    return `-- service ${unit} is not installed on this system --`;
  }
  const r = await run('journalctl', ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso']);
  return r.stdout || r.stderr;
}

// ── Long-running jobs (apt) — started once, output polled ────
const jobs = new Map(); // name → {running, log, code}

export function jobStatus(name) {
  const j = jobs.get(name);
  return j ? { running: j.running, log: j.log.slice(-64_000), code: j.code } : null;
}

export function startAptUpgrade() {
  if (jobs.get('apt')?.running) return { ok: false, error: 'already running' };
  const j = { running: true, log: '', code: null };
  jobs.set('apt', j);
  if (MOCK) {
    j.log = '$ apt-get update\nmock: reading package lists…\n';
    setTimeout(() => { j.log += 'mock: 3 packages upgraded.\n'; j.running = false; j.code = 0; }, 2500);
    return { ok: true };
  }
  const sh = spawn('bash', ['-c',
    'export DEBIAN_FRONTEND=noninteractive; apt-get update 2>&1 && apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade 2>&1'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const append = (d) => { j.log += d.toString(); if (j.log.length > 512_000) j.log = j.log.slice(-256_000); };
  sh.stdout.on('data', append); sh.stderr.on('data', append);
  sh.on('close', (code) => { j.running = false; j.code = code; });
  return { ok: true };
}

// ── Power ────────────────────────────────────────────────────
export async function power(action) {
  if (!['reboot', 'poweroff'].includes(action)) throw new Error('not allowed');
  if (MOCK) return { ok: true, mock: true };
  setTimeout(() => run('systemctl', [action]), 500); // let the HTTP reply flush
  return { ok: true };
}
