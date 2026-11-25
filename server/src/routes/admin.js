import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, all, run, tx, now, parseJSON, DATA_DIR } from '../db.js';
import { DEFAULTS, getAllSettings, setSetting } from '../settings.js';
import { hasSitePerm, cleanPerms, SITE_PERMS } from '../perms.js';
import { hashPassword, randomCode, publicUser } from '../auth.js';
import { online, isOnline, disconnectUser } from '../realtime.js';
import { fail, audit, loadMessage } from '../chats.js';
import { ffmpegAvailable } from '../media.js';
import { effectiveLimits, cleanLimits, RESTRICT_KINDS, restrictionUntil } from '../limits.js';
import { filesOf } from './storage.js';
import { deleteMessage } from '../sweeper.js';
import { kickEverywhere } from '../voice.js';
import { series, recentAlerts, sample, netIsHostWide } from '../health.js';
import { certInfo, checkCert, domainDnsInfo, checkDomainDns } from '../certcheck.js';
import { mirrorStatus } from '../backup.js';

const need = (req, perm) => {
  if (!hasSitePerm(req.user, perm)) fail(403, 'دسترسی ندارید');
};

// A number or a numeric string; anything else (empty, true, [5], {}) is NaN, not 0 or 1.
const numOf = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);

// [min, max] of the numeric site settings (whole numbers).
const NUMERIC_SETTINGS = {
  max_upload_mb: [1, 100000],
  user_quota_mb: [0, 100000],
  media_retention_days: [0, 100000],
  max_streams_per_room: [0, 100000],
  deleted_keep_days: [0, 36500],
};
const BOOL_SETTINGS = ['allow_user_groups', 'discover_list', 'default_can_call', 'default_can_stream'];

// The stored string for one general setting, or a 400. `raw` is a string, number or boolean.
function settingValue(key, raw) {
  const v = String(raw);
  if (key === 'site_name') {
    if (typeof raw !== 'string') fail(400, 'نام سرور نامعتبر است');
    return v.trim().slice(0, 50) || DEFAULTS.site_name;
  }
  if (key === 'registration_mode') {
    if (!['open', 'invite', 'closed'].includes(v)) fail(400, 'حالت ثبت‌نام نامعتبر');
    return v;
  }
  if (BOOL_SETTINGS.includes(key)) {
    if ([true, 1, '1', 'true'].includes(raw)) return '1';
    if ([false, 0, '0', 'false'].includes(raw)) return '0';
    fail(400, 'مقدار بله/خیر نامعتبر');
  }
  if (key === 'max_stream_quality') {
    if (typeof raw === 'boolean' || !['480', '720', '1080'].includes(v)) fail(400, 'کیفیت نامعتبر');
    return v;
  }
  if (key === 'max_stream_fps') {
    if (typeof raw === 'boolean' || !['30', '60'].includes(v)) fail(400, 'نرخ فریم نامعتبر');
    return v;
  }
  if (key in NUMERIC_SETTINGS) {
    const [min, max] = NUMERIC_SETTINGS[key];
    const n = numOf(raw);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, `عدد نامعتبر؛ باید بین ${min} و ${max} باشد`);
    return String(Math.floor(n));
  }
  // mirror_files_access has its own checked route (access list + mode).
  fail(400, 'این تنظیم از این‌جا تغییر نمی‌کند');
}

const targetUser = (id) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(id));
  if (!u) fail(404, 'کاربر پیدا نشد');
  return u;
};

// Admins can act on regular users; only the owner can act on admins.
const assertOutranks = (actor, target) => {
  if (target.role === 'owner' || (target.role === 'admin' && actor.role !== 'owner')) {
    fail(403, 'روی این کاربر دسترسی ندارید');
  }
};

