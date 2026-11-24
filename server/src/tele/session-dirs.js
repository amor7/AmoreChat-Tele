// The TDLib session folders (data/tele-sessions/<account id>) hold an account's login keys. Ids
// of tele_accounts can be handed out again (no AUTOINCREMENT): after a restore of an older backup,
// or a user being deleted, a folder can outlive its row, and the next account given that id would
// open the old, logged-in session. So: a new row starts from an empty folder, and the server's
// start removes folders that no row owns. Only numbered folders are touched: never the `.key`
// file (the session key) or anything else kept there.
// Imports nothing of the app, so it can be tested on its own.
import fs from 'node:fs';
import path from 'node:path';

export const SESSIONS_DIR_NAME = 'tele-sessions';
export const sessionsRoot = (dataDir) => path.join(dataDir, SESSIONS_DIR_NAME);

/** Removes whatever folder a newly created account id would otherwise inherit. */
export function wipeSessionDir(root, accountId) {
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`bad account id: ${accountId}`);
  fs.rmSync(path.join(root, String(id)), { recursive: true, force: true });
}

/**
 * Deletes every folder in `root` named by a number for which `db` has no tele_accounts row.
 * Returns the names removed. A missing root (Telegram never used) is not an error.
 */
export function pruneOrphanSessions(db, root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const hasRow = db.prepare('SELECT 1 FROM tele_accounts WHERE id = ?');
  const removed = [];
  for (const e of entries) {
    if (!e.isDirectory() || !/^[1-9]\d*$/.test(e.name)) continue;
    const id = Number(e.name);
    if (!Number.isSafeInteger(id) || hasRow.get(id)) continue;
    fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}
