import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { db, DATA_DIR, UPLOAD_DIR } from './db.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const DAY = 24 * 3600 * 1000;

// Online snapshot of the database (safe while the server is running).
// Uploaded files are not copied; they live in DATA_DIR/uploads and never change once written.
// Names being written right now (two backups can start in the same second).
const writing = new Set();
// The sidecar files SQLite may leave next to a database, plus our check result.
const sidecars = (file) => [`${file}-wal`, `${file}-shm`, `${file}-journal`, `${file}.check.json`];

// amorechat-YYYYMMDDHHMMSS.db; a second one in the same second gets 2 digits more (…SS01), so the
// name stays digits only (panel-update.sh, the backups list) and still sorts after the first.
function newBackupFile(dir) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  for (let i = 0; i < 100; i++) {
    const file = path.join(dir, `amorechat-${stamp}${i ? String(i).padStart(2, '0') : ''}.db`);
    if (!writing.has(file) && !fs.existsSync(file) && !fs.existsSync(`${file}.partial`)) return file;
  }
  throw new Error('backup name: too many backups in one second');
}

export async function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = newBackupFile(BACKUP_DIR);
  writing.add(file);
  try {
    return await writeBackup(file);
  } finally {
    writing.delete(file);
  }
}

async function writeBackup(file) {
  // Written and redacted under a name nothing lists (panel, mirror, redactAllBackups), then put in place.
  const part = `${file}.partial`;
  try {
    await backup(db, part);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  await redactOrDrop(part);
  fs.renameSync(part, file);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^amorechat-\d+\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) {
    for (const x of [path.join(BACKUP_DIR, f), ...sidecars(path.join(BACKUP_DIR, f))]) fs.rmSync(x, { force: true });
  }
  return file;
}

// Users who set a Telegram passcode keep their Telegram history out of every backup the owner can
// take away (daily file, its mirror copy, panel downloads). Done on a copy, never on the live
// database, by backup-redact.js in a child process: DELETE + VACUUM of a big file would block the
// event loop here. One at a time, so two passes never write the same file together.
const REDACT_SCRIPT = fileURLToPath(new URL('./backup-redact.js', import.meta.url));
const REDACT_TIMEOUT = 15 * 60000;
let redactQueue = Promise.resolve();

const passcodeUsers = () => db.prepare('SELECT user_id FROM tele_passcodes').all().map((r) => r.user_id);

function redactInChild(file) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [REDACT_SCRIPT, file, passcodeUsers().join(',')], { timeout: REDACT_TIMEOUT }, (err, stdout) => {
      let r = null;
      try {
        r = JSON.parse(String(stdout).trim().split('\n').at(-1));
      } catch {}
      if (!err && r?.ok) return resolve({ users: r.users, changed: r.changed });
      reject(new Error(r?.error || (err?.killed ? 'زمان پاک‌سازی تمام شد' : err?.message?.slice(0, 200)) || 'پاک‌سازی انجام نشد'));
    });
  });
}

// A backup that could not be redacted is removed rather than kept with what it should not contain.
export function redactOrDrop(file) {
  const job = redactQueue.then(async () => {
    try {
      return await redactInChild(file);
    } catch (e) {
      for (const f of [file, ...sidecars(file)]) fs.rmSync(f, { force: true });
      throw new Error(`پاک‌کردن پیام‌های تلگرام قفل‌شده از بکاپ ناموفق بود؛ بکاپ حذف شد: ${e.message}`, { cause: e });
    }
  });
  redactQueue = job.catch(() => {});
  return job;
}

/**
 * Every backup already on disk (daily ones, the copies in the mirror, the before-restore-* kept by
 * a panel restore): run when someone turns a passcode on, since those were taken before it. A file
 * that can't be redacted is deleted (redactOrDrop). Returns the names that were dropped.
 */
export async function redactAllBackups() {
  const dirs = [BACKUP_DIR, MIRROR && path.join(MIRROR, 'backups')].filter((d) => d && fs.existsSync(d));
  const dropped = [];
  let files = 0;
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.db')).sort()) {
      // Rotated away (backupNow keeps the last KEEP) since the list was read.
      if (!fs.existsSync(path.join(dir, f))) continue;
      files++;
      try {
        await redactOrDrop(path.join(dir, f));
      } catch (e) {
        dropped.push({ file: path.join(dir, f), error: e.message });
      }
    }
  }
  return { files, dropped };
}

// A backup being written or redacted when the app stopped (crash, power): never finished, maybe
// not redacted, and nothing lists or rotates it. Run before the server listens, so no backupNow
// of this run can be under way.
export function cleanBackupsAtStart(log) {
  for (const dir of [BACKUP_DIR, MIRROR && path.join(MIRROR, 'backups')]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => /\.partial(-journal|-wal|-shm)?$/.test(n))) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        log.info(`unfinished backup removed: ${f}`);
      } catch (e) {
        log.warn(e, `could not remove unfinished backup ${f}`);
      }
    }
  }
}

// Once per start when anyone has a passcode: backups the pass after turning it on didn't finish
// (the app stopped), and the before-restore-* a restore from the panel just kept (the database of
// before, with everything in it). In the background; files done already are left as they are.
export function redactBackupsAtStart(log) {
  if (!passcodeUsers().length) return;
  redactAllBackups()
    .then(({ dropped }) => {
      for (const d of dropped) log.error(`backup removed, could not be redacted: ${d.file}: ${d.error}`);
    })
    .catch((e) => log.error(e, 'redacting backups at start'));
}

/** Opens a backup and checks it, in another process; the result stays next to it. */
export function checkBackup(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [new URL('./backup-check.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), file], { timeout: 30 * 60000 }, (err, stdout) => {
      let r;
      try {
        r = JSON.parse(stdout);
      } catch {
        r = { ok: false, error: err?.message?.slice(0, 200) || 'بررسی نشد' };
      }
      r.at = Date.now();
      fs.writeFileSync(`${file}.check.json`, JSON.stringify(r));
      resolve(r);
    });
  });
}
export function lastCheck(file) {
  try {
    return JSON.parse(fs.readFileSync(`${file}.check.json`, 'utf8'));
  } catch {
    return null;
  }
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
  for (const f of keep) for (const x of [path.join(MIRROR, 'backups', f), ...sidecars(path.join(MIRROR, 'backups', f))]) fs.rmSync(x, { force: true });
  fs.mkdirSync(path.join(MIRROR, 'uploads'), { recursive: true });
  const files = await copyNew(UPLOAD_DIR, path.join(MIRROR, 'uploads'));
  lastMirror = { at: Date.now(), files };
  return lastMirror;
}

export function scheduleBackups(log) {
  const latest = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).sort().at(-1) : null;
  const latestAge = latest ? Date.now() - fs.statSync(path.join(BACKUP_DIR, latest)).mtimeMs : Infinity;
  const run = async () => {
    // A new install, nobody registered yet: nothing to keep, and nothing wrong.
    if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
    const { raiseAlert, resolveAlert } = await import('./health.js');
    try {
      const f = await backupNow();
      log.info(`backup written: ${f}`);
      const check = await checkBackup(f);
      if (!check.ok) throw new Error(`فایل بکاپ سالم نیست: ${check.error}`);
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
