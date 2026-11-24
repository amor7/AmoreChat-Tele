// Telegram passcodes survive a restore from the panel. A restore puts an older database in place
// (deploy/panel-update.sh, app stopped) while the TDLib session folders stay as they are: without
// this, a passcode set after that backup would simply be gone, and whoever resets the user's
// password would reach their Telegram unlocked. So the rows of now are written next to the data
// when a restore is asked for (and again when the app stops), and put back into whatever database
// the app opens next, after its migrations (an old backup may not have the table at all).
// If the kept file can't be read, it is set aside as tele-passcodes.carry.corrupt and the server
// starts with Telegram closed for everyone (index.js, tele/passcode.js): the rest of the app keeps
// working, nobody's Telegram opens without their passcode. Removing the .corrupt file (shell, which
// is outside what the passcode protects against anyway) lifts that at the next start.
// Imports nothing of the app: db.js uses it while it loads.
import fs from 'node:fs';

export const CARRY_NAME = 'tele-passcodes.carry.json';
export const CORRUPT_NAME = 'tele-passcodes.carry.corrupt';

const COLS = ['user_id', 'hash', 'idle_min', 'fails', 'locked_until', 'updated_at'];

const hasTable = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tele_passcodes'").get();

/** Writes every passcode row of `db` to `file` (only the owner may read it), atomically. Returns how many. */
export function writeCarry(db, file) {
  const rows = hasTable(db) ? db.prepare(`SELECT ${COLS.join(', ')} FROM tele_passcodes`).all() : [];
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ v: 1, at: Date.now(), rows: rows.map((r) => ({ ...r })) }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return rows.length;
}

const int = (v) => Number.isSafeInteger(v);
const validRow = (r) =>
  r && int(r.user_id) && typeof r.hash === 'string' && r.hash.length > 0 && int(r.idle_min) && int(r.fails) && (r.locked_until === null || int(r.locked_until)) && int(r.updated_at);

/**
 * Puts the rows from `file` back into `db` (the table must exist: run after the migrations), then
 * deletes the file. A union: rows the database already has for other users stay, and so does a
 * row newer than the kept one for the same user. Users the
 * database doesn't know (they registered after the backup) are skipped.
 * Returns `{ applied, skipped, newer }` (newer: the database's own row was newer and stayed),
 * null when there is no file; `{ corrupt: true, error }` when it can't be read: it is then
 * moved to `corruptFile` (only the owner may read it) and the caller must close Telegram for all.
 */
export function applyCarry(db, file, corruptFile) {
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data?.rows) || !data.rows.every(validRow)) throw new Error('unexpected content');
  } catch (e) {
    // Not moved (read-only disk?): it stays where it is and the next start closes Telegram again.
    try {
      fs.renameSync(file, corruptFile);
      fs.chmodSync(corruptFile, 0o600);
    } catch {}
    return { corrupt: true, error: e.message };
  }
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  // A row the database already has that is newer than the kept one (changed after the carry was
  // written) wins; otherwise the kept one replaces it.
  const put = db.prepare(
    `INSERT INTO tele_passcodes (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})
     ON CONFLICT(user_id) DO UPDATE SET ${COLS.filter((c) => c !== 'user_id').map((c) => `${c} = excluded.${c}`).join(', ')}
     WHERE excluded.updated_at >= tele_passcodes.updated_at`,
  );
  let applied = 0;
  let skipped = 0;
  let newer = 0;
  db.exec('BEGIN');
  try {
    for (const r of data.rows) {
      if (!userExists.get(r.user_id)) {
        skipped++;
        continue;
      }
      if (put.run(...COLS.map((c) => r[c])).changes) applied++;
      else newer++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  fs.rmSync(file, { force: true });
  return { applied, skipped, newer };
}
