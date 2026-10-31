import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { get, all, run, now, tx, parseJSON } from '../db.js';
import { getSetting, hasAnyUser } from '../settings.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  cookieOptions,
  SESSION_COOKIE,
  USERNAME_RE,
  selfUser,
  publicUser,
  revokeSessions,
  randomCode,
} from '../auth.js';
import { fail, addMember, ensureEmergencyChannel, ensureSavedChat, systemMessage, audit, joinAutoChats } from '../chats.js';
import { noteLoginFailure, noteLogin } from '../secwatch.js';
import { checkTotp, useRecoveryCode, passwordProblem, deviceName } from '../security.js';
import { isOnline } from '../realtime.js';
import { mediaReady } from '../media.js';
import { spendLookup, isUserStaff, searchAcquaintances, knowsUser } from '../lookup.js';
import { rtcEnabled } from '../livekit.js';

const VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

const authLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
// A real scrypt hash of a random password (made once at start), for logins with unknown usernames.
const DUMMY_HASH = await hashPassword(randomCode(16));

// Lock an account for 15 minutes after 10 wrong passwords/codes in a row (on top of the
// per-IP rate limit), so guessing a password from many IPs doesn't work either. Browsers that
// logged in to the account before have a device cookie and are counted apart: strangers typing wrong
// passwords can't keep the owner out. A locked account answers like any wrong password, so the
// answer doesn't tell which usernames exist.
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;
const WRONG_LOGIN = 'نام کاربری یا رمز عبور اشتباه است (بعد از چند تلاش ناموفق، ورود ۱۵ دقیقه قفل می‌شود)';
const DEVICE_COOKIE = 'ac_device';
const DEVICE_MS = 365 * 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const deviceFails = new Map(); // "user:token hash" → { n, until }
function trustedDevice(user, req) {
  const token = req.cookies[DEVICE_COOKIE];
  if (!user || !token) return null;
  const hash = sha256(token);
  return get('SELECT 1 AS ok FROM trusted_devices WHERE token_hash = ? AND user_id = ? AND at > ?', hash, user.id, now() - DEVICE_MS) ? `${user.id}:${hash}` : null;
}
const isLocked = (user, device) => (device ? (deviceFails.get(device)?.until || 0) > now() : (user?.locked_until || 0) > now());
function rememberDevice(user, req, reply) {
  const token = req.cookies[DEVICE_COOKIE] || randomCode(32);
  run('INSERT OR REPLACE INTO trusted_devices (token_hash, user_id, at) VALUES (?, ?, ?)', sha256(token), user.id, now());
  reply.setCookie(DEVICE_COOKIE, token, { ...cookieOptions(req), maxAge: DEVICE_MS / 1000 });
}
function noteFailedLogin(user, req) {
  const device = trustedDevice(user, req);
  if (device) {
    const d = deviceFails.get(device) || { n: 0, until: 0 };
    d.n += 1;
    if (d.n >= LOCK_AFTER) Object.assign(d, { n: 0, until: now() + LOCK_MS });
    deviceFails.set(device, d);
    return;
  }
  const n = (user.failed_logins || 0) + 1;
  if (n >= LOCK_AFTER) {
    run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', now() + LOCK_MS, user.id);
    audit(null, 'user.locked', user.id, { ip: req.ip });
  } else {
    run('UPDATE users SET failed_logins = ? WHERE id = ?', n, user.id);
  }
}

// Password-checked, waiting for the authenticator code. In memory: a restart just asks again.
const tickets = new Map();
function issueTicket(userId) {
  const t = randomCode(24);
  tickets.set(t, { userId, expires: now() + 5 * 60 * 1000, attempts: 0 });
  for (const [k, v] of tickets) if (v.expires < now()) tickets.delete(k);
  return t;
}

// Creates the session cookie and leaves a "new login" note in the user's Saved Messages.
function startSession(user, req, reply) {
  noteLogin(user, req.ip, deviceName(req.headers['user-agent']));
  reply.setCookie(SESSION_COOKIE, createSession(user.id, req.headers['user-agent'], req.ip), cookieOptions(req));
  rememberDevice(user, req, reply);
  const saved = ensureSavedChat(user.id);
  systemMessage(saved, `🔐 ورود جدید به حساب شما: ${deviceName(req.headers['user-agent'])} · IP ${req.ip}. اگر شما نبودید، از پروفایل ← دستگاه‌ها آن را خارج کنید و رمز را عوض کنید.`);
}

