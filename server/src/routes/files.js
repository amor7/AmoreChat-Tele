import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { get, all, run, now, parseJSON, UPLOAD_DIR, DATA_DIR } from '../db.js';
import { effectiveLimits } from '../limits.js';
import { fail } from '../chats.js';
import { hasSitePerm } from '../perms.js';
import { mediaReady, processVoice, processMusic, queueVideo, fileVariants } from '../media.js';

// Only these types are ever served inline; everything else is a forced
// download, so an uploaded HTML/SVG file can never run script on our origin.
const INLINE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-m4a',
]);

function kindOf(mime) {
  if (/^image\/(jpeg|png|gif|webp|avif)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

export const newRel = () => path.posix.join(new Date().toISOString().slice(0, 7), crypto.randomBytes(16).toString('hex'));

function checkLimits(user, size = 0) {
  const limits = effectiveLimits(user);
  if (size > limits.uploadMb * 1024 * 1024) fail(413, `حداکثر حجم فایل برای شما ${limits.uploadMb} مگابایت است`);
  if (limits.quotaMb > 0) {
    const used = get('SELECT IFNULL(SUM(size), 0) AS s FROM files WHERE owner_id = ?', user.id).s;
    if (used + size > limits.quotaMb * 1024 * 1024 || (!size && used >= limits.quotaMb * 1024 * 1024)) fail(413, 'سهمیه فضای شما پر شده است');
  }
  return limits;
}

// Records a finished upload (already at UPLOAD_DIR/rel) and starts voice/video processing.
export async function registerFile(user, { rel, mime, name, q = {} }) {
  const size = fs.statSync(path.join(UPLOAD_DIR, rel)).size;
  mime = String(mime || 'application/octet-stream').toLowerCase().split(';')[0];
  const kind = kindOf(mime);
  // Voice waveform: up to 128 bars, each a base-32 digit (0-v).
  const waveform = /^[0-9a-v]{1,128}$/.test(q.wave || '') ? q.wave : null;
  const maxQuality = ['360', '720', 'original'].includes(q.q) ? q.q : '720';
  const processVideo = kind === 'video' && (await mediaReady);
  const r = run(
    `INSERT INTO files (owner_id, path, mime, size, name, kind, width, height, duration, waveform, status, max_quality, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    user.id,
    rel,
    mime,
    size,
    String(name || 'file').slice(0, 200),
    kind,
    num(q.w),
    num(q.h),
    num(q.dur),
    waveform,
    processVideo ? 'processing' : 'ready',
    kind === 'video' ? maxQuality : null,
    now(),
  );
  const id = Number(r.lastInsertRowid);
  if (kind === 'audio' && String(q.voice) === '1') await processVoice(id);
  else if (kind === 'audio' && (await mediaReady)) await processMusic(id).catch(() => {});
  if (processVideo) queueVideo(id, maxQuality);
  const f = get('SELECT * FROM files WHERE id = ?', id);
  return { id, mime: f.mime, size: f.size, kind, name: f.name, status: f.status };
}

// ---------- Resumable uploads ----------
// The client sends the file in chunks; after a dropped connection (or a server restart) it asks
// for the current offset and continues from there instead of starting over.
const PARTIAL_DIR = path.join(DATA_DIR, 'partial');
fs.mkdirSync(PARTIAL_DIR, { recursive: true });
const CHUNK = 4 * 1024 * 1024;
const partPath = (id) => path.join(PARTIAL_DIR, id);
const partSize = (id) => (fs.existsSync(partPath(id)) ? fs.statSync(partPath(id)).size : 0);
const busy = new Set();
const STALE = 24 * 3600 * 1000;

function dropSession(id) {
  run('DELETE FROM upload_sessions WHERE id = ?', id);
  fs.rmSync(partPath(id), { force: true });
}

function cleanStale() {
  for (const s of all('SELECT id FROM upload_sessions WHERE updated_at < ?', now() - STALE)) dropSession(s.id);
  const known = new Set(all('SELECT id FROM upload_sessions').map((s) => s.id));
  for (const f of fs.readdirSync(PARTIAL_DIR)) if (!known.has(f)) fs.rmSync(path.join(PARTIAL_DIR, f), { force: true });
}

function mySession(req) {
  const s = get('SELECT * FROM upload_sessions WHERE id = ? AND owner_id = ?', String(req.params.id), req.user.id);
  if (!s) fail(404, 'این آپلود منقضی شده است؛ دوباره ارسال کنید');
  return s;
}

export default async function fileRoutes(app) {
  cleanStale();
  setInterval(cleanStale, 3600 * 1000).unref();
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK + 1024 }, (_req, body, done) => done(null, body));

  app.post('/api/uploads', async (req) => {
    const b = req.body || {};
    const size = Number(b.size);
    if (!Number.isSafeInteger(size) || size < 0) fail(400, 'حجم نامعتبر');
    checkLimits(req.user, size);
    if (get('SELECT COUNT(*) AS n FROM upload_sessions WHERE owner_id = ?', req.user.id).n >= 10) {
      fail(429, 'تعداد ارسال‌های نیمه‌کاره زیاد است؛ کمی صبر کنید یا آن‌ها را لغو کنید');
    }
    const id = crypto.randomBytes(16).toString('hex');
    const meta = Object.fromEntries(Object.entries(b.meta || {}).filter(([k, v]) => /^[a-z]{1,8}$/.test(k) && v != null).map(([k, v]) => [k, String(v).slice(0, 200)]));
    run(
      'INSERT INTO upload_sessions (id, owner_id, name, mime, size, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      req.user.id,
      String(b.name || 'file').slice(0, 200),
      String(b.mime || 'application/octet-stream').slice(0, 100),
      size,
      JSON.stringify(meta),
      now(),
      now(),
    );
    fs.writeFileSync(partPath(id), '');
    return { id, offset: 0, chunkSize: CHUNK };
  });

  app.get('/api/uploads/:id', async (req) => {
    const s = mySession(req);
    return { offset: partSize(s.id), size: s.size };
  });

  app.put('/api/uploads/:id', async (req, reply) => {
    const s = mySession(req);
    if (busy.has(s.id)) fail(409, 'در حال دریافت');
    busy.add(s.id);
    try {
      const have = partSize(s.id);
      const offset = Number(req.headers['upload-offset']);
      // Out of sync (e.g. the previous chunk did arrive although the reply got lost): tell the client.
      if (offset !== have) return reply.code(409).send({ error: 'offset', offset: have });
      const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (have + chunk.length > s.size) fail(400, 'داده بیش از حجم اعلام‌شده است');
      if (chunk.length) await fs.promises.appendFile(partPath(s.id), chunk);
      run('UPDATE upload_sessions SET updated_at = ? WHERE id = ?', now(), s.id);
      const got = have + chunk.length;
      if (got < s.size) return { offset: got };
      // Complete: move into the uploads folder and register it like a normal upload.
      try {
        checkLimits(req.user, s.size);
      } catch (e) {
        dropSession(s.id);
        throw e;
      }
      const rel = newRel();
      fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, rel)), { recursive: true });
      fs.renameSync(partPath(s.id), path.join(UPLOAD_DIR, rel));
      run('DELETE FROM upload_sessions WHERE id = ?', s.id);
      const file = await registerFile(req.user, { rel, mime: s.mime, name: s.name, q: parseJSON(s.meta, {}) });
      reply.code(201);
      return { offset: got, file };
    } finally {
      busy.delete(s.id);
    }
  });

  app.delete('/api/uploads/:id', async (req) => {
    dropSession(mySession(req).id);
    return { ok: true };
  });

  // Single-request upload (kept for older app versions still open in a browser).
  app.post('/api/upload', async (req, reply) => {
    const limits = checkLimits(req.user);
    const maxBytes = limits.uploadMb * 1024 * 1024;

    const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
    if (!part) fail(400, 'فایلی ارسال نشده');

    const rel = newRel();
    const abs = path.join(UPLOAD_DIR, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      await pipeline(part.file, fs.createWriteStream(abs));
    } catch (e) {
      // Client cancelled or the connection dropped mid-upload: don't leave partial files behind.
      fs.rmSync(abs, { force: true });
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(abs, { force: true });
      fail(413, `حداکثر حجم فایل برای شما ${limits.uploadMb} مگابایت است`);
    }

    const file = await registerFile(req.user, { rel, mime: part.mimetype, name: part.filename, q: req.query || {} });
    reply.code(201);
    return { file };
  });

  app.get('/api/me/usage', async (req) => ({
    usedBytes: get('SELECT IFNULL(SUM(size), 0) AS s FROM files WHERE owner_id = ?', req.user.id).s,
    quotaMb: effectiveLimits(req.user).quotaMb,
  }));

  app.get('/api/files/:id', async (req, reply) => {
    const f = get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
    if (!f) fail(404, 'فایل پیدا نشد');
    const uid = req.user.id;
    const allowed =
      f.owner_id === uid ||
      get(
        `SELECT 1 AS ok WHERE
           EXISTS (SELECT 1 FROM users WHERE avatar_file_id = ?1)
           OR EXISTS (SELECT 1 FROM chats WHERE avatar_file_id = ?1)
           OR EXISTS (SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?2
                      WHERE m.file_id = ?1 AND m.deleted = 0)`,
        f.id,
        uid,
      ) ||
      // Moderators, while a deleted message's content is kept.
      (hasSitePerm(req.user, 'manage_chats') && get('SELECT 1 AS ok FROM deleted_messages WHERE file_id = ?', f.id));
    if (!allowed) fail(403, 'دسترسی ندارید');
    if (f.purged) fail(410, 'این فایل منقضی و حذف شده است');

    let rel = f.path;
    let mime = f.mime;
    if (req.query.thumb === '1') {
      if (!f.thumb) fail(404, 'پیش‌نمایش ندارد');
      rel = f.thumb;
      mime = 'image/jpeg';
    } else if (req.query.v) {
      const v = fileVariants(f).find((x) => String(x.q) === String(req.query.v));
      if (v) {
        rel = v.path;
        mime = 'video/mp4';
      }
    }

    const inline = INLINE_TYPES.has(mime) && req.query.download !== '1';
    reply.header('Content-Type', inline ? mime : 'application/octet-stream');
    reply.header(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`,
    );
    // Not immutable: a video's main file is replaced once processing finishes.
    reply.header('Cache-Control', f.status === 'ready' ? 'private, max-age=86400' : 'no-store');
    return reply.sendFile(rel, UPLOAD_DIR, { contentType: false });
  });
}
