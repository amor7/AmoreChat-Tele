// Telegram history of users with a passcode stays out of backups. Usage: DATA_DIR=/tmp/x node --test server/test/backup-redact.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { db, run, get, now } from '../src/db.js';
import { backupNow, redactOrDrop, redactAllBackups, BACKUP_DIR } from '../src/backup.js';
import { redactTeleLocked, enoughSpace, NO_SPACE } from '../src/backup-redact.js';

// The migration that adds this table may land separately; same shape as the spec.
db.exec(`CREATE TABLE IF NOT EXISTS tele_passcodes (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL,
  idle_min INTEGER NOT NULL DEFAULT 15, fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, updated_at INTEGER NOT NULL)`);

const user = (name) => Number(run('INSERT INTO users (username, display_name, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', name, name, 'x', now(), now()).lastInsertRowid);
function teleUser(name, secret, phone) {
  const uid = user(name);
  const acc = Number(
    run('INSERT INTO tele_accounts (user_id, phone, display_name, username, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', uid, phone, `${secret}-name`, `${secret}_tg`, now(), now()).lastInsertRowid,
  );
  const dlg = Number(
    run("INSERT INTO tele_dialogs (account_id, tg_chat_id, title, username, last_text, created_at, updated_at) VALUES (?, '42', ?, ?, ?, ?, ?)", acc, `${secret}-title`, `${secret}_user`, `${secret}-last`, now(), now())
      .lastInsertRowid,
  );
  const msg = Number(run("INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, text, sender_name, created_at) VALUES (?, ?, 1, ?, ?, ?)", acc, dlg, `${secret}-text`, `${secret}-sender`, now()).lastInsertRowid);
  run('INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, text, created_at) VALUES (?, ?, 2, ?, ?)', acc, dlg, `${secret}-text2`, now());
  run("INSERT INTO tele_queue (account_id, dialog_id, message_id, content, created_at) VALUES (?, ?, ?, ?, ?)", acc, dlg, msg, JSON.stringify({ text: `${secret}-queued` }), now());
  return { uid, acc, dlg };
}

const locked = teleUser('locked', 'SECRETLOCKED', '+989121234567');
const open = teleUser('open', 'PLAINOPEN', '+989357654321');
run('INSERT INTO tele_passcodes (user_id, hash, updated_at) VALUES (?, ?, ?)', locked.uid, 'h', now());

const count = (d, sql, ...a) => d.prepare(sql).get(...a).n;

test('daily backup: the passcode user loses Telegram history, everyone else keeps it', async () => {
  const file = await backupNow();
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('SECRETLOCKED'), 'no trace of the locked user, not even in free pages');
  assert.ok(!raw.includes('989121234567'), "the locked user's phone number is gone");
  assert.ok(raw.includes('PLAINOPEN-text'));
  assert.ok(raw.includes('989357654321'));
  assert.ok(!fs.existsSync(`${file}-wal`) && !fs.existsSync(`${file}-journal`));

  const b = new DatabaseSync(file, { readOnly: true });
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_messages WHERE account_id = ?', locked.acc), 0);
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_queue WHERE account_id = ?', locked.acc), 0);
  assert.deepEqual({ ...b.prepare('SELECT title, username, last_text FROM tele_dialogs WHERE id = ?').get(locked.dlg) }, { title: '', username: '', last_text: '' });
  assert.deepEqual({ ...b.prepare('SELECT phone, display_name, username FROM tele_accounts WHERE id = ?').get(locked.acc) }, { phone: '', display_name: '', username: '' });
  assert.deepEqual({ ...b.prepare('SELECT phone, display_name, username FROM tele_accounts WHERE id = ?').get(open.acc) }, { phone: '+989357654321', display_name: 'PLAINOPEN-name', username: 'PLAINOPEN_tg' });
  assert.equal(b.prepare('SELECT tg_chat_id FROM tele_dialogs WHERE id = ?').get(locked.dlg).tg_chat_id, '42', 'chat ids stay');
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_messages WHERE account_id = ?', open.acc), 2);
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_queue WHERE account_id = ?', open.acc), 1);
  assert.equal(b.prepare('SELECT title FROM tele_dialogs WHERE id = ?').get(open.dlg).title, 'PLAINOPEN-title');
  // The account and dialog rows stay (passcode, settings, quotas survive a restore).
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_passcodes'), 1);
  assert.equal(count(b, 'SELECT COUNT(*) AS n FROM tele_dialogs'), 2);
  assert.equal(b.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', 'same journal mode as the live snapshot');
  b.close();

  // The live database is untouched.
  assert.equal(get('SELECT COUNT(*) AS n FROM tele_messages WHERE account_id = ?', locked.acc).n, 2);
  assert.equal(get('SELECT title FROM tele_dialogs WHERE id = ?', locked.dlg).title, 'SECRETLOCKED-title');
  assert.equal(get('SELECT phone FROM tele_accounts WHERE id = ?', locked.acc).phone, '+989121234567');

  // The integrity check used before restore still passes.
  const check = JSON.parse(execFileSync(process.execPath, [path.join(import.meta.dirname, '../src/backup-check.js'), file], { encoding: 'utf8' }));
  assert.equal(check.ok, true, check.error);
});

