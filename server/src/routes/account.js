import { get, all, run, parseJSON } from '../db.js';
import { getSetting } from '../settings.js';
import { verifyPassword, revokeSessions, selfUser } from '../auth.js';
import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import { disconnectSessions } from '../realtime.js';
import { newTotpSecret, checkTotp, otpauthUri, newRecoveryCodes, deviceName } from '../security.js';

const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

async function requirePassword(req) {
  if (!(await verifyPassword(String(req.body?.password || ''), req.user.password_hash))) fail(400, 'رمز عبور اشتباه است');
}

export default async function accountRoutes(app) {
  // ---------- Logged-in devices ----------
  app.get('/api/me/sessions', async (req) => ({
    sessions: all('SELECT id, user_agent, ip, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', req.user.id).map((s) => ({
      id: s.id,
      device: deviceName(s.user_agent),
      ip: s.ip,
      createdAt: s.created_at,
      lastSeen: s.last_seen,
      current: s.id === req.user.session_id,
    })),
  }));

  app.delete('/api/me/sessions/:id', async (req) => {
    const s = get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', String(req.params.id), req.user.id);
    if (!s) fail(404, 'این دستگاه پیدا نشد');
    run('DELETE FROM sessions WHERE id = ?', s.id);
    disconnectSessions([s.id]);
    audit(req.user.id, 'user.session_revoked', req.user.id, { session: s.id });
    return { ok: true };
  });

  app.post('/api/me/sessions/revoke-others', async (req) => {
    const n = revokeSessions(req.user.id, { except: req.user.session_id });
    audit(req.user.id, 'user.sessions_revoked', req.user.id, { count: n });
    return { loggedOut: n };
  });

  // ---------- Two-step login (TOTP) ----------
  // 1) setup: new secret (not active yet), shown as a QR code to scan
  app.post('/api/me/2fa/setup', strict, async (req) => {
    await requirePassword(req);
    if (req.user.totp_enabled) fail(400, 'ورود دومرحله‌ای از قبل فعال است');
    const secret = newTotpSecret();
    run('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?', secret, req.user.id);
    return { secret, uri: otpauthUri(req.user.username, secret, getSetting('site_name')) };
  });

  // 2) enable: prove the app produces valid codes; returns one-time recovery codes
  app.post('/api/me/2fa/enable', strict, async (req) => {
    const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (u.totp_enabled) fail(400, 'ورود دومرحله‌ای از قبل فعال است');
    if (!u.totp_secret) fail(400, 'ابتدا راه‌اندازی را شروع کنید');
    const step = checkTotp(u.totp_secret, req.body?.code);
    if (!step) fail(400, 'کد درست نیست؛ ساعت گوشی را بررسی کنید و کد جدید را وارد کنید');
    const { codes, hashes } = newRecoveryCodes();
    run('UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?', step, JSON.stringify(hashes), u.id);
    // Other devices logged in before this must sign in again with the second step.
    const loggedOut = revokeSessions(u.id, { except: req.user.session_id });
    audit(u.id, 'user.2fa_enabled', u.id, { loggedOut });
    return { recoveryCodes: codes, user: selfUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  app.post('/api/me/2fa/disable', strict, async (req) => {
    await requirePassword(req);
    const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!u.totp_enabled) fail(400, 'ورود دومرحله‌ای فعال نیست');
    if (!checkTotp(u.totp_secret, req.body?.code, u.totp_last_step)) fail(400, 'کد برنامه احراز هویت درست نیست');
    run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]' WHERE id = ?", u.id);
    audit(u.id, 'user.2fa_disabled', u.id);
    return { user: selfUser(get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  app.get('/api/me/2fa', async (req) => ({
    enabled: !!req.user.totp_enabled,
    recoveryCodesLeft: parseJSON(req.user.recovery_codes, []).length,
  }));

  // ---------- Admin helpers for locked-out users ----------
  const target = (req) => {
    if (!hasSitePerm(req.user, 'manage_users')) fail(403, 'دسترسی ندارید');
    const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
    if (!u) fail(404, 'کاربر پیدا نشد');
    if (u.role === 'owner' || (u.role === 'admin' && req.user.role !== 'owner')) fail(403, 'روی این کاربر دسترسی ندارید');
    return u;
  };

  app.post('/api/admin/users/:id/reset-2fa', async (req) => {
    const u = target(req);
    run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]', locked_until = NULL, failed_logins = 0 WHERE id = ?", u.id);
    audit(req.user.id, 'user.2fa_reset', u.id, { username: u.username });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/logout-all', async (req) => {
    const u = target(req);
    const n = revokeSessions(u.id);
    audit(req.user.id, 'user.logout_all', u.id, { count: n });
    return { loggedOut: n };
  });
}
