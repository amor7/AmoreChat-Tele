/**
 * Security watch: failed logins per IP, banned IPs, and security alerts to the owner (a system
 * message in the owner's Saved Messages, with the usual notification).
 *  - many wrong passwords from one IP (with the IP, so it can be banned in the admin panel)
 *  - an admin / owner logs in from an IP they never used before
 *  - roles or admin permissions change, an account gets locked, an admin resets a password
 * Banned IPs get no answer from the server at all (except a short "banned" page).
 */
import net from 'node:net';
import { get, all, run, now } from './db.js';
import { getSetting, setSetting } from './settings.js';
import { ensureSavedChat, systemMessage, onAudit } from './chats.js';

const WINDOW_MS = 15 * 60 * 1000;

export function secSettings() {
  return {
    alerts: getSetting('sec_alerts') === '1',
    // This many wrong passwords from one IP within 15 minutes → alert (and ban, if auto-ban is on).
    threshold: Math.max(3, Math.min(1000, Number(getSetting('sec_fail_threshold')) || 10)),
    autoBan: getSetting('sec_auto_ban') === '1',
    // Minutes an automatic ban lasts; 0 = until unbanned by hand.
    autoBanMinutes: Math.max(0, Math.min(525600, Number(getSetting('sec_auto_ban_minutes')) || 0)),
  };
}
export function setSecSettings(p = {}) {
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  if (p.alerts != null) setSetting('sec_alerts', p.alerts ? '1' : '0');
  if (p.autoBan != null) setSetting('sec_auto_ban', p.autoBan ? '1' : '0');
  if (p.threshold != null) {
    if (!Number.isInteger(p.threshold) || p.threshold < 3 || p.threshold > 1000) throw bad('تعداد تلاش باید بین ۳ و ۱۰۰۰ باشد');
    setSetting('sec_fail_threshold', String(p.threshold));
  }
  if (p.autoBanMinutes != null) {
    if (!Number.isInteger(p.autoBanMinutes) || p.autoBanMinutes < 0 || p.autoBanMinutes > 525600) throw bad('مدت بن نامعتبر است');
    setSetting('sec_auto_ban_minutes', String(p.autoBanMinutes));
  }
  return secSettings();
}

/** To the owner(s), in Saved Messages; only when security alerts are on (or `force`). */
export function securityAlert(text, { force = false } = {}) {
  if (!force && !secSettings().alerts) return 0;
  const owners = all("SELECT id FROM users WHERE role = 'owner' AND banned = 0");
  for (const o of owners) systemMessage(ensureSavedChat(o.id), `🛡️ امنیت · ${text}`);
  return owners.length;
}