test('the daily backup leaves no half-made (.partial) file behind', async () => {
  const file = await backupNow();
  assert.ok(!fs.readdirSync(BACKUP_DIR).some((f) => f.endsWith('.partial')));
  assert.ok(!fs.readFileSync(file).includes('SECRETLOCKED'));
});

test('a backup from before the passcode table is left as is when nobody has a passcode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-redact-'));
  const file = path.join(dir, 'old.db');
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE tele_messages (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO tele_messages (text) VALUES ('keep');");
  d.close();
  const before = fs.readFileSync(file);
  assert.deepEqual(redactTeleLocked(file), { users: 0, changed: 0 });
  assert.ok(fs.readFileSync(file).equals(before), 'not even the journal mode changed');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A copy of the live database without the passcode row: what a backup from before the user turned
// the passcode on looks like.
async function backupFromBefore(dir) {
  const { backup } = await import('node:sqlite');
  const file = path.join(dir, 'amorechat-200001010000.db');
  await backup(db, file);
  const d = new DatabaseSync(file);
  d.exec('DELETE FROM tele_passcodes; VACUUM;');
  d.close();
  assert.ok(fs.readFileSync(file).includes('SECRETLOCKED-text'));
  return file;
}

test('a backup from before the passcode was set: redacted by the live list, in a child process, idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-redact-'));
  const file = await backupFromBefore(dir);
  const r = await redactOrDrop(file);
  assert.equal(r.users, 1);
  assert.ok(r.changed > 0);
  const raw = fs.readFileSync(file);
  assert.ok(!raw.includes('SECRETLOCKED'));
  assert.ok(raw.includes('PLAINOPEN-text'));
  // Second run: nothing left to do, the file is not written (no VACUUM).
  const again = await redactOrDrop(file);
  assert.deepEqual(again, { users: 1, changed: 0 });
  assert.ok(fs.readFileSync(file).equals(raw));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redactAllBackups covers every .db in the backups folder, before-restore copies too', async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-redact-'));
  const old = await backupFromBefore(tmp);
  const names = ['amorechat-200001010000.db', 'before-restore-20000101000000.db'];
  for (const n of names) fs.copyFileSync(old, path.join(BACKUP_DIR, n));
  fs.writeFileSync(path.join(BACKUP_DIR, 'amorechat-200001020000.db'), 'not a database, just garbage '.repeat(200));
  const { files, dropped } = await redactAllBackups();
  assert.ok(files >= 3);
  for (const n of names) assert.ok(!fs.readFileSync(path.join(BACKUP_DIR, n)).includes('SECRETLOCKED'), n);
  // Fail-closed: what can't be redacted is gone.
  assert.equal(dropped.length, 1);
  assert.ok(!fs.existsSync(path.join(BACKUP_DIR, 'amorechat-200001020000.db')));
  for (const n of names) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('not enough free space for VACUUM: clear error, nothing changed', async () => {
  assert.equal(enoughSpace(100, 100), true);
  assert.equal(enoughSpace(99, 100), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-redact-'));
  const file = await backupFromBefore(dir);
  const before = fs.readFileSync(file);
  assert.throws(() => redactTeleLocked(file, [locked.uid], { free: () => 0 }), new RegExp(NO_SPACE));
  assert.ok(fs.readFileSync(file).equals(before));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup that cannot be redacted is deleted, not kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-redact-'));
  const file = path.join(dir, 'broken.db');
  fs.writeFileSync(file, 'this is not a database '.repeat(100));
  await assert.rejects(redactOrDrop(file), /بکاپ حذف شد/);
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});
