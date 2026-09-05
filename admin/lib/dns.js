// DNS-over-HTTPS (DoH) engine for RAMTECH OS.
// Routes local DNS queries to Quad9 (9.9.9.9 / dns.quad9.com) via RFC 8484 over HTTP/2 TLS.
import dgram from 'node:dgram';
import http2 from 'node:http2';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, MOCK, run } from './sys.js';

const CONFIG_FILE = join(ROOT, 'data', 'admin', 'dns.json');
const NM_CONF = '/etc/NetworkManager/conf.d/99-ramtech-doh.conf';
const RESOLV_CONF = '/etc/resolv.conf';
const RESOLV_BACKUP = '/etc/resolv.conf.ramtech-orig';

const DEFAULT_CONFIG = {
  enabled: true,
  upstream: 'https://dns.quad9.com/dns-query',
  bootstrapIp: '9.9.9.9',
};

let config = null;
let udpServer = null;
let http2Session = null;
let sessionTarget = null;
let queriesServed = 0;
const cache = new Map(); // key -> { response: Buffer, expires: number }

export function getConfig() {
  if (config) return config;
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function saveConfig(patch) {
  const cur = getConfig();
  config = { ...cur, ...patch };
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

// ── HTTP/2 DoH Session ─────────────────────────────────────────
function getHttp2Session() {
  const cfg = getConfig();
  let targetHost = cfg.bootstrapIp || '9.9.9.9';
  let servername = 'dns.quad9.net';

  try {
    const u = new URL(cfg.upstream);
    if (u.hostname === 'dns.quad9.com' || u.hostname === 'dns.quad9.net') {
      targetHost = cfg.bootstrapIp || '9.9.9.9';
      servername = 'dns.quad9.net';
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      targetHost = u.hostname;
      servername = undefined;
    } else {
      targetHost = u.hostname;
      servername = u.hostname;
    }
  } catch {}

  const targetUrl = `https://${targetHost}`;

  if (http2Session && !http2Session.closed && !http2Session.destroyed && sessionTarget === targetUrl) {
    return http2Session;
  }

  if (http2Session) {
    try { http2Session.destroy(); } catch {}
    http2Session = null;
  }

  sessionTarget = targetUrl;
  http2Session = http2.connect(targetUrl, {
    servername,
    checkServerIdentity: (host, cert) => {
      // Quad9 certificate includes IP:9.9.9.9 and DNS:dns.quad9.net
      if (host === '9.9.9.9' || host === 'dns.quad9.com' || host === 'dns.quad9.net') {
        return undefined; // Valid
      }
      return http2.checkServerIdentity?.(host, cert);
    },
  });

  http2Session.on('error', () => {
    try { http2Session.destroy(); } catch {}
    http2Session = null;
  });

  http2Session.on('close', () => {
    http2Session = null;
  });

  return http2Session;
}

export function queryDoH(wireBuffer) {
  return new Promise((resolve, reject) => {
    const cfg = getConfig();
    const session = getHttp2Session();
    if (!session) return reject(new Error('Failed to create DoH HTTP/2 session'));

    let path = '/dns-query';
    try {
      const u = new URL(cfg.upstream);
      path = u.pathname + (u.search || '');
    } catch {}

    const req = session.request({
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/dns-message',
      'accept': 'application/dns-message',
      'content-length': wireBuffer.length,
    });

    req.setTimeout(5000, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('DoH query timed out'));
    });

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const resBuf = Buffer.concat(chunks);
      resolve(resBuf);
    });

    req.on('error', reject);
    req.write(wireBuffer);
    req.end();
  });
}

