// DNS-over-HTTPS (DoH) engine for RAMTECH OS.
// Routes local DNS queries to Quad9 (9.9.9.9 / dns.quad9.com) via RFC 8484 over HTTP/2 TLS.
import dgram from 'node:dgram';
import http2 from 'node:http2';
import tls from 'node:tls';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT, MOCK, run } from './sys.js';

const CONFIG_FILE = join(ROOT, 'data', 'admin', 'dns.json');
const NM_CONF = '/etc/NetworkManager/conf.d/99-ramtech-doh.conf';
const RESOLV_CONF = '/etc/resolv.conf';
const RESOLV_BACKUP = '/etc/resolv.conf.ramtech-orig';

// Quad9 DoH is the shipped default. Turning it on binds UDP/53 and rewrites
// /etc/resolv.conf, so the takeover is staged: the proxy only claims system DNS
// once a probe query has actually come back through the upstream (see
// startDnsProxy). A device that cannot reach Quad9 keeps the DNS it had.
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
  // The pooled HTTP/2 session is pinned to the old upstream; drop it so the
  // next query dials the new one.
  if (patch.upstream !== undefined || patch.bootstrapIp !== undefined) {
    if (http2Session) { try { http2Session.destroy(); } catch {} http2Session = null; }
    sessionTarget = null;
    lastError = null;            // belongs to the upstream we just replaced
  }
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

// Last upstream failure, surfaced by status() so the admin UI can say what is
// actually wrong instead of "DoH query failed".
let lastError = null;
export function lastDohError() { return lastError; }

/** Turn a TLS/network error into something a person can act on. The certificate
 *  failures worth naming are not hostname mismatches (Quad9's cert covers both
 *  dns.quad9.net and IP 9.9.9.9) — they are a wrong clock and TLS interception,
 *  and neither was ever affected by how checkServerIdentity was written. */
