// The user's Telegram passcode: turn it on, change it, unlock, lock, and the way out when it is
// forgotten (disconnecting the Telegram account). Not inside routes/tele.js on purpose: its hook
// would refuse these while locked, and they must also work when the admin closed Telegram for the user.
// Nothing here lets an admin see, reset or remove someone else's passcode.
import { run, now } from '../db.js';
import { redactAllBackups } from '../backup.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { fail, audit, ensureSavedChat, systemMessage } from '../chats.js';
import { disconnectAccount } from '../tele/accounts.js';
import { passcodeRow, isUnlocked, unlock, lockSession, lockUserSessions, normalizePasscode, passcodeProblem, validIdle, nextFailState, teleQuarantined, quarantineError } from '../tele/passcode.js';

// Every route that checks a password or passcode: 10 tries a minute per address.
const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const forgotLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

// lockedUntil (ms) lets the app show a countdown instead of parsing the message.
const tooMany = (until) => {
  throw Object.assign(new Error(`رمز تلگرام چند بار اشتباه وارد شد؛ ${Math.max(1, Math.ceil((until - now()) / 60000))} دقیقه دیگر دوباره امتحان کنید`), {
    statusCode: 429,
    details: { lockedUntil: until },
  });
};

function state(req) {
  const row = passcodeRow(req.user.id);
  if (!row) return { enabled: false, idleMin: 15, unlocked: !teleQuarantined(), lockedUntil: null };
  return { enabled: true, idleMin: row.idle_min, unlocked: isUnlocked(req.user.session_id, req.user.id, row), lockedUntil: row.locked_until > now() ? row.locked_until : null };
}

async function requirePassword(req) {
  if (!(await verifyPassword(String(req.body?.password || ''), req.user.password_hash))) fail(400, 'رمز عبور حساب اشتباه است');
}

function parseIdle(v) {
  const m = Number(v);
  if (!Number.isInteger(m) || !validIdle(m)) fail(400, 'زمان قفل خودکار نامعتبر است');
  return m;
}

function requireRow(userId) {
  const row = passcodeRow(userId);
  if (!row) fail(400, 'رمز تلگرام فعال نیست');
  return row;
}

// Checks the current passcode. Wrong ones count in the database (so a restart doesn't reset them):
// after 5 in a row, no passcode is even checked for 15 minutes.
async function checkPasscode(req, row, given) {
  if (row.locked_until > now()) tooMany(row.locked_until);
  const p = normalizePasscode(given);
  // A passcode of a length that can't be right is not a guess: refused without counting.
  if (passcodeProblem(p)) fail(400, 'رمز تلگرام اشتباه است');
  if (await verifyPassword(p, row.hash)) {
    if (row.fails || row.locked_until) run('UPDATE tele_passcodes SET fails = 0, locked_until = NULL WHERE user_id = ?', row.user_id);
    return;
  }
  // Read again: other tries may have counted while scrypt ran.
  const fresh = passcodeRow(row.user_id);
  if (!fresh) fail(400, 'رمز تلگرام فعال نیست');
  const next = nextFailState(fresh.fails, now());
  run('UPDATE tele_passcodes SET fails = ?, locked_until = ? WHERE user_id = ?', next.fails, next.lockedUntil, row.user_id);
  if (next.lockedUntil) {
    audit(req.user.id, 'tele.passcode.blocked', req.user.id);
    tooMany(next.lockedUntil);
  }
  fail(400, 'رمز تلگرام اشتباه است');
}

async function redactOldBackups(log) {
  try {
    const { files, dropped } = await redactAllBackups();
    if (!dropped.length) return log.info(`tele passcode: ${files} backup file(s) checked for Telegram history`);
    for (const d of dropped) log.error({ file: d.file }, `tele passcode: backup deleted, could not be redacted: ${d.error}`);
    const { raiseAlert } = await import('../health.js');
    await raiseAlert('backup', `${dropped.length} فایل بکاپ حذف شد چون پاک‌کردن پیام‌های تلگرام قفل‌شده از آن ممکن نبود: ${dropped[0].error}`);
  } catch (e) {
    log.error(e, 'tele passcode: redacting old backups failed');
  }
}