export default async function adminRoutes(app) {
  app.get('/api/admin/users', async (req) => {
    need(req, 'manage_users');
    const q = String(req.query.q || '').trim();
    const like = `%${q}%`;
    const rows = all(
      `SELECT * FROM users WHERE (? = '' OR username LIKE ? OR display_name LIKE ?)
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id DESC LIMIT 500`,
      q,
      like,
      like,
    );
    return {
      users: rows.map((u) => ({
        ...publicUser(u),
        adminPerms: parseJSON(u.admin_perms, []),
        overrides: parseJSON(u.limits, {}),
        limits: effectiveLimits(u),
        banned: !!u.banned,
        twoFactor: !!u.totp_enabled,
        restricted: RESTRICT_KINDS.some((k) => restrictionUntil(u, k)),
        locked: !!(u.locked_until && u.locked_until > now()),
        createdAt: u.created_at,
        online: isOnline(u.id),
        lastSeen: u.last_seen,
      })),
    };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    if (req.user.role !== 'owner') fail(403, 'فقط مالک می‌تواند نقش‌ها را تغییر دهد');
    const u = targetUser(req.params.id);
    if (u.id === req.user.id) fail(400, 'نقش خودتان را نمی‌توانید تغییر دهید');
    const b = req.body || {};
    // A typo or a missing role must not quietly turn an admin into a regular user. Only the
    // permissions given: the role stays as it is.
    if (b.role !== undefined && b.role !== 'admin' && b.role !== 'user') fail(400, 'نقش نامعتبر است');
    if (b.role === undefined && b.adminPerms === undefined) fail(400, 'نقش یا دسترسی‌ها مشخص نشده است');
    const role = b.role ?? u.role;
    if (role !== 'admin' && b.role === undefined) fail(400, 'این کاربر مدیر نیست');
    if (b.adminPerms !== undefined && !Array.isArray(b.adminPerms)) fail(400, 'دسترسی‌ها نامعتبر است');
    const perms = role === 'admin' ? cleanPerms(b.adminPerms ?? parseJSON(u.admin_perms, []), SITE_PERMS) : [];
    run('UPDATE users SET role = ?, admin_perms = ? WHERE id = ?', role, JSON.stringify(perms), u.id);
    audit(req.user.id, 'user.role', u.id, { role, perms });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/ban', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    assertOutranks(req.user, u);
    // Strictly true / false ("false" or 0 must not ban); left out = ban, as before.
    const banned = req.body?.banned === undefined ? true : req.body.banned;
    if (typeof banned !== 'boolean') fail(400, 'مقدار banned باید true یا false باشد');
    run('UPDATE users SET banned = ? WHERE id = ?', banned ? 1 : 0, u.id);
    if (banned) {
      run('DELETE FROM sessions WHERE user_id = ?', u.id);
      disconnectUser(u.id);
      kickEverywhere(u.id);
    }
    audit(req.user.id, banned ? 'user.ban' : 'user.unban', u.id, { username: u.username });
    return { ok: true };
  });

  // Per-user overrides of upload size, quota, calling and streaming. Missing keys = site default.
  app.patch('/api/admin/users/:id/limits', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    if (u.role === 'owner') fail(400, 'مالک محدودیتی ندارد');
    if (u.role === 'admin' && req.user.role !== 'owner') fail(403, 'فقط مالک محدودیت ادمین‌ها را تغییر می‌دهد');
    const overrides = cleanLimits(req.body || {});
    run('UPDATE users SET limits = ? WHERE id = ?', JSON.stringify(overrides), u.id);
    audit(req.user.id, 'user.limits', u.id, overrides);
    return { overrides, limits: effectiveLimits(get('SELECT * FROM users WHERE id = ?', u.id)) };
  });

  // Everything about one user in one place.
  app.get('/api/admin/users/:id/overview', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    if (u.id !== req.user.id) assertOutranks(req.user, u);
    const stored = parseJSON(u.restrictions, {});
    const restrictions = {};
    for (const k of RESTRICT_KINDS) if (restrictionUntil(u, k)) restrictions[k] = stored[k];
    return {
      messages: get('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND deleted = 0', u.id).n,
      lastMessageAt: get('SELECT MAX(created_at) AS t FROM messages WHERE sender_id = ?', u.id).t,
      chats: get('SELECT COUNT(*) AS n FROM chat_members WHERE user_id = ?', u.id).n,
      files: filesOf(u.id),
      // The channels and groups registered to them.
      rooms: all(
        `SELECT c.id, c.type, c.title, c.handle, cm.role, (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) AS memberCount
           FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
          WHERE cm.user_id = ? AND cm.role IN ('owner', 'admin') AND c.type IN ('group', 'channel', 'voice')
          ORDER BY cm.role = 'owner' DESC, memberCount DESC LIMIT 200`,
        u.id,
      ),
      sessions: all('SELECT user_agent, ip, last_seen FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 10', u.id).map((s) => ({
        userAgent: s.user_agent,
        ip: s.ip,
        lastSeen: s.last_seen,
      })),
      reports: get('SELECT COUNT(*) AS n FROM reports r JOIN messages m ON m.id = r.message_id WHERE m.sender_id = ?', u.id).n,
      history: all(
        `SELECT a.action, a.created_at, x.display_name AS actor FROM audit_log a LEFT JOIN users x ON x.id = a.actor_id
          WHERE a.target = ? ORDER BY a.id DESC LIMIT 10`,
        String(u.id),
      ).map((a) => ({ action: a.action, at: a.created_at, actor: a.actor })),
      restrictions,
      reason: Object.keys(restrictions).length ? stored.reason || '' : '',
    };
  });

  // Hours per kind; 0 lifts it, a kind left out stays as it is.
  app.post('/api/admin/users/:id/restrict', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    assertOutranks(req.user, u);
    const b = req.body || {};
    const next = parseJSON(u.restrictions, {});
    // Checked first: a bad value must not lift a restriction (it used to count as 0).
    const hoursOf = {};
    for (const k of RESTRICT_KINDS) {
      if (b[k] === undefined) continue;
      const n = numOf(b[k]);
      if (!Number.isFinite(n) || n < 0) fail(400, 'مدت محدودیت باید عدد ساعت باشد (۰ = برداشتن)');
      hoursOf[k] = Math.min(8760, n);
    }
    for (const [k, hours] of Object.entries(hoursOf)) {
      if (hours) next[k] = now() + hours * 3600000;
      else delete next[k];
    }
    if (b.reason !== undefined) next.reason = String(b.reason).trim().slice(0, 200);
    run('UPDATE users SET restrictions = ? WHERE id = ?', JSON.stringify(next), u.id);
    audit(req.user.id, 'user.restrict', u.id, next);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    assertOutranks(req.user, u);
    const password = randomCode(8);
    run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', await hashPassword(password), u.id);
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    disconnectUser(u.id);
    audit(req.user.id, 'user.reset_password', u.id, { username: u.username });
    return { password };
  });

  // --- Signup invites ---
  app.get('/api/admin/invites', async (req) => {
    need(req, 'manage_invites');
    return {
      invites: all(
        `SELECT i.*, u.display_name AS creator FROM invites i LEFT JOIN users u ON u.id = i.created_by
         ORDER BY i.created_at DESC LIMIT 500`,
      ),
    };
  });

  app.post('/api/admin/invites', async (req) => {
    need(req, 'manage_invites');
    const { maxUses, expiresInHours, note } = req.body || {};
    // Left out, empty or 0 = no limit; anything else must be a sensible number.
    const unset = (v) => v === undefined || v === null || v === '' || Number(v) === 0;
    const uses = unset(maxUses) ? null : numOf(maxUses);
    if (uses !== null && !(Number.isInteger(uses) && uses > 0 && uses <= 1000000)) fail(400, 'تعداد استفاده باید عدد صحیح مثبت باشد');
    const hours = unset(expiresInHours) ? null : numOf(expiresInHours);
    if (hours !== null && !(Number.isFinite(hours) && hours > 0 && hours <= 87600)) fail(400, 'اعتبار باید بین ۰ و ۸۷۶۰۰ ساعت باشد');
    if (note != null && typeof note !== 'string') fail(400, 'یادداشت نامعتبر است');
    const code = randomCode(9);
    run(
      'INSERT INTO invites (code, created_by, max_uses, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      code,
      req.user.id,
      uses,
      hours === null ? null : now() + Math.round(hours * 3600 * 1000),
      (note || '').trim().slice(0, 200),
      now(),
    );
    audit(req.user.id, 'invite.create', code);
    return { invite: get('SELECT * FROM invites WHERE code = ?', code) };
  });

  app.delete('/api/admin/invites/:id', async (req) => {
    need(req, 'manage_invites');
    if (!run('DELETE FROM invites WHERE id = ?', Number(req.params.id)).changes) fail(404, 'کد دعوت پیدا نشد');
    audit(req.user.id, 'invite.delete', req.params.id);
    return { ok: true };
  });

  // --- Settings ---
  app.get('/api/admin/settings', async (req) => {
    need(req, 'manage_settings');
    return { settings: getAllSettings() };
  });

  app.patch('/api/admin/settings', async (req) => {
    need(req, 'manage_settings');
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail(400, 'تنظیمات نامعتبر است');
    const current = getAllSettings();
    // Every key is checked before anything is written: one bad field refuses the whole save
    // instead of keeping the fields before it.
    const changes = {};
    for (const key of Object.keys(b)) {
      // Telegram and security settings have their own checked routes (security ones: owner only).
      if (!(key in DEFAULTS) || /^(tele|sec)_/.test(key)) continue;
      const raw = b[key];
      // The whole form comes back on save: a field it did not touch is no change.
      if (typeof raw === 'string' && raw === current[key]) continue;
      if (raw === null || typeof raw === 'object') fail(400, 'مقدار نامعتبر');
      changes[key] = settingValue(key, raw);
    }
    const keys = Object.keys(changes).filter((k) => changes[k] !== current[k]);
    if (keys.length) {
      tx(() => {
        for (const k of keys) setSetting(k, changes[k]);
      });
      audit(req.user.id, 'settings.update', '', Object.fromEntries(keys.map((k) => [k, changes[k]])));
    }
    return { settings: getAllSettings() };
  });

  // --- Audit log & stats ---
  app.get('/api/admin/audit', async (req) => {
    need(req, 'view_audit');
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    return {
      entries: all(
        `SELECT a.*, u.display_name AS actor_name, u.username AS actor_username
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.id < ? ORDER BY a.id DESC LIMIT 100`,
        before,
      ),
    };
  });

  // Health dashboard: current values, history for the charts, alerts.
  app.get('/api/admin/health', async (req) => {
    need(req, 'view_audit');
    // HTTPS certificate (null when not behind the bundled Caddy); ?cert=1 checks again now.
    // First, so an alert it raises is already in the list below.
    const cert = req.query.cert || (!certInfo() && process.env.DOMAIN) ? await checkCert() : certInfo();
    const dns = req.query.cert || (!domainDnsInfo() && process.env.DOMAIN) ? await checkDomainDns().catch(() => null) : domainDnsInfo();
    return {
      now: await sample(),
      series: series(String(req.query.range || '24h')),
      alerts: recentAlerts(),
      netHostWide: netIsHostWide(),
      mirror: mirrorStatus(),
      cert,
      dns,
    };
  });

  app.get('/api/admin/stats', async (req) => {
    need(req, 'view_audit');
    let disk = null;
    try {
      const s = fs.statfsSync(DATA_DIR);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* statfs not supported on this platform */
    }
    let dbSize = 0;
    for (const f of ['amorechat.db', 'amorechat.db-wal']) {
      try {
        dbSize += fs.statSync(path.join(DATA_DIR, f)).size;
      } catch {
        /* file may not exist */
      }
    }
    const count = (sql) => get(sql).n;
    return {
      users: count('SELECT COUNT(*) AS n FROM users'),
      online: [...online.values()].filter((n) => n > 0).length,
      chats: count("SELECT COUNT(*) AS n FROM chats WHERE type IN ('group', 'channel')"),
      messages: count('SELECT COUNT(*) AS n FROM messages'),
      uploadsBytes: get('SELECT IFNULL(SUM(size), 0) AS n FROM files').n,
      dbBytes: dbSize,
      disk,
      memory: { total: os.totalmem(), free: os.freemem(), process: process.memoryUsage().rss },
      load: os.loadavg(),
      cpus: os.cpus().length,
      uptime: process.uptime(),
      ffmpeg: ffmpegAvailable,
      openReports: count("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    };
  });

  // --- Reported messages ---
  app.get('/api/admin/reports', async (req) => {
    need(req, 'handle_reports');
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    const rows = all(
      `SELECT r.*, u.display_name AS reporter_name, c.title AS chat_title, c.type AS chat_type, m.chat_id
       FROM reports r
       JOIN users u ON u.id = r.reporter_id
       JOIN messages m ON m.id = r.message_id
       JOIN chats c ON c.id = m.chat_id
       WHERE ${status === 'open' ? "r.status = 'open'" : "r.status != 'open'"}
       ORDER BY r.id DESC LIMIT 200`,
    );
    return {
      reports: rows.map((r) => ({
        id: r.id,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
        reporter: r.reporter_name,
        chat: { id: r.chat_id, title: r.chat_type === 'dm' ? 'پیام خصوصی' : r.chat_title, type: r.chat_type },
        message: loadMessage(r.message_id),
      })),
    };
  });

  app.post('/api/admin/reports/:id', async (req) => {
    need(req, 'handle_reports');
    const r = get('SELECT * FROM reports WHERE id = ?', Number(req.params.id));
    if (!r) fail(404, 'گزارش پیدا نشد');
    const action = req.body?.action;
    if (action !== 'delete' && action !== 'dismiss') fail(400, 'کار نامعتبر است');
    if (r.status !== 'open') fail(409, 'این گزارش قبلاً بررسی شده است');
    if (action === 'delete') {
      const m = get('SELECT * FROM messages WHERE id = ?', r.message_id);
      if (m && !m.deleted) deleteMessage(m, { by: req.user.id });
    }
    // Close every open report about the same message at once.
    run(
      "UPDATE reports SET status = ?, handled_by = ? WHERE message_id = ? AND status = 'open'",
      action === 'delete' ? 'deleted' : 'dismissed',
      req.user.id,
      r.message_id,
    );
    audit(req.user.id, action === 'delete' ? 'report.delete' : 'report.dismiss', r.message_id);
    return { ok: true };
  });

  app.get('/api/admin/chats', async (req) => {
    need(req, 'manage_chats');
    return {
      chats: all(
        `SELECT c.id, c.type, c.title, c.handle, c.is_public AS isPublic, c.is_emergency AS isEmergency, c.created_at AS createdAt,
           o.id AS ownerId, o.display_name AS ownerName, o.username AS ownerUsername,
           EXISTS (SELECT 1 FROM tele_mirrors t WHERE t.chat_id = c.id) AS fromTelegram,
           (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) AS memberCount,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount
           , EXISTS (SELECT 1 FROM chat_members me WHERE me.chat_id = c.id AND me.user_id = ?) AS isMember
         FROM chats c
         LEFT JOIN chat_members om ON om.chat_id = c.id AND om.role = 'owner'
         LEFT JOIN users o ON o.id = om.user_id
         WHERE c.type IN ('group', 'channel', 'voice') GROUP BY c.id ORDER BY c.id DESC LIMIT 1000`,
        req.user.id,
      ).map((c) => ({ ...c, handle: c.handle || '', fromTelegram: !!c.fromTelegram, isMember: !!c.isMember, isPublic: !!c.isPublic, isEmergency: !!c.isEmergency })),
    };
  });
}
