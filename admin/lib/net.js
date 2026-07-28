// Network management via NetworkManager (nmcli). The Orange Pi 5 has no
// onboard Wi-Fi — the UI degrades to "no adapter" when none is present.
import os from 'node:os';
import { run, MOCK } from './sys.js';

export async function info() {
  if (MOCK) {
    return {
      hostname: os.hostname(),
      devices: [
        { device: 'end1', type: 'ethernet', state: 'connected', connection: 'Wired connection 1' },
        { device: 'wlan0', type: 'wifi', state: 'disconnected', connection: '' },
      ],
      wifiSupported: true,
    };
  }
  const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device']);
  if (!r.ok) return { hostname: os.hostname(), devices: [], wifiSupported: false, error: 'NetworkManager unavailable' };
  const devices = r.stdout.trim().split('\n').filter(Boolean).map(l => {
    const [device, type, state, connection] = l.split(':');
    return { device, type, state, connection };
  }).filter(d => d.type !== 'loopback');
  return { hostname: os.hostname(), devices, wifiSupported: devices.some(d => d.type === 'wifi') };
}

export async function wifiScan() {
  if (MOCK) {
    return { ok: true, networks: [
      { ssid: 'RAMTECH-Office', signal: 87, security: 'WPA2' },
      { ssid: 'Neighbor 5G', signal: 41, security: 'WPA2' },
    ] };
  }
  const r = await run('nmcli', ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'], { timeout: 25_000 });
  if (!r.ok) return { ok: false, error: r.stderr.trim() || 'scan failed' };
  const seen = new Map();
  for (const l of r.stdout.trim().split('\n')) {
    if (!l) continue;
    // SSID may contain escaped colons (\:) — split on unescaped only.
    const parts = l.split(/(?<!\\):/);
    const ssid = (parts[0] || '').replace(/\\:/g, ':');
    if (!ssid) continue;
    const signal = parseInt(parts[1], 10) || 0;
    if (!seen.has(ssid) || seen.get(ssid).signal < signal)
      seen.set(ssid, { ssid, signal, security: parts[2] || '' });
  }
  return { ok: true, networks: [...seen.values()].sort((a, b) => b.signal - a.signal) };
}

export async function wifiConnect(ssid, password) {
  if (!ssid) return { ok: false, error: 'SSID required' };
  if (MOCK) return { ok: true, mock: true };
  const args = ['device', 'wifi', 'connect', String(ssid)];
  if (password) args.push('password', String(password));
  const r = await run('nmcli', args, { timeout: 45_000 });
  return r.ok ? { ok: true, detail: r.stdout.trim() }
              : { ok: false, error: (r.stderr || r.stdout).trim() || 'connect failed' };
}

export async function setHostname(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(String(name || '')))
    return { ok: false, error: 'Invalid hostname (letters, digits, dashes).' };
  if (MOCK) return { ok: true, mock: true };
  const r = await run('hostnamectl', ['set-hostname', String(name)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() };
  // Keep sudo/mDNS happy: refresh the 127.0.1.1 entry in /etc/hosts.
  await run('bash', ['-c',
    `if grep -q '^127\\.0\\.1\\.1' /etc/hosts; then sed -i "s/^127\\.0\\.1\\.1.*/127.0.1.1\\t${name}/" /etc/hosts; else echo -e "127.0.1.1\\t${name}" >> /etc/hosts; fi`]);
  return { ok: true };
}
