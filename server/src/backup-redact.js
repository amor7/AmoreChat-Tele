// Takes the Telegram history of users with a passcode out of a backup file. Runs in its own process
// (DELETE + VACUUM of a big file would otherwise stall the live server's event loop):
//   node server/src/backup-redact.js <file> [userId,userId,...]
// prints {"ok":true,...} or {"ok":false,"error":...} and exits non-zero on failure.
// Imports nothing of the app (no db.js): it must never open the live database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const NO_SPACE = 'فضای دیسک برای پاک‌سازی بکاپ کافی نیست';

/** VACUUM writes a new copy of the file next to it: it needs about the file's size free. */
export const enoughSpace = (free, size) => free >= size;

function freeBytes(dir) {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * `userIds`: users with a passcode now (from the live database). A backup taken before they set it
 * has no row for them in its own tele_passcodes, so the live list is what makes it safe; the file's
 * own rows are added for users who removed theirs later. Idempotent: a file with nothing left to
 * remove is not written at all.
 */
export function redactTeleLocked(file, userIds = [], { free = freeBytes } = {}) {
  // Opening a missing path would create an empty database under a backup's name.
  if (!fs.existsSync(file)) throw new Error('فایل بکاپ پیدا نشد');
  // Waits for a reader (an integrity check of the same file) instead of failing, which would drop the file.
  const snap = new DatabaseSync(file, { timeout: 60_000 });
  try {
    const has = (t) => !!snap.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    const cols = (t) => new Set(snap.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    // Older than Telegram support: nothing to remove.
    if (!has('tele_accounts')) return { users: 0, changed: 0 };
    const ids = new Set(userIds.map(Number).filter(Number.isInteger));
    if (has('tele_passcodes')) for (const r of snap.prepare('SELECT user_id FROM tele_passcodes').all()) ids.add(Number(r.user_id));
    if (!ids.size) return { users: 0, changed: 0 };

    const list = JSON.stringify([...ids]);
    const inUsers = 'user_id IN (SELECT value FROM json_each(:ids))';
    const accounts = `SELECT id FROM tele_accounts WHERE ${inUsers}`;
    const dialogs = `SELECT id FROM tele_dialogs WHERE account_id IN (${accounts})`;
    const blank = (t, wanted) => [...cols(t)].filter((c) => wanted.includes(c));
    const dCols = has('tele_dialogs') ? blank('tele_dialogs', ['title', 'username', 'last_text']) : [];
    const aCols = blank('tele_accounts', ['phone', 'display_name', 'username']);
    // Only rows that still hold something: a second run finds none and leaves the file alone.
    const filled = (c) => `(${c.map((x) => `${x} IS NOT ''`).join(' OR ')})`;
    // [table, rows to clear, columns to blank (none: delete the rows)]
    const work = [];
    if (has('tele_queue')) work.push(['tele_queue', `account_id IN (${accounts}) OR dialog_id IN (${dialogs})`]);
    if (has('tele_messages')) work.push(['tele_messages', `account_id IN (${accounts}) OR dialog_id IN (${dialogs})`]);
    if (dCols.length) work.push(['tele_dialogs', `account_id IN (${accounts}) AND ${filled(dCols)}`, dCols]);
    // The TDLib session folder isn't in backups, so a restored account must log in again anyway:
    // its phone and names are worth nothing there, and would only reach whoever holds the file.
    if (aCols.length) work.push(['tele_accounts', `${inUsers} AND ${filled(aCols)}`, aCols]);
    const pending = work.some(([t, where]) => !!snap.prepare(`SELECT 1 FROM ${t} WHERE ${where} LIMIT 1`).get({ ids: list }));
    if (!pending) return { users: ids.size, changed: 0 };

    // VACUUM below rebuilds the file next to itself. Checked before anything is changed: running
    // out of space half-way would leave deleted rows readable in free pages.
    if (!enoughSpace(free(path.dirname(path.resolve(file))), fs.statSync(file).size)) throw new Error(NO_SPACE);

    // Rollback journal while editing so nothing is left behind in a -wal file; the original mode is
    // put back afterwards so the file is otherwise the same snapshot.
    const mode = snap.prepare('PRAGMA journal_mode').get().journal_mode;
    snap.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
    let changed = 0;
    snap.exec('BEGIN');
    try {
      for (const [t, where, set] of work) {
        const sql = set ? `UPDATE ${t} SET ${set.map((c) => `${c} = ''`).join(', ')} WHERE ${where}` : `DELETE FROM ${t} WHERE ${where}`;
        changed += Number(snap.prepare(sql).run({ ids: list }).changes);
      }
      snap.exec('COMMIT');
    } catch (e) {
      snap.exec('ROLLBACK');
      throw e;
    }
    // Rebuilds the file so the deleted rows don't survive in free pages.
    if (changed) snap.exec('VACUUM');
    if (mode !== 'delete') snap.exec(`PRAGMA journal_mode = ${mode}`);
    return { users: ids.size, changed };
  } finally {
    snap.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const ids = (process.argv[3] || '').split(',').filter(Boolean).map(Number);
    console.log(JSON.stringify({ ok: true, ...redactTeleLocked(process.argv[2], ids) }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 300) }));
    process.exitCode = 1;
  }
}