function checkInvite(code) {
  const inv = get('SELECT * FROM invites WHERE code = ?', String(code || '').trim());
  if (!inv) return null;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return null;
  if (inv.expires_at != null && inv.expires_at < now()) return null;
  return inv;
}

export default async function authRoutes(app) {
  app.get('/api/config', { config: { public: true } }, async () => ({
    version: VERSION,
    siteName: getSetting('site_name'),
    registrationMode: getSetting('registration_mode'),
    allowUserGroups: getSetting('allow_user_groups') === '1',
    videoProcessing: await mediaReady,
    rtc: rtcEnabled,
    needsSetup: !hasAnyUser(),
  }));

  app.get('/api/invites/:code/check', { config: { public: true, ...authLimit } }, async (req) => ({
    valid: !!checkInvite(req.params.code),
  }));

  app.post('/api/auth/register', { config: { public: true, ...authLimit } }, async (req, reply) => {
    const { username, password, displayName, invite } = req.body || {};
    const firstUser = !hasAnyUser();
    const mode = getSetting('registration_mode');

    if (!firstUser && mode === 'closed') fail(403, 'ثبت‌نام در حال حاضر بسته است');
    if (!USERNAME_RE.test(username || '')) fail(400, 'نام کاربری باید ۳ تا ۳۲ حرف انگلیسی، عدد یا _ باشد و با حرف شروع شود');
    const weak = passwordProblem(password, username);
    if (weak) fail(400, weak);
    const name = String(displayName || '').trim().slice(0, 64);
    if (!name) fail(400, 'نام نمایشی را وارد کنید');

    let inv = null;
    if (firstUser || mode === 'invite') {
      inv = checkInvite(invite);
      if (!inv) fail(403, firstUser ? 'کد راه‌اندازی نامعتبر است (در لاگ سرور چاپ شده)' : 'کد دعوت نامعتبر یا منقضی است');
    }
    if (get('SELECT 1 FROM users WHERE username = ?', username)) fail(409, 'این نام کاربری قبلاً گرفته شده');

    const hash = await hashPassword(password);
    const userId = tx(() => {
      if (inv) run('UPDATE invites SET uses = uses + 1 WHERE id = ?', inv.id);
      const r = run(
        'INSERT INTO users (username, display_name, password_hash, role, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)',
        username,
        name,
        hash,
        firstUser ? 'owner' : 'user',
        now(),
        now(),
      );
      return Number(r.lastInsertRowid);
    });

    ensureSavedChat(userId);
    addMember(ensureEmergencyChannel(), userId, firstUser ? 'owner' : 'member', { silent: true });
    joinAutoChats(userId);
    audit(userId, 'user.register', userId, inv ? { invite: inv.code } : '');

    // Where the account was made counts as a known place (a later login from elsewhere is "new").
    noteLogin(get('SELECT * FROM users WHERE id = ?', userId), req.ip, deviceName(req.headers['user-agent']));
    reply.setCookie(SESSION_COOKIE, createSession(userId, req.headers['user-agent'], req.ip), cookieOptions(req));
    rememberDevice({ id: userId }, req, reply);
    return { user: selfUser(get('SELECT * FROM users WHERE id = ?', userId)) };
  });

  // Password step. With two-step login on, this only returns a short-lived ticket;
  // the session is created by /api/auth/2fa once the authenticator code checks out.
  app.post('/api/auth/login', { config: { public: true, ...authLimit } }, async (req, reply) => {
    const { username, password } = req.body || {};
    const user = get('SELECT * FROM users WHERE username = ?', String(username || ''));
    const device = trustedDevice(user, req);
    const locked = isLocked(user, device);
    // Unknown usernames are checked against a dummy hash too: the same response time either way,
    // so timing doesn't tell which usernames exist.
    const right = await verifyPassword(String(password || ''), user?.password_hash || DUMMY_HASH);
    if (!right || !user || locked) {
      if (user && !locked) noteFailedLogin(user, req);
      noteLoginFailure(req.ip, username);
      fail(401, WRONG_LOGIN);
    }
    if (user.banned) fail(403, 'حساب شما مسدود شده است');
    if (device) deviceFails.delete(device);
    // Coming in on a known device during an attack doesn't give the attacker new tries.
    if ((user.locked_until || 0) <= now()) run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
    if (user.totp_enabled) return { twoFactor: true, ticket: issueTicket(user.id) };
    startSession(user, req, reply);
    return { user: selfUser(user) };
  });

  app.post('/api/auth/2fa', { config: { public: true, ...authLimit } }, async (req, reply) => {
    const t = tickets.get(String(req.body?.ticket || ''));
    if (!t || t.expires < now()) fail(401, 'زمان ورود تمام شد؛ دوباره نام کاربری و رمز را وارد کنید');
    const user = get('SELECT * FROM users WHERE id = ?', t.userId);
    if (!user || user.banned) fail(403, 'حساب شما مسدود شده است');
    const code = String(req.body?.code || '');
    const step = checkTotp(user.totp_secret, code, user.totp_last_step);
    if (step) {
      run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    } else {
      const left = useRecoveryCode(parseJSON(user.recovery_codes, []), code);
      if (!left) {
        if (++t.attempts >= 5) tickets.delete(req.body.ticket);
        noteFailedLogin(user, req);
        noteLoginFailure(req.ip, user.username);
        fail(401, 'کد اشتباه است');
      }
      run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(left), user.id);
      audit(user.id, 'user.recovery_code_used', user.id, { left: left.length });
    }
    tickets.delete(req.body.ticket);
    startSession(user, req, reply);
    return { user: selfUser(user) };
  });

  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: selfUser(req.user) }));

  // Changing the password logs out every other device that knew the old one.
  app.post('/api/auth/password', { config: authLimit }, async (req) => {
    const { current, next } = req.body || {};
    if (!(await verifyPassword(String(current || ''), req.user.password_hash))) fail(400, 'رمز فعلی اشتباه است');
    const weak = passwordProblem(next, req.user.username);
    if (weak) fail(400, weak);
    if (next === current) fail(400, 'رمز جدید با رمز فعلی یکی است');
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), req.user.id);
    const loggedOut = revokeSessions(req.user.id, { except: req.user.session_id });
    audit(req.user.id, 'user.password_changed', req.user.id, { loggedOut });
    return { ok: true, loggedOut };
  });

  app.patch('/api/me', async (req) => {
    const { displayName, bio, avatar } = req.body || {};
    const u = req.user;
    if (displayName !== undefined) {
      const name = String(displayName).trim().slice(0, 64);
      if (!name) fail(400, 'نام نمایشی خالی است');
      run('UPDATE users SET display_name = ? WHERE id = ?', name, u.id);
    }
    if (bio !== undefined) run('UPDATE users SET bio = ? WHERE id = ?', String(bio).slice(0, 300), u.id);
    if (avatar !== undefined) {
      if (avatar !== null) {
        const f = get("SELECT * FROM files WHERE id = ? AND owner_id = ? AND kind = 'image'", avatar, u.id);
        if (!f) fail(400, 'تصویر نامعتبر است');
      }
      run('UPDATE users SET avatar_file_id = ? WHERE id = ?', avatar, u.id);
    }
    return { user: selfUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  // People you share a chat with: by part of the name. Anyone else: only by the exact username.
  app.get('/api/users/search', async (req) => {
    const q = String(req.query.q || '').trim();
    if (!q) return { users: [] };
    spendLookup(req.user, 'search');
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    let users;
    if (isUserStaff(req.user)) {
      users = all(
        `SELECT * FROM users WHERE banned = 0 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
         ORDER BY username LIMIT 20`,
        like,
        like,
      );
    } else {
      users = searchAcquaintances(req.user.id, like);
      const exact = get('SELECT * FROM users WHERE banned = 0 AND lower(username) = lower(?) AND id != ?', q.replace(/^@/, ''), req.user.id);
      if (exact && !users.some((u) => u.id === exact.id)) users.unshift(exact);
    }
    return { users: users.map((u) => ({ ...publicUser(u), online: isOnline(u.id) })) };
  });

  app.get('/api/users/:id', async (req) => {
    const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    // A profile by its number only for people you share a chat with (no walking through ids).
    if (!u || (u.id !== req.user.id && !isUserStaff(req.user) && !knowsUser(req.user.id, u.id))) fail(404, 'کاربر پیدا نشد');
    return { user: { ...publicUser(u), online: isOnline(u.id), banned: !!u.banned } };
  });
}
