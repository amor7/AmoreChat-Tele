import fs from 'node:fs';
import path from 'node:path';
import { db, get, all, now, DATA_DIR } from '../db.js';
import { hasSitePerm } from '../perms.js';
import { verifyPassword } from '../auth.js';
import { fail, audit } from '../chats.js';
import { purgeAndTell } from '../sweeper.js';
import { BACKUP_DIR } from '../backup.js';

// Storage management in the admin panel: who and what fills the disk, and removing it. Only names,
// sizes and owners: this page never opens a file, so it doesn't become a way to read private chats.
const DAY = 86400000;
const ends = (list) => list.map((e) => `lower(f.name) LIKE '%.${e}'`).join(' OR ');
const APPS = ['apk', 'apks', 'xapk', 'aab', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'ipa'];
const ARCHIVES = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'];
const DOCUMENTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub'];
export const CATEGORIES = ['image', 'video', 'music', 'voice', 'app', 'archive', 'document', 'other'];
export const CATEGORY = `CASE
  WHEN f.kind = 'image' OR f.mime LIKE 'image/%' THEN 'image'
  WHEN f.kind = 'video' THEN 'video'
  WHEN f.kind = 'audio' AND f.waveform IS NOT NULL THEN 'voice'
  WHEN f.kind = 'audio' THEN 'music'
  WHEN ${ends(APPS)} THEN 'app'
  WHEN ${ends(ARCHIVES)} THEN 'archive'
  WHEN ${ends(DOCUMENTS)} THEN 'document'
  ELSE 'other' END`;
// What a file takes on disk: the original and the other qualities of a video.
export const BYTES = `(f.size + IFNULL((SELECT SUM(json_extract(v.value, '$.size')) FROM json_each(f.variants) v), 0))`;
const AVATAR = `(EXISTS (SELECT 1 FROM users WHERE avatar_file_id = f.id) OR EXISTS (SELECT 1 FROM chats WHERE avatar_file_id = f.id))`;
// Uploaded and never sent, or left behind; a day's grace for a message still being written.
const UNUSED = `(f.created_at < ? AND NOT EXISTS (SELECT 1 FROM messages WHERE file_id = f.id AND deleted = 0)
  AND NOT EXISTS (SELECT 1 FROM deleted_messages WHERE file_id = f.id) AND NOT ${AVATAR})`;

const need = (req) => {
  if (!hasSitePerm(req.user, 'manage_storage')) fail(403, 'دسترسی ندارید');
};