// ── DNS Wire Packet Helpers ────────────────────────────────────
export function buildDnsQuery(domain, type = 1 /* A */) {
  // 12-byte header + qname + type(2) + class(2)
  const parts = domain.split('.').filter(Boolean);
  let qnameLen = 0;
  for (const p of parts) qnameLen += 1 + Buffer.byteLength(p);
  qnameLen += 1; // root null byte

  const buf = Buffer.alloc(12 + qnameLen + 4);
  const id = Math.floor(Math.random() * 0xffff);
  buf.writeUInt16BE(id, 0); // ID
  buf.writeUInt16BE(0x0100, 2); // Flags: standard query, RD=1
  buf.writeUInt16BE(1, 4); // QDCOUNT = 1
  buf.writeUInt16BE(0, 6); // ANCOUNT = 0
  buf.writeUInt16BE(0, 8); // NSCOUNT = 0
  buf.writeUInt16BE(0, 10); // ARCOUNT = 0

  let offset = 12;
  for (const p of parts) {
    const len = Buffer.byteLength(p);
    buf.writeUInt8(len, offset++);
    buf.write(p, offset, len, 'ascii');
    offset += len;
  }
  buf.writeUInt8(0, offset++); // Terminating null
  buf.writeUInt16BE(type, offset); // QTYPE (1 = A)
  buf.writeUInt16BE(1, offset + 2); // QCLASS (1 = IN)

  return { id, buffer: buf };
}

