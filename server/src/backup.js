import fs from 'node:fs';
import path from 'node:path';
import { backup } from 'node:sqlite';
import { db, DATA_DIR, UPLOAD_DIR } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const DAY = 24 * 3600 * 1000;

// Online snapshot of the database (safe while the server is running).
// Uploaded files are not copied; they live in DATA_DIR/uploads and never change once written.
export async function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const file = path.join(BACKUP_DIR, `amorechat-${stamp}.db`);
  await backup(db, file);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^amorechat-\d+\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  return file;
}

// Second copy (another disk, a USB drive or a network share mounted on the host): set
// BACKUP_MIRROR_DIR in .env. The DB snapshot plus every uploaded file not copied yet.
const MIRROR = process.env.BACKUP_MIRROR ? '/mirror' : null;
let lastMirror = null;
export const mirrorStatus = () => ({ enabled: !!MIRROR, last: lastMirror });

async function copyNew(src, dst) {
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(b, { recursive: true });
      n += await copyNew(a, b);
    } else if (e.isFile() && (!fs.existsSync(b) || fs.statSync(b).size !== fs.statSync(a).size)) {
      await fs.promises.copyFile(a, b);
      n++;
    }
  }
  return n;
}

export async function mirrorBackup(dbFile) {
  if (!MIRROR) return null;
  fs.mkdirSync(path.join(MIRROR, 'backups'), { recursive: true });
  await fs.promises.copyFile(dbFile, path.join(MIRROR, 'backups', path.basename(dbFile)));
  const keep = fs.readdirSync(path.join(MIRROR, 'backups')).filter((f) => /^amorechat-\d+\.db$/.test(f)).sort().slice(0, -KEEP);
  for (const f of keep) fs.rmSync(path.join(MIRROR, 'backups', f), { force: true });
  fs.mkdirSync(path.join(MIRROR, 'uploads'), { recursive: true });
  const files = await copyNew(UPLOAD_DIR, path.join(MIRROR, 'uploads'));
  lastMirror = { at: Date.now(), files };
  return lastMirror;
}

export function scheduleBackups(log) {
  const latest = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).sort().at(-1) : null;
  const latestAge = latest ? Date.now() - fs.statSync(path.join(BACKUP_DIR, latest)).mtimeMs : Infinity;
  const run = async () => {
    const { raiseAlert, resolveAlert } = await import('./health.js');
    try {
      const f = await backupNow();
      log.info(`backup written: ${f}`);
      const m = await mirrorBackup(f);
      if (m) log.info(`backup mirrored (${m.files} new files)`);
      await resolveAlert('backup');
    } catch (e) {
      log.error(e, 'backup failed');
      await raiseAlert('backup', `بکاپ روزانه ناموفق بود: ${e.message}`);
    }
  };
  setTimeout(
    () => {
      run();
      setInterval(run, DAY).unref();
    },
    Math.max(60_000, DAY - latestAge),
  ).unref();
}
