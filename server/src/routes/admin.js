import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, all, run, now, parseJSON, DATA_DIR } from '../db.js';
import { DEFAULTS, getAllSettings, setSetting } from '../settings.js';
import { hasSitePerm, cleanPerms, SITE_PERMS } from '../perms.js';
import { hashPassword, randomCode, publicUser } from '../auth.js';
import { online, isOnline, disconnectUser } from '../realtime.js';
import { fail, audit, loadMessage } from '../chats.js';
import { ffmpegAvailable } from '../media.js';
import { effectiveLimits, cleanLimits } from '../limits.js';
import { deleteMessage } from '../sweeper.js';
import { kickEverywhere } from '../voice.js';
import { series, recentAlerts, sample, netIsHostWide } from '../health.js';
import { certInfo, checkCert, domainDnsInfo, checkDomainDns } from '../certcheck.js';
import { mirrorStatus } from '../backup.js';

const need = (req, perm) => {
  if (!hasSitePerm(req.user, perm)) fail(403, 'دسترسی ندارید');
};

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
        locked: !!(u.locked_until && u.locked_until > now()),
        createdAt: u.created_at,
        online: isOnline(u.id),
      })),
    };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    if (req.user.role !== 'owner') fail(403, 'فقط مالک می‌تواند نقش‌ها را تغییر دهد');
    const u = targetUser(req.params.id);
    if (u.id === req.user.id) fail(400, 'نقش خودتان را نمی‌توانید تغییر دهید');
    const role = req.body?.role === 'admin' ? 'admin' : 'user';
    const perms = role === 'admin' ? cleanPerms(req.body?.adminPerms, SITE_PERMS) : [];
    run('UPDATE users SET role = ?, admin_perms = ? WHERE id = ?', role, JSON.stringify(perms), u.id);
    audit(req.user.id, 'user.role', u.id, { role, perms });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/ban', async (req) => {
    need(req, 'manage_users');
    const u = targetUser(req.params.id);
    assertOutranks(req.user, u);
    const banned = req.body?.banned !== false;
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
    const code = randomCode(9);
    run(
      'INSERT INTO invites (code, created_by, max_uses, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      code,
      req.user.id,
      Number(maxUses) > 0 ? Number(maxUses) : null,
      Number(expiresInHours) > 0 ? now() + Number(expiresInHours) * 3600 * 1000 : null,
      String(note || '').slice(0, 200),
      now(),
    );
    audit(req.user.id, 'invite.create', code);
    return { invite: get('SELECT * FROM invites WHERE code = ?', code) };
  });

  app.delete('/api/admin/invites/:id', async (req) => {
    need(req, 'manage_invites');
    run('DELETE FROM invites WHERE id = ?', Number(req.params.id));
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
    const b = req.body || {};
    for (const key of Object.keys(b)) {
      // Telegram and security settings have their own checked routes (security ones: owner only).
      if (!(key in DEFAULTS) || /^(tele|sec)_/.test(key)) continue;
      if (b[key] !== null && typeof b[key] === 'object') fail(400, 'مقدار نامعتبر');
      let v = String(b[key]);
      if (key === 'registration_mode' && !['open', 'invite', 'closed'].includes(v)) fail(400, 'حالت ثبت‌نام نامعتبر');
      if (key === 'allow_user_groups' || key === 'discover_list') v = v === '1' || v === 'true' ? '1' : '0';
      if (['default_can_call', 'default_can_stream'].includes(key)) v = v === '1' || v === 'true' ? '1' : '0';
      if (key === 'max_stream_quality' && !['480', '720', '1080'].includes(v)) fail(400, 'کیفیت نامعتبر');
      if (key === 'max_stream_fps' && !['30', '60'].includes(v)) fail(400, 'نرخ فریم نامعتبر');
      if (['max_upload_mb', 'user_quota_mb', 'media_retention_days', 'max_streams_per_room'].includes(key)) {
        const n = Number(b[key]);
        if (typeof b[key] === 'object' || !Number.isFinite(n)) fail(400, 'عدد نامعتبر');
        v = String(Math.max(key === 'max_upload_mb' ? 1 : 0, Math.min(100000, Math.floor(n))));
      }
      if (key === 'site_name') v = v.trim().slice(0, 50) || DEFAULTS.site_name;
      setSetting(key, v);
    }
    audit(req.user.id, 'settings.update', '', b);
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
    const action = req.body?.action === 'delete' ? 'delete' : 'dismiss';
    if (action === 'delete') {
      const m = get('SELECT * FROM messages WHERE id = ?', r.message_id);
      if (m && !m.deleted) deleteMessage(m);
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
        `SELECT c.id, c.type, c.title, c.is_public AS isPublic, c.is_emergency AS isEmergency, c.created_at AS createdAt,
           (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) AS memberCount,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messageCount
           , EXISTS (SELECT 1 FROM chat_members me WHERE me.chat_id = c.id AND me.user_id = ?) AS isMember
         FROM chats c WHERE c.type IN ('group', 'channel', 'voice') ORDER BY c.id DESC LIMIT 1000`,
        req.user.id,
      ).map((c) => ({ ...c, isMember: !!c.isMember, isPublic: !!c.isPublic, isEmergency: !!c.isEmergency })),
    };
  });
}