// ---------- Banned IPs ----------
// A plain IPv4 / IPv6 address (IPv4-mapped IPv6 is stored as IPv4).
export function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : '';
}
let banCache = null;
function bans() {
  if (!banCache) {
    banCache = new Map(all('SELECT ip, expires_at FROM ip_bans').map((b) => [b.ip, b.expires_at]));
  }
  return banCache;
}
export function isBanned(ip) {
  const key = normalizeIp(ip);
  if (!key) return false;
  const exp = bans().get(key);
  if (exp === undefined) return false;
  if (exp && exp < now()) {
    run('DELETE FROM ip_bans WHERE ip = ?', key);
    banCache = null;
    return false;
  }
  return true;
}
export function banIp(ip, { by = null, reason = '', minutes = 0 } = {}) {
  const key = normalizeIp(ip);
  if (!key) throw Object.assign(new Error('آی‌پی نامعتبر است'), { statusCode: 400 });
  run(
    `INSERT INTO ip_bans (ip, reason, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    key, String(reason).slice(0, 200), by, now(), minutes > 0 ? now() + minutes * 60000 : null,
  );
  banCache = null;
  return key;
}
export function unbanIp(ip) {
  const key = normalizeIp(ip);
  run('DELETE FROM ip_bans WHERE ip = ?', key);
  banCache = null;
}
export const listBans = () =>
  all('SELECT b.*, u.display_name AS by_name FROM ip_bans b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.created_at DESC')
    .filter((b) => !b.expires_at || b.expires_at > now())
    .map((b) => ({ ip: b.ip, reason: b.reason, by: b.by_name || 'خودکار', createdAt: b.created_at, expiresAt: b.expires_at }));

// ---------- Failed logins ----------
export function noteLoginFailure(ip, username) {
  const key = normalizeIp(ip) || String(ip || '?');
  run('INSERT INTO auth_failures (ip, username, at) VALUES (?, ?, ?)', key, String(username || '').slice(0, 64), now());
  const s = secSettings();
  const recent = get('SELECT COUNT(*) AS n FROM auth_failures WHERE ip = ? AND at > ?', key, now() - WINDOW_MS).n;
  if (recent < s.threshold) return;
  // Once per IP per window: the counter keeps rising while the attack goes on.
  const flagged = get('SELECT 1 FROM auth_flags WHERE ip = ? AND at > ?', key, now() - WINDOW_MS);
  if (flagged) return;
  run('INSERT INTO auth_flags (ip, at) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET at = excluded.at', key, now());
  const names = all('SELECT DISTINCT username FROM auth_failures WHERE ip = ? AND at > ? LIMIT 5', key, now() - WINDOW_MS).map((r) => r.username).filter(Boolean);
  let banned = false;
  if (s.autoBan && normalizeIp(key)) {
    banIp(key, { reason: `${recent} رمز اشتباه در ۱۵ دقیقه`, minutes: s.autoBanMinutes });
    banned = true;
  }
  securityAlert(
    `${recent} تلاش ناموفق ورود در ۱۵ دقیقه از آی‌پی ${key}${names.length ? ` (برای: ${names.join('، ')})` : ''}. ${banned ? 'این آی‌پی خودکار بن شد.' : 'برای بن کردن: پنل مدیریت ← امنیت.'}`,
  );
}

/** Attempts per IP in the last days, most first (for the admin panel). */
export function failureSummary(days = 7) {
  return all(
    `SELECT ip, COUNT(*) AS count, MAX(at) AS last, GROUP_CONCAT(DISTINCT username) AS names
     FROM auth_failures WHERE at > ? GROUP BY ip ORDER BY count DESC, last DESC LIMIT 100`,
    now() - days * 86400000,
  ).map((r) => ({ ip: r.ip, count: r.count, last: r.last, usernames: String(r.names || '').split(',').filter(Boolean).slice(0, 10), banned: isBanned(r.ip) }));
}

// ---------- Logins of admins from new places ----------
/** Called on every successful login: remembers the IP; an admin's first login from it is reported. */
export function noteLogin(user, ip, device) {
  const key = normalizeIp(ip) || String(ip || '?');
  const seen = get('SELECT 1 FROM login_ips WHERE user_id = ? AND ip = ?', user.id, key);
  const first = !get('SELECT 1 FROM login_ips WHERE user_id = ?', user.id);
  run(
    'INSERT INTO login_ips (user_id, ip, first_at, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, ip) DO UPDATE SET last_at = excluded.last_at',
    user.id, key, now(), now(),
  );
  if (!seen && !first && (user.role === 'owner' || user.role === 'admin')) {
    securityAlert(`${user.role === 'owner' ? 'مالک' : 'مدیر'} «${user.display_name}» (@${user.username}) از آی‌پی جدید ${key} وارد شد (${device}). اگر خودش نبوده، رمزش را عوض کنید و آی‌پی را بن کنید.`);
  }
}

// The client's IP of a realtime connection, the way the HTTP side sees it (proxies on loopback /
// private addresses are trusted, so the client is the last address before them).
const trusted = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i.test(ip);
export function handshakeIp(handshake) {
  const chain = [...String(handshake.headers['x-forwarded-for'] || '').split(',').map((s) => normalizeIp(s)).filter(Boolean), normalizeIp(handshake.address)];
  for (let i = chain.length - 1; i >= 0; i--) if (!trusted(chain[i]) || i === 0) return chain[i];
  return chain.at(-1) || '';
}

// Old records are not needed after a month.
export function pruneSecurity() {
  run('DELETE FROM auth_failures WHERE at < ?', now() - 30 * 86400000);
  run('DELETE FROM auth_flags WHERE at < ?', now() - WINDOW_MS);
  run('DELETE FROM ip_bans WHERE expires_at IS NOT NULL AND expires_at < ?', now());
  banCache = null;
}

// Admin actions worth telling the owner about (whoever did them, the owner sees it).
const name = (id) => {
  const u = id ? get('SELECT display_name, username FROM users WHERE id = ?', Number(id)) : null;
  return u ? `«${u.display_name}» (@${u.username})` : 'نامشخص';
};
onAudit((actorId, action, target, details) => {
  const d = typeof details === 'string' ? {} : details || {};
  // The owner knows what they did themselves.
  if (actorId && action !== 'user.locked' && get('SELECT role FROM users WHERE id = ?', Number(actorId))?.role === 'owner') return;
  if (action === 'user.role') securityAlert(`${name(actorId)} نقش ${name(target)} را به «${d.role}» تغییر داد${d.perms?.length ? ` (دسترسی‌ها: ${d.perms.join('، ')})` : ''}.`);
  else if (action === 'user.locked') securityAlert(`حساب ${name(target)} به خاطر رمزهای اشتباه پشت‌سرهم ۱۵ دقیقه قفل شد${d.ip ? ` (آخرین تلاش از ${d.ip})` : ''}.`);
  else if (action === 'user.reset_password') securityAlert(`${name(actorId)} رمز ${name(target)} را بازنشانی کرد.`);
  else if (action === 'security.ban' && d.manual) securityAlert(`${name(actorId)} آی‌پی ${target} را بن کرد.`);
  else if (action === 'security.unban') securityAlert(`${name(actorId)} بن آی‌پی ${target} را برداشت.`);
});
