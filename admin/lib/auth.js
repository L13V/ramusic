// Password auth + signed-cookie sessions for the admin UI.
// State lives in <ROOT>/data/admin/admin.json. Default password "ramtech"
// (created on first run) with a forced change on first login.
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ROOT } from './sys.js';

const FILE = join(ROOT, 'data', 'admin', 'admin.json');
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE = 'ramtech_sess';

let state = null;

function scrypt(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function load() {
  if (state) return state;
  try { state = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch {
    const salt = crypto.randomBytes(16).toString('hex');
    state = {
      salt, passHash: scrypt('ramtech', salt),
      secret: crypto.randomBytes(32).toString('hex'),
      mustChange: true,
    };
    save();
  }
  return state;
}

function save() {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  // Password hash + session signing secret: owner-only.
  writeFileSync(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch { /* not POSIX */ }
}

// ── Rate limiting (per-IP, in-memory) ────────────────────────
const fails = new Map(); // ip → {count, until}
function limited(ip) {
  const f = fails.get(ip);
  return !!(f && f.until && Date.now() < f.until);
}
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 5 * 60_000; f.count = 0; }
  fails.set(ip, f);
}

// ── Sessions ─────────────────────────────────────────────────
function sign(payload) {
  const mac = crypto.createHmac('sha256', load().secret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}
function verifyToken(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i), mac = token.slice(i + 1);
  const expect = crypto.createHmac('sha256', load().secret).update(payload).digest('hex');
  if (mac.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return false;
  const exp = parseInt(payload.split('|')[0], 10);
  return Number.isFinite(exp) && Date.now() < exp;
}

function cookieOf(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function login(req, res, password) {
  const ip = req.socket.remoteAddress || '?';
  if (limited(ip)) return { ok: false, error: 'Too many attempts — wait 5 minutes.' };
  const s = load();
  if (!sameHash(scrypt(String(password || ''), s.salt), s.passHash)) {
    recordFail(ip);
    return { ok: false, error: 'Wrong password.' };
  }
  fails.delete(ip);
  const token = sign(`${Date.now() + SESSION_TTL}|${crypto.randomBytes(8).toString('hex')}`);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  return { ok: true, mustChange: !!s.mustChange };
}

export function logout(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function sameHash(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function changePassword(current, next) {
  const s = load();
  if (!sameHash(scrypt(String(current || ''), s.salt), s.passHash)) {
    return { ok: false, error: 'Current password is wrong.' };
  }
  if (!next || String(next).length < 6) return { ok: false, error: 'New password must be 6+ characters.' };
  if (String(next) === 'ramtech') return { ok: false, error: 'Pick something other than the default.' };
  s.salt = crypto.randomBytes(16).toString('hex');
  s.passHash = scrypt(String(next), s.salt);
  s.mustChange = false;
  // Rotating the session secret invalidates every cookie signed under the old
  // password. Without this the forced change from the default was cosmetic:
  // a session minted with "ramtech" stayed valid for its full 7 days after.
  s.secret = crypto.randomBytes(32).toString('hex');
  save();
  return { ok: true };
}

export function mustChange() { return !!load().mustChange; }

export function requireAuth(req, res, nextFn) {
  if (verifyToken(cookieOf(req))) return nextFn();
  res.status(401).json({ ok: false, error: 'auth' });
}

/** Routes that must stay shut while the device is still on the default
 *  password. `mustChange` used to be advisory — the login handler returned it
 *  but nothing acted on it, so signing in with "ramtech" opened the whole API,
 *  root shell included. The only thing a must-change session may do is change
 *  the password (and read its own session state, to be told so). */
export function requirePasswordSet(req, res, nextFn) {
  if (!mustChange()) return nextFn();
  res.status(403).json({
    ok: false, error: 'must-change-password', mustChange: true,
  });
}

export function isAuthed(req) { return verifyToken(cookieOf(req)); }
