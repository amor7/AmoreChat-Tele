// The user's own passcode for the Telegram part: an API-level lock per login (session), on top of
// the app password. It keeps out whoever gets into the account without it (an admin who reset the
// password, a borrowed phone); it does not protect against someone with shell access to the server.
// Background work (send queue, mirrors, sync, alerts) keeps running while locked.
import { get, all, now } from '../db.js';
import { safeInterval } from '../timers.js';
import { isIdleExpired } from './passcode-rules.js';

export * from './passcode-rules.js';

// session id → { userId, at }. Only in memory on purpose: a restart locks everyone.
const unlocked = new Map();

// Set at start (index.js) when the passcodes kept across a restore could not be read: nobody's
// passcode can be trusted to be in place, so Telegram is closed for every user until a start
// without data/tele-passcodes.carry.corrupt (see passcode-carry.js).
export const QUARANTINE_TEXT = 'بخش تلگرام موقتاً قفل است؛ با مدیر سرور تماس بگیرید';
let quarantined = false;
export const setTeleQuarantine = (on) => {
  quarantined = !!on;
};
export const teleQuarantined = () => quarantined;
export const quarantineError = () => Object.assign(new Error(QUARANTINE_TEXT), { statusCode: 423, expose: true });

export const passcodeRow = (userId) => get('SELECT * FROM tele_passcodes WHERE user_id = ?', Number(userId));
export const hasPasscode = (userId) => !!passcodeRow(userId);

/** Users with a passcode, for lists that must not show their Telegram details. */
export const passcodeUserIds = () => new Set(all('SELECT user_id FROM tele_passcodes').map((r) => r.user_id));

export function isUnlocked(sessionId, userId, row = passcodeRow(userId)) {
  if (quarantined) return false;
  if (!row) return true;
  const e = sessionId ? unlocked.get(sessionId) : null;
  if (!e || e.userId !== row.user_id) return false;
  if (isIdleExpired(e, row.idle_min, now())) {
    unlocked.delete(sessionId);
    return false;
  }
  return true;
}

export function touch(sessionId) {
  const e = unlocked.get(sessionId);
  if (e) e.at = now();
}

export function unlock(sessionId, userId) {
  if (sessionId) unlocked.set(sessionId, { userId: Number(userId), at: now() });
}

export function lockSession(sessionId) {
  if (sessionId) unlocked.delete(sessionId);
}

/** Locks every login of this user (but `except`, the one that just proved the passcode). */
export function lockUserSessions(userId, { except = null } = {}) {
  for (const [sid, e] of unlocked) if (e.userId === Number(userId) && sid !== except) unlocked.delete(sid);
}

export const lockedError = () => Object.assign(new Error('بخش تلگرام قفل است'), { statusCode: 423, expose: true });

/**
 * Throws 423 when this user has a passcode and this login hasn't unlocked it (or sat idle too long).
 * Each such request counts as use, except the app's automatic polls (header x-amore-poll: 1):
 * otherwise an open tab would never lock.
 */
export function assertTeleUnlocked(req, { touch: doTouch = true } = {}) {
  const u = req.user;
  if (!u) return;
  if (quarantined) throw quarantineError();
  const row = passcodeRow(u.id);
  if (!row) return;
  if (!isUnlocked(u.session_id, u.id, row)) throw lockedError();
  if (doTouch && req.headers['x-amore-poll'] !== '1') touch(u.session_id);
}

// Entries of logins that are gone (logout, revoked, password reset, ban), timed out, or of users
// who no longer have a passcode. They could not be used anyway; this only frees the memory.
function prune() {
  if (!unlocked.size) return;
  const t = now();
  for (const [sid, e] of unlocked) {
    const row = passcodeRow(e.userId);
    const alive = get('SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?', sid, e.userId, t);
    if (!row || !alive || isIdleExpired(e, row.idle_min, t)) unlocked.delete(sid);
  }
}
safeInterval('tele-passcode-prune', 10 * 60 * 1000, prune);