function where(q = {}) {
  const parts = ['f.purged = 0'];
  const args = [];
  if (q.userId === 'none') parts.push('f.owner_id IS NULL');
  else if (Number(q.userId)) {
    parts.push('f.owner_id = ?');
    args.push(Number(q.userId));
  }
  if (CATEGORIES.includes(q.category)) {
    parts.push(`${CATEGORY} = ?`);
    args.push(q.category);
  }
  if (Number(q.chatId)) {
    parts.push('EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id AND m.chat_id = ? AND m.deleted = 0)');
    args.push(Number(q.chatId));
  }
  if (Number(q.minMb) > 0) {
    parts.push('f.size >= ?');
    args.push(Number(q.minMb) * 1048576);
  }
  if (Number(q.olderDays) > 0) {
    parts.push('f.created_at < ?');
    args.push(now() - Number(q.olderDays) * DAY);
  }
  if (q.q) {
    parts.push("f.name LIKE ? ESCAPE '\\'");
    args.push(`%${String(q.q).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (String(q.unused) === '1') {
    parts.push(UNUSED);
    args.push(now() - DAY);
  }
  return { sql: parts.join(' AND '), args };
}

const dirBytes = (dir) => {
  try {
    return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  } catch {
    return 0;
  }
};

export const filesOf = (userId) =>
  all(`SELECT ${CATEGORY} AS category, COUNT(*) AS count, SUM(${BYTES}) AS bytes FROM files f WHERE f.purged = 0 AND f.owner_id = ? GROUP BY category ORDER BY bytes DESC`, userId);

export default async function storageRoutes(app) {
  app.get('/api/admin/storage', async (req) => {
    need(req);
    const { category, ...rest } = req.query;
    const scope = where(rest);
    const picked = where(req.query);
    const sum = (w) => get(`SELECT COUNT(*) AS count, IFNULL(SUM(${BYTES}), 0) AS bytes FROM files f WHERE ${w.sql}`, ...w.args);
    let disk = null;
    try {
      const s = fs.statfsSync(DATA_DIR);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      /* statfs not supported on this platform */
    }
    // The last week's pace tells how long the free space lasts.
    const weekBytes = get(`SELECT IFNULL(SUM(${BYTES}), 0) AS n FROM files f WHERE f.created_at > ?`, now() - 7 * DAY).n;
    const perDay = weekBytes / 7;
    return {
      disk,
      perDay,
      daysLeft: disk && perDay > 1048576 ? Math.floor(disk.free / perDay) : null,
      uploadsBytes: sum(where()).bytes,
      dbBytes: get('PRAGMA page_count').page_count * get('PRAGMA page_size').page_size,
      backupsBytes: dirBytes(BACKUP_DIR),
      unused: sum(where({ unused: 1 })),
      kept: get(`SELECT COUNT(*) AS count, IFNULL(SUM(f.size), 0) AS bytes FROM deleted_messages d JOIN files f ON f.id = d.file_id WHERE f.purged = 0`),
      matched: sum(picked),
      categories: all(`SELECT ${CATEGORY} AS category, COUNT(*) AS count, SUM(${BYTES}) AS bytes FROM files f WHERE ${scope.sql} GROUP BY category ORDER BY bytes DESC`, ...scope.args),
      users: all(
        `SELECT f.owner_id AS id, u.display_name AS name, u.username, COUNT(*) AS count, SUM(${BYTES}) AS bytes
           FROM files f LEFT JOIN users u ON u.id = f.owner_id WHERE ${picked.sql} GROUP BY f.owner_id ORDER BY bytes DESC LIMIT 20`,
        ...picked.args,
      ),
      chats: all(
        `SELECT c.id, c.type, c.title, COUNT(*) AS count, SUM(${BYTES}) AS bytes
           FROM (SELECT DISTINCT chat_id, file_id FROM messages WHERE file_id IS NOT NULL AND deleted = 0) x
           JOIN files f ON f.id = x.file_id JOIN chats c ON c.id = x.chat_id
          WHERE ${picked.sql} GROUP BY c.id ORDER BY bytes DESC LIMIT 20`,
        ...picked.args,
      ),
    };
  });

  app.get('/api/admin/storage/files', async (req) => {
    need(req);
    const w = where(req.query);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const order = req.query.sort === 'date' ? 'f.created_at DESC' : `${BYTES} DESC`;
    const files = all(
      `SELECT f.id, f.name, f.mime, f.created_at, f.owner_id, u.display_name AS owner_name, ${CATEGORY} AS category, ${BYTES} AS bytes, ${AVATAR} AS avatar
         FROM files f LEFT JOIN users u ON u.id = f.owner_id WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...w.args,
      limit,
      offset,
    ).map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      category: f.category,
      bytes: f.bytes,
      createdAt: f.created_at,
      owner: f.owner_id ? { id: f.owner_id, name: f.owner_name } : null,
      avatar: !!f.avatar,
      chats: all('SELECT DISTINCT c.id, c.type, c.title FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.file_id = ? AND m.deleted = 0 LIMIT 3', f.id),
    }));
    return { files };
  });

  // By ids (the ticked files), or everything a filter shows (asks for the password). A big
  // filter takes several calls: `remaining` says how many are left.
  app.post('/api/admin/storage/delete', async (req) => {
    need(req);
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter(Boolean))].slice(0, 100) : [];
    const filter = b.filter && typeof b.filter === 'object' ? b.filter : null;
    if (!ids.length && !filter) fail(400, 'فایلی انتخاب نشده است');
    const w = ids.length ? { sql: `f.purged = 0 AND f.id IN (${ids.map(() => '?').join(',')})`, args: ids } : where(filter);
    if (!ids.length) {
      if (w.sql === 'f.purged = 0') fail(400, 'برای حذف گروهی یک فیلتر انتخاب کنید');
      if (!(await verifyPassword(String(b.password || ''), req.user.password_hash))) fail(403, 'رمز عبور اشتباه است');
    }
    // Pictures in use stay, a video still being converted is left alone, and only the owner
    // touches the files of admins and the owner.
    const safe = `${w.sql} AND NOT ${AVATAR} AND f.status != 'processing'${
      req.user.role === 'owner' ? '' : " AND (f.owner_id IS NULL OR f.owner_id = ? OR f.owner_id IN (SELECT id FROM users WHERE role = 'user'))"
    }`;
    const args = req.user.role === 'owner' ? w.args : [...w.args, req.user.id];
    const rows = all(`SELECT f.id, ${BYTES} AS bytes FROM files f WHERE ${safe} ORDER BY f.id LIMIT 1000`, ...args);
    let bytes = 0;
    let deleted = 0;
    for (const f of rows) {
      if (!purgeAndTell(f.id)) continue;
      deleted++;
      bytes += f.bytes;
    }
    const remaining = get(`SELECT COUNT(*) AS n FROM files f WHERE ${safe}`, ...args).n;
    audit(req.user.id, 'storage.delete', '', { deleted, bytes, filter: filter || undefined });
    return { deleted, bytes, remaining };
  });

  // Space SQLite holds free after big deletions goes back to the disk only on request.
  app.post('/api/admin/storage/compact', async (req) => {
    if (req.user.role !== 'owner') fail(403, 'فقط مالک');
    const before = fs.statSync(path.join(DATA_DIR, 'amorechat.db')).size;
    db.exec('VACUUM');
    const after = fs.statSync(path.join(DATA_DIR, 'amorechat.db')).size;
    audit(req.user.id, 'storage.compact', '', { saved: before - after });
    return { saved: before - after };
  });
}