export function parseDnsAnswers(buf) {
  if (buf.length < 12) return [];
  const ancount = buf.readUInt16BE(6);
  if (ancount === 0) return [];

  // Skip question section
  let offset = 12;
  const qdcount = buf.readUInt16BE(4);
  for (let q = 0; q < qdcount; q++) {
    while (offset < buf.length && buf[offset] !== 0) {
      if ((buf[offset] & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      offset += 1 + buf[offset];
    }
    if (offset < buf.length && buf[offset] === 0) offset++;
    offset += 4; // qtype + qclass
  }

  const answers = [];
  for (let a = 0; a < ancount && offset < buf.length; a++) {
    // Name (may be pointer)
    if ((buf[offset] & 0xc0) === 0xc0) {
      offset += 2;
    } else {
      while (offset < buf.length && buf[offset] !== 0) offset += 1 + buf[offset];
      if (offset < buf.length) offset++;
    }
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const ttl = buf.readUInt32BE(offset + 4);
    const rdlen = buf.readUInt16BE(offset + 8);
    offset += 10;

    if (type === 1 && rdlen === 4 && offset + 4 <= buf.length) {
      // IPv4 Address
      const ip = `${buf[offset]}.${buf[offset+1]}.${buf[offset+2]}.${buf[offset+3]}`;
      answers.push({ type: 'A', ip, ttl });
    } else if (type === 28 && rdlen === 16 && offset + 16 <= buf.length) {
      // IPv6 Address
      const parts = [];
      for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(offset + i).toString(16));
      answers.push({ type: 'AAAA', ip: parts.join(':'), ttl });
    }
    offset += rdlen;
  }
  return answers;
}

// ── Live Resolution Test ───────────────────────────────────────
export async function testResolution(domain = 'spotify.com') {
  const startTime = Date.now();
  const { id, buffer: queryBuf } = buildDnsQuery(domain);
  try {
    const resBuf = await queryDoH(queryBuf);
    const latencyMs = Date.now() - startTime;
    const answers = parseDnsAnswers(resBuf);
    const rcode = resBuf.length >= 4 ? resBuf[3] & 0x0f : 0;
    return {
      ok: rcode === 0,
      domain,
      latencyMs,
      upstream: getConfig().upstream,
      answers,
      rcode,
    };
  } catch (e) {
    return {
      ok: false,
      domain,
      latencyMs: Date.now() - startTime,
      upstream: getConfig().upstream,
      error: e.message || String(e),
    };
  }
}

// ── System DNS Configuration ───────────────────────────────────
async function applySystemDns(enabled) {
  if (MOCK || process.platform !== 'linux') return;

  if (enabled) {
    try {
      // 1. Configure NetworkManager to not overwrite /etc/resolv.conf
      mkdirSync('/etc/NetworkManager/conf.d', { recursive: true });
      writeFileSync(NM_CONF, "[main]\ndns=none\n");
      await run('nmcli', ['general', 'reload', 'conf']);

      // 2. Backup current resolv.conf if not already backed up
      if (existsSync(RESOLV_CONF) && !existsSync(RESOLV_BACKUP)) {
        try {
          const orig = readFileSync(RESOLV_CONF, 'utf8');
          if (!orig.includes('127.0.0.1')) {
            writeFileSync(RESOLV_BACKUP, orig);
          }
        } catch {}
      }

      // 3. Point resolv.conf to local DoH proxy
      writeFileSync(RESOLV_CONF, "# Generated by RAMTECH OS DoH\nnameserver 127.0.0.1\noptions timeout:2\n");
    } catch (e) {
      console.error('Failed to apply system DNS settings:', e);
    }
  } else {
    try {
      // 1. Remove NM override
      if (existsSync(NM_CONF)) {
        try { unlinkSync(NM_CONF); } catch {}
        await run('nmcli', ['general', 'reload', 'conf']);
      }

      // 2. Restore backup resolv.conf if present
      if (existsSync(RESOLV_BACKUP)) {
        try {
          const orig = readFileSync(RESOLV_BACKUP, 'utf8');
          writeFileSync(RESOLV_CONF, orig);
          unlinkSync(RESOLV_BACKUP);
        } catch {}
      } else {
        // Fallback to Quad9 standard DNS
        writeFileSync(RESOLV_CONF, "nameserver 9.9.9.9\nnameserver 149.112.112.112\n");
      }
    } catch (e) {
      console.error('Failed to restore system DNS settings:', e);
    }
  }
}

// ── Local UDP DNS Forwarder Proxy (127.0.0.1:53) ───────────────
export function startDnsProxy() {
  if (udpServer) return;
  const cfg = getConfig();
  if (!cfg.enabled) return;

  udpServer = dgram.createSocket('udp4');

  udpServer.on('message', async (msg, rinfo) => {
    queriesServed++;
    if (msg.length < 12) return;

    const queryId = msg.readUInt16BE(0);
    // Cache key based on query body (excluding the 2-byte transaction ID)
    const cacheKey = msg.subarray(2).toString('binary');
    const cached = cache.get(cacheKey);

    if (cached && Date.now() < cached.expires) {
      const resp = Buffer.from(cached.response);
      resp.writeUInt16BE(queryId, 0); // Re-stamp query ID
      udpServer.send(resp, rinfo.port, rinfo.address);
      return;
    }

    try {
      const resBuf = await queryDoH(msg);
      // Cache response for 60s
      if (resBuf.length >= 12) {
        cache.set(cacheKey, {
          response: resBuf,
          expires: Date.now() + 60_000,
        });
        if (cache.size > 1000) {
          const firstKey = cache.keys().next().value;
          cache.delete(firstKey);
        }
      }
      udpServer.send(resBuf, rinfo.port, rinfo.address);
    } catch {
      // On DoH failure, send SERVFAIL (RCODE 2)
      const failBuf = Buffer.alloc(12);
      failBuf.writeUInt16BE(queryId, 0);
      failBuf.writeUInt16BE(0x8182, 2); // Response, Recursion Desired/Available, SERVFAIL
      udpServer.send(failBuf, rinfo.port, rinfo.address);
    }
  });

  udpServer.on('error', (err) => {
    console.warn('RAMTECH DoH local proxy error:', err.message);
    try { udpServer.close(); } catch {}
    udpServer = null;
  });

  udpServer.bind(53, '127.0.0.1', () => {
    console.log(`RAMTECH DoH local proxy listening on 127.0.0.1:53 -> ${cfg.upstream}`);
    applySystemDns(true);
  });
}

export function stopDnsProxy() {
  if (udpServer) {
    try { udpServer.close(); } catch {}
    udpServer = null;
  }
  if (http2Session) {
    try { http2Session.destroy(); } catch {}
    http2Session = null;
  }
  applySystemDns(false);
}

// ── Public API handler ─────────────────────────────────────────
export function status() {
  const cfg = getConfig();
  return {
    ok: true,
    enabled: !!cfg.enabled,
    upstream: cfg.upstream,
    bootstrapIp: cfg.bootstrapIp,
    active: !!udpServer || MOCK,
    queriesServed,
    mock: MOCK,
  };
}

export async function updateSettings(patch) {
  const updated = saveConfig(patch);
  if (updated.enabled) {
    if (!udpServer) startDnsProxy();
  } else {
    stopDnsProxy();
  }
  return status();
}

// Auto-start on module import if enabled
const current = getConfig();
if (current.enabled && !MOCK) {
  try { startDnsProxy(); } catch {}
}