function describeTlsError(err) {
  // Walk the cause chain. http2 reports a failed request as
  // ERR_HTTP2_STREAM_CANCEL and hangs the real reason off `cause`, so reading
  // only the outermost code reports the wrapper every time.
  const chain = [];
  for (let e = err, guard = 0; e && guard < 8; e = e.cause, guard++) chain.push(e);
  const codes = chain.map((e) => e && e.code).filter(Boolean);
  const known = new Set([
    'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'EAI_AGAIN',
    'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  ]);
  const code = codes.find((c) => known.has(c)) || codes[0];
  // Prefer the innermost message: "certificate has expired" beats "the pending
  // stream has been canceled".
  const deepest = chain[chain.length - 1];
  const msg = (deepest && deepest.message) || (err && err.message) || String(err);
  switch (code) {
    case 'CERT_NOT_YET_VALID':
      return `The upstream's certificate is "not yet valid", which almost always means this device's clock is behind. Let NTP sync (or set the date) and DoH will come up on its own. [${code}]`;
    case 'CERT_HAS_EXPIRED':
      return `The upstream's certificate reads as expired — usually this device's clock being wrong rather than a real expiry. Check the system date. [${code}]`;
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `The upstream's certificate is not signed by a CA this device trusts — typically a network that intercepts TLS (captive portal, corporate filter). DoH cannot run through that. [${code}]`;
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The certificate presented does not match the upstream's name — something is answering for it. [${code}]`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not resolve the upstream's address. Set a bootstrap IP so DoH does not need DNS to find its own resolver. [${code}]`;
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Could not reach the upstream on port 443 — often a network that blocks outbound DoH. [${code}]`;
    default:
      return code ? `${msg} [${code}]` : msg;
  }
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
  // Verify the certificate against `servername`, not against the bootstrap IP
  // we happened to dial. The previous override returned undefined ("valid") for
  // the Quad9 names and fell through to `http2.checkServerIdentity`, which does
  // not exist — so the optional call yielded undefined too and EVERY upstream
  // got zero hostname checking. Node's own tls.checkServerIdentity, applied to
  // the SNI name, is exactly the check that was missing.
  http2Session = http2.connect(targetUrl, {
    servername,
    checkServerIdentity: (host, cert) =>
      tls.checkServerIdentity(servername || host, cert),
  });

  http2Session.on('error', (err) => {
    // Keep the reason. This handler used to discard it, which is why a TLS
    // failure surfaced to the user as nothing more specific than "DoH failed".
    lastError = describeTlsError(err);
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
      lastError = null;          // it answered; whatever failed before is past
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
      ...(rcode === 0 ? {} : { error: `Upstream answered with DNS rcode ${rcode}.` }),
    };
  } catch (e) {
    return {
      ok: false,
      domain,
      latencyMs: Date.now() - startTime,
      upstream: getConfig().upstream,
      // Same translation the session handler uses, so "Test" tells you a clock
      // is wrong or TLS is being intercepted rather than echoing an errno.
      error: describeTlsError(e),
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
      } else if (readFileSync(RESOLV_CONF, 'utf8').includes('127.0.0.1')) {
        // No backup, but resolv.conf still points at our proxy — which is about
        // to stop answering, so it must not be left there. Only in that case do
        // we substitute a public resolver; a resolv.conf we never touched is
        // left exactly as we found it.
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
    // Do NOT claim /etc/resolv.conf yet. Pointing the system at this proxy
    // before knowing the upstream answers is how a DoH problem turns into "the
    // device has no DNS at all" — and on a live USB the most likely cause is a
    // clock that NTP has not corrected yet, which fixes itself a minute later.
    // So prove it works first, and keep trying if it does not.
    verifyThenAdopt();
  });
}

// How long to keep retrying the upstream before giving up for this boot. A
// wrong clock, a slow DHCP lease and a captive portal all resolve on their own
// within a couple of minutes; the retry is what turns those into a delay
// instead of a permanent failure.
const ADOPT_RETRY_MS = 15_000;
const ADOPT_MAX_ATTEMPTS = 20;
let adoptTimer = null;
let adopted = false;

function cancelAdopt() {
  if (adoptTimer) { clearTimeout(adoptTimer); adoptTimer = null; }
}

async function verifyThenAdopt(attempt = 1) {
  adoptTimer = null;
  if (!udpServer) return;                       // stopped while we were waiting
  const probe = await testResolution('dns.quad9.net');
  if (!udpServer) return;
  if (probe.ok) {
    lastError = null;
    if (!adopted) {
      adopted = true;
      applySystemDns(true);
      console.log('RAMTECH DoH: upstream verified — system DNS now points at the local proxy');
    }
    return;
  }
  lastError = probe.error || 'upstream did not answer';
  console.warn(`RAMTECH DoH: upstream not usable yet (attempt ${attempt}/${ADOPT_MAX_ATTEMPTS}): ${lastError}`);
  if (attempt >= ADOPT_MAX_ATTEMPTS) {
    console.warn('RAMTECH DoH: giving up for now — system DNS left untouched. Fix the cause and re-enable from the admin UI.');
    return;
  }
  adoptTimer = setTimeout(() => verifyThenAdopt(attempt + 1), ADOPT_RETRY_MS);
  if (adoptTimer.unref) adoptTimer.unref();
}

export function stopDnsProxy() {
  cancelAdopt();
  if (udpServer) {
    try { udpServer.close(); } catch {}
    udpServer = null;
  }
  if (http2Session) {
    try { http2Session.destroy(); } catch {}
    http2Session = null;
  }
  // Only hand system DNS back if we ever took it. Restoring a resolv.conf we
  // never replaced would overwrite whatever the network legitimately set.
  if (adopted) {
    applySystemDns(false);
    adopted = false;
  }
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
    // Listening is not the same as being in use: the proxy holds :53 from the
    // moment it starts, but only takes over system DNS once a probe succeeds.
    systemDns: MOCK ? true : adopted,
    lastError: MOCK ? null : lastError,
    queriesServed,
    mock: MOCK,
  };
}

/** Only the three known fields, each checked. The route used to hand the whole
 *  request body to saveConfig, so any key at all could be persisted into
 *  dns.json and `upstream` could be pointed anywhere. */
function validateSettings(patch) {
  const out = {};
  if (patch?.enabled !== undefined) out.enabled = !!patch.enabled;
  if (patch?.upstream !== undefined) {
    const raw = String(patch.upstream).trim();
    let u;
    try { u = new URL(raw); } catch { throw new Error('Upstream must be a URL.'); }
    if (u.protocol !== 'https:') throw new Error('DoH upstream must be https.');
    out.upstream = raw;
  }
  if (patch?.bootstrapIp !== undefined) {
    const ip = String(patch.bootstrapIp).trim();
    const ok = ip === '' || (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) &&
      ip.split('.').every((o) => Number(o) <= 255));
    if (!ok) throw new Error('Bootstrap IP must be a bare IPv4 address.');
    out.bootstrapIp = ip;
  }
  return out;
}

export async function updateSettings(patch) {
  const updated = saveConfig(validateSettings(patch));
  if (updated.enabled) {
    if (!udpServer) startDnsProxy();
  } else {
    stopDnsProxy();
  }
  return status();
}

// DoH is on by default, so this normally starts at boot. It binds the local
// proxy immediately but does not touch system DNS until a probe query has
// actually returned — so an unreachable upstream costs nothing.
const current = getConfig();
if (current.enabled && !MOCK) {
  try { startDnsProxy(); } catch {}
}