export default async function telePasscodeRoutes(app) {
  app.get('/api/tele/passcode', async (req) => state(req));

  // Turning it on needs the account password, like two-step login: someone at an open, logged-in
  // app must not be able to lock the owner out of their own Telegram.
  app.post('/api/tele/passcode', strict, async (req) => {
    await requirePassword(req);
    if (passcodeRow(req.user.id)) fail(400, 'رمز تلگرام از قبل فعال است');
    const p = normalizePasscode(req.body?.passcode);
    const bad = passcodeProblem(p);
    if (bad) fail(400, bad);
    const idle = req.body?.idleMin === undefined ? 15 : parseIdle(req.body.idleMin);
    run('INSERT INTO tele_passcodes (user_id, hash, idle_min, fails, locked_until, updated_at) VALUES (?, ?, ?, 0, NULL, ?)', req.user.id, await hashPassword(p), idle, now());
    // This login stays open; every other one is locked from now on (it never unlocked).
    lockUserSessions(req.user.id);
    unlock(req.user.session_id, req.user.id);
    audit(req.user.id, 'tele.passcode.enable', req.user.id);
    // Backups already on disk were taken before this: take this user's Telegram history out of them
    // too. In the background (big files take a while); a file that can't be redacted is deleted.
    setImmediate(() => redactOldBackups(req.log));
    return state(req);
  });

  app.patch('/api/tele/passcode', strict, async (req) => {
    const b = req.body || {};
    const row = requireRow(req.user.id);
    await checkPasscode(req, row, b.current);
    const idle = b.idleMin === undefined ? null : parseIdle(b.idleMin);
    let next = null;
    if (b.next !== undefined) {
      next = normalizePasscode(b.next);
      const bad = passcodeProblem(next);
      if (bad) fail(400, bad);
    }
    if (next === null && idle === null) fail(400, 'تغییری داده نشده');
    const hash = next === null ? null : await hashPassword(next);
    // One statement: a new passcode and a new idle time land together or not at all.
    run('UPDATE tele_passcodes SET hash = COALESCE(?, hash), idle_min = COALESCE(?, idle_min), updated_at = ? WHERE user_id = ?', hash, idle, now(), req.user.id);
    if (next !== null) lockUserSessions(req.user.id, { except: req.user.session_id });
    // Proving the passcode here also counts as unlocking this login.
    unlock(req.user.session_id, req.user.id);
    audit(req.user.id, next !== null ? 'tele.passcode.change' : 'tele.passcode.idle', req.user.id, idle !== null ? { idleMin: idle } : '');
    return state(req);
  });

  app.delete('/api/tele/passcode', strict, async (req) => {
    const row = requireRow(req.user.id);
    await checkPasscode(req, row, req.body?.current);
    run('DELETE FROM tele_passcodes WHERE user_id = ?', req.user.id);
    lockUserSessions(req.user.id);
    audit(req.user.id, 'tele.passcode.disable', req.user.id);
    return state(req);
  });

  app.post('/api/tele/passcode/unlock', strict, async (req) => {
    // Closed for everyone (passcodes kept across a restore unreadable): not even the right passcode opens it.
    if (teleQuarantined()) throw quarantineError();
    const row = requireRow(req.user.id);
    await checkPasscode(req, row, req.body?.passcode);
    unlock(req.user.session_id, req.user.id);
    return state(req);
  });

  app.post('/api/tele/passcode/lock', async (req) => {
    lockSession(req.user.session_id);
    return state(req);
  });

  // Forgotten: the only way out is giving up the Telegram connection (and the history stored here).
  // If disconnecting fails, the passcode stays: nothing must be readable without it.
  app.post('/api/tele/passcode/forgot', forgotLimit, async (req) => {
    if (req.body?.confirm !== true) fail(400, 'برای ادامه باید قطع شدن حساب تلگرام را تأیید کنید');
    await requirePassword(req);
    requireRow(req.user.id);
    await disconnectAccount(req.user.id);
    run('DELETE FROM tele_passcodes WHERE user_id = ?', req.user.id);
    lockUserSessions(req.user.id);
    audit(req.user.id, 'tele.passcode.forgot', req.user.id);
    systemMessage(ensureSavedChat(req.user.id), '🔐 رمز تلگرام برداشته شد: حساب تلگرام از این برنامه قطع شد و تاریخچه‌ی ذخیره‌شده‌ی آن پاک شد. اگر شما نبودید، رمز حساب را عوض کنید.');
    return state(req);
  });
}
