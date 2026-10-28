import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { backup } from 'node:sqlite';
import { db, UPLOAD_DIR, DB_FILE } from '../db.js';
import { BACKUP_DIR, backupNow } from '../backup.js';
import { fail, audit } from '../chats.js';

// Backups contain every message and password hash: owner only.
const ownerOnly = (req) => {
  if (req.user.role !== 'owner') fail(403, 'فقط مدیر اصلی می‌تواند پشتیبان بگیرد');
};
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

async function snapshot() {
  const file = path.join(os.tmpdir(), `amorechat-${process.pid}-${Date.now()}.db`);
  await backup(db, file);
  return file;
}

// ---- Minimal streaming tar (ustar) writer: no extra dependency, constant memory ----
function header(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
  }
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, off, len) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);
  put(name, 0, 100);
  oct(0o644, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(size, 124, 12);
  oct(Math.floor(mtime / 1000), 136, 12);
  h.fill(' ', 148, 156);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function* walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) yield* walk(path.join(dir, e.name), r);
    else if (e.isFile()) yield r;
  }
}

async function* tarEntries(entries) {
  for (const { name, abs } of entries) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // deleted meanwhile (auto-delete sweeper)
    }
    yield header(name, st.size, st.mtimeMs);
    let sent = 0;
    try {
      for await (const chunk of fs.createReadStream(abs, { end: Math.max(0, st.size - 1), highWaterMark: 1 << 20 })) {
        if (!st.size) break;
        sent += chunk.length;
        yield chunk;
      }
    } catch {
      /* vanished while reading: pad below keeps the archive valid */
    }
    if (sent < st.size) yield Buffer.alloc(st.size - sent);
    if (st.size % 512) yield Buffer.alloc(512 - (st.size % 512));
  }
  yield Buffer.alloc(1024);
}

export default async function backupRoutes(app) {
  app.get('/api/admin/backups', async (req) => {
    ownerOnly(req);
    const files = fs.existsSync(BACKUP_DIR)
      ? fs
          .readdirSync(BACKUP_DIR)
          .filter((f) => /^amorechat-\d+\.db$/.test(f))
          .sort()
          .reverse()
          .map((name) => {
            const st = fs.statSync(path.join(BACKUP_DIR, name));
            return { name, size: st.size, createdAt: st.mtimeMs };
          })
      : [];
    let uploads = 0;
    for (const r of walk(UPLOAD_DIR)) uploads += fs.statSync(path.join(UPLOAD_DIR, r)).size;
    return { files, dbSize: [DB_FILE, `${DB_FILE}-wal`].reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0), uploadsSize: uploads };
  });

  // Fresh database snapshot (messages, users, settings), safe while running.
  app.get('/api/admin/backup/db', async (req, reply) => {
    ownerOnly(req);
    const file = await snapshot();
    audit(req.user.id, 'backup.download', '', { kind: 'db', ip: req.ip });
    const stream = fs.createReadStream(file);
    stream.on('close', () => fs.rm(file, { force: true }, () => {}));
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', fs.statSync(file).size);
    reply.header('Content-Disposition', `attachment; filename="amorechat-${stamp()}.db"`);
    return reply.send(stream);
  });

  // Everything: database snapshot + all uploaded files, as one .tar (media is already compressed).
  app.get('/api/admin/backup/full', async (req, reply) => {
    ownerOnly(req);
    const file = await snapshot();
    audit(req.user.id, 'backup.download', '', { kind: 'full', ip: req.ip });
    const entries = [{ name: 'amorechat.db', abs: file }, ...[...walk(UPLOAD_DIR)].map((r) => ({ name: `uploads/${r}`, abs: path.join(UPLOAD_DIR, r) }))];
    const stream = Readable.from(tarEntries(entries));
    stream.on('close', () => fs.rm(file, { force: true }, () => {}));
    reply.header('Content-Type', 'application/x-tar');
    reply.header('Content-Disposition', `attachment; filename="amorechat-full-${stamp()}.tar"`);
    return reply.send(stream);
  });

  // One of the automatic daily snapshots.
  app.get('/api/admin/backups/:name', async (req, reply) => {
    ownerOnly(req);
    const name = String(req.params.name);
    if (!/^amorechat-\d+\.db$/.test(name)) fail(400, 'نام نامعتبر');
    const abs = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(abs)) fail(404, 'پیدا نشد');
    audit(req.user.id, 'backup.download', '', { kind: name, ip: req.ip });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', fs.statSync(abs).size);
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.send(fs.createReadStream(abs));
  });

  app.post('/api/admin/backups', async (req) => {
    ownerOnly(req);
    const f = await backupNow();
    audit(req.user.id, 'backup.create', '', { file: path.basename(f) });
    return { name: path.basename(f) };
  });
}
