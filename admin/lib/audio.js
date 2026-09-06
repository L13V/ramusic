// Audio device management via PulseAudio / PipeWire (pactl).
// Allows viewing audio outputs, switching default sink, and controlling volume/mute.
import { run, MOCK } from './sys.js';
import { existsSync, readdirSync } from 'node:fs';

let mockSinks = [
  {
    name: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
    description: 'Built-in Audio Analog Stereo (Speakers / 3.5mm)',
    index: 1,
    isDefault: true,
    volume: 80,
    mute: false,
  },
  {
    name: 'alsa_output.pci-0000_00_02.0.hdmi-stereo',
    description: 'Intel HDMI / DisplayPort Audio (TV Screen)',
    index: 2,
    isDefault: false,
    volume: 100,
    mute: false,
  },
  {
    name: 'alsa_output.usb-Generic_USB_Audio-00.analog-stereo',
    description: 'USB Audio Device / External DAC',
    index: 3,
    isDefault: false,
    volume: 75,
    mute: false,
  },
];

// Locate user runtime dir or pulse socket if admin runs as root
function getPulseEnv() {
  const env = { ...process.env };
  if (process.platform === 'win32') return env;
  try {
    if (existsSync('/run/user')) {
      const uids = readdirSync('/run/user').filter((u) => /^\d+$/.test(u));
      if (uids.length > 0) {
        const uid = uids.includes('1000') ? '1000' : uids[0];
        const runtimeDir = `/run/user/${uid}`;
        env.XDG_RUNTIME_DIR = runtimeDir;
        if (existsSync(`${runtimeDir}/pulse/native`)) {
          env.PULSE_SERVER = `unix:${runtimeDir}/pulse/native`;
        }
      }
    }
  } catch {}
  return env;
}

async function pactl(args) {
  if (MOCK) return { ok: false, error: 'mock' };
  const env = getPulseEnv();
  // Try running pactl directly with resolved runtime environment
  let r = await run('pactl', args, { env });
  if (!r.ok && env.XDG_RUNTIME_DIR && process.getuid?.() === 0) {
    // If root, attempt running under user ramtech (UID 1000)
    const subArgs = ['-u', 'ramtech', `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`];
    if (env.PULSE_SERVER) subArgs.push(`PULSE_SERVER=${env.PULSE_SERVER}`);
    subArgs.push('pactl', ...args);
    r = await run('sudo', subArgs);
  }
  return r;
}

export async function getAudioOutputs() {
  if (MOCK) {
    const def = mockSinks.find((s) => s.isDefault)?.name || mockSinks[0]?.name;
    return { ok: true, sinks: mockSinks, defaultSink: def };
  }

  try {
    const [listRes, defRes] = await Promise.all([
      pactl(['list', 'sinks']),
      pactl(['get-default-sink']),
    ]);

    if (!listRes.ok) {
      // Say so rather than showing invented hardware. Handing back mockSinks
      // here put three plausible, non-existent outputs in the UI whose controls
      // silently did nothing — a worse failure than an honest error.
      return {
        ok: false,
        sinks: [],
        defaultSink: null,
        error: (listRes.stderr || listRes.stdout || '').trim() ||
          'No audio server reachable (pactl failed). Is PulseAudio/PipeWire running?',
      };
    }

    const defaultSink = (defRes.stdout || '').trim();
    const blocks = listRes.stdout.split(/(?=Sink #\d+)/g).filter(Boolean);
    const sinks = [];

    for (const block of blocks) {
      const indexMatch = block.match(/Sink #(\d+)/);
      const nameMatch = block.match(/^\s*Name:\s*([^\r\n]+)/m);
      const descMatch = block.match(/^\s*Description:\s*([^\r\n]+)/m);
      const muteMatch = block.match(/^\s*Mute:\s*(yes|no)/m);
      const volMatch = block.match(/^\s*Volume:[^%\n]*\s(\d+)%/m);

      if (nameMatch) {
        const name = nameMatch[1].trim();
        const description = descMatch ? descMatch[1].trim() : name;
        const index = indexMatch ? parseInt(indexMatch[1], 10) : sinks.length + 1;
        const mute = muteMatch ? muteMatch[1] === 'yes' : false;
        const volume = volMatch ? parseInt(volMatch[1], 10) : 100;
        const isDefault = name === defaultSink;

        sinks.push({
          index,
          name,
          description,
          mute,
          volume,
          isDefault,
        });
      }
    }

    return { ok: true, sinks, defaultSink };
  } catch (e) {
    return { ok: false, error: e.message, sinks: [], defaultSink: null };
  }
}

export async function setDefaultAudioOutput(sinkName) {
  if (!sinkName) return { ok: false, error: 'sinkName required' };

  if (MOCK) {
    for (const s of mockSinks) s.isDefault = s.name === sinkName;
    return { ok: true, defaultSink: sinkName, mock: true };
  }

  const r = await pactl(['set-default-sink', sinkName]);
  if (!r.ok) {
    return { ok: false, error: (r.stderr || r.stdout).trim() || 'Failed to set default sink' };
  }

  // Move active streams so audio switches immediately without needing a restart
  try {
    const inputsRes = await pactl(['list', 'short', 'sink-inputs']);
    if (inputsRes.ok && inputsRes.stdout) {
      const lines = inputsRes.stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const inputId = line.split(/\s+/)[0];
        if (inputId && /^\d+$/.test(inputId)) {
          await pactl(['move-sink-input', inputId, sinkName]);
        }
      }
    }
  } catch {}

  return { ok: true, defaultSink: sinkName };
}

export async function setVolume(sinkName, volume) {
  const vol = Math.max(0, Math.min(150, parseInt(volume, 10) || 0));
  if (MOCK) {
    const s = mockSinks.find((x) => x.name === sinkName);
    if (s) s.volume = vol;
    return { ok: true, mock: true };
  }
  const r = await pactl(['set-sink-volume', sinkName, `${vol}%`]);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
}

export async function setMute(sinkName, mute) {
  const isMuted = !!mute;
  if (MOCK) {
    const s = mockSinks.find((x) => x.name === sinkName);
    if (s) s.mute = isMuted;
    return { ok: true, mock: true };
  }
  const r = await pactl(['set-sink-mute', sinkName, isMuted ? '1' : '0']);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
}
