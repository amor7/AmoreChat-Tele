import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { get, all, run, now } from './db.js';
import { effectiveLimits } from './limits.js';
import { accessAllowed } from './access.js';
import { disconnectSessions } from './realtime.js';

const scrypt = promisify(crypto.scrypt);
export const SESSION_COOKIE = 'ac_session';
const SESSION_TTL = 90 * 24 * 3600 * 1000;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomCode = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// Each login is a session (one per device). `id` is a public handle for the device list;
// the cookie token itself is only ever stored hashed.
export function createSession(userId, userAgent, ip = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(8).toString('hex');
  run(
    'INSERT INTO sessions (token_hash, id, user_id, created_at, last_seen, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    id,
    userId,
    now(),
    now(),
    now() + SESSION_TTL,
    String(userAgent || '').slice(0, 300),
    String(ip || '').slice(0, 64),
  );
  return token;
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

// The user for a cookie token, with `session_id` / `session_last_seen` of that login attached.
export function userFromToken(token) {
  if (!token) return null;
  const user = get(
    `SELECT u.*, s.id AS session_id, s.last_seen AS session_last_seen FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    now(),
  );
  if (!user || user.banned) return null;
  return user;
}

// Log out a user's other devices (or all of them): deletes the sessions and drops their live sockets.
export function revokeSessions(userId, { except = null } = {}) {
  const ids = all('SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, except).map((r) => r.id);
  run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, except);
  disconnectSessions(ids);
  return ids.length;
}

export const cookieOptions = (req) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : req.protocol === 'https',
  maxAge: SESSION_TTL / 1000,
});

export const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    avatar: u.avatar_file_id,
    role: u.role,
    lastSeen: u.last_seen,
  };
}

export function selfUser(u) {
  return { ...publicUser(u), adminPerms: JSON.parse(u.admin_perms || '[]'), limits: effectiveLimits(u), twoFactor: !!u.totp_enabled, mirrorFiles: accessAllowed('mirror_files', u) };
}
