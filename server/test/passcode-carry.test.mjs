// Telegram passcodes survive a restore from the panel, and the start cleans up after backups that
// never finished. Usage: DATA_DIR=/tmp/x node --test server/test/passcode-carry.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { writeCarry, applyCarry, CARRY_NAME, CORRUPT_NAME } from '../src/passcode-carry.js';

const SRC = path.resolve(import.meta.dirname, '../src');
const url = (f) => pathToFileURL(path.join(SRC, f)).href;

// The server's start in its own data folder, in the same order as index.js: db.js (migrations),
// then the kept passcodes. `apply: false` is a CLI (backup-cli.js) loading db.js while the app runs.
function start(dataDir, { apply = true } = {}) {
  const code = `
    const { db, PASSCODE_CARRY, PASSCODE_CARRY_CORRUPT } = await import(${JSON.stringify(url('db.js'))});
    const { applyCarry } = await import(${JSON.stringify(url('passcode-carry.js'))});
    const r = ${apply} ? applyCarry(db, PASSCODE_CARRY, PASSCODE_CARRY_CORRUPT) : 'not applied';
    const rows = db.prepare('SELECT user_id, hash, idle_min, fails, locked_until FROM tele_passcodes ORDER BY user_id').all();
    console.log(JSON.stringify({ r, rows, version: db.prepare('PRAGMA user_version').get().user_version }));
    db.close();`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').at(-1));
}

const addUser = (d, name) =>
  Number(d.prepare('INSERT INTO users (username, display_name, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(name, name, 'x', Date.now(), Date.now()).lastInsertRowid);
const addPasscode = (d, uid, hash, extra = {}) =>
  d.prepare('INSERT OR REPLACE INTO tele_passcodes (user_id, hash, idle_min, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(uid, hash, extra.idle ?? 15, extra.fails ?? 0, extra.until ?? null, Date.now());

// What deploy/panel-update.sh does with the app stopped: the backup takes the database's place.
function swapIn(dataDir, backupFile) {
  const dbf = path.join(dataDir, 'amorechat.db');
  for (const f of [`${dbf}-wal`, `${dbf}-shm`]) fs.rmSync(f, { force: true });
  fs.copyFileSync(backupFile, dbf);
}

test('restore of a backup from before the passcode (and before the table): the passcode stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-carry-'));
  start(dir); // a fresh database at the latest version
  const dbf = path.join(dir, 'amorechat.db');
  let live = new DatabaseSync(dbf);
  const alice = addUser(live, 'alice');
  const bob = addUser(live, 'bob');
  // A backup from a version before the passcode table existed (v25).
  const old = path.join(dir, 'amorechat-200001010000.db');
  await backup(live, old);
  {
    const d = new DatabaseSync(old);
    d.exec('DROP TABLE tele_passcodes; PRAGMA user_version = 25; PRAGMA journal_mode = DELETE;');
    d.close();
  }
  // After the backup: alice sets a passcode (and has 2 wrong tries, a lock running), carol registers and sets one.
  const until = Date.now() + 600_000;
  addPasscode(live, alice, 'scrypt$alice', { idle: 5, fails: 2, until });
  const carol = addUser(live, 'carol');
  addPasscode(live, carol, 'scrypt$carol');

  // Asked for from the panel: the rows of now are written next to the data.
  const carry = path.join(dir, CARRY_NAME);
  assert.equal(writeCarry(live, carry), 2);
  if (process.platform !== 'win32') assert.equal(fs.statSync(carry).mode & 0o777, 0o600, 'only the app may read it');
  const kept = JSON.parse(fs.readFileSync(carry, 'utf8'));
  assert.deepEqual(Object.keys(kept.rows[0]).sort(), ['fails', 'hash', 'idle_min', 'locked_until', 'updated_at', 'user_id']);
  assert.ok(!fs.existsSync(`${carry}.tmp`));
  live.close();

  // A CLI loading db.js while the app runs must not use the file up.
  assert.equal(start(dir, { apply: false }).r, 'not applied');
  assert.ok(fs.existsSync(carry));

  swapIn(dir, old);
  const r = start(dir);
  assert.equal(r.version >= 26, true, 'migrations ran first, the table is there');
  assert.deepEqual(r.r, { applied: 1, skipped: 1, newer: 0 }, 'carol is not in that backup: skipped');
  assert.deepEqual(r.rows, [{ user_id: alice, hash: 'scrypt$alice', idle_min: 5, fails: 2, locked_until: until }]);
  assert.ok(!fs.existsSync(carry), 'used once, then gone');
  // Next start: nothing more to do.
  assert.equal(start(dir).r, null);

  live = new DatabaseSync(dbf);
  assert.equal(live.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(bob).n, 1);
  live.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a union: passcodes only in the restored backup stay, those of now win', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-carry-'));
  start(dir);
  const live = new DatabaseSync(path.join(dir, 'amorechat.db'));
  const alice = addUser(live, 'alice');
  const bob = addUser(live, 'bob');
  addPasscode(live, alice, 'scrypt$alice-old');
  addPasscode(live, bob, 'scrypt$bob');
  const old = path.join(dir, 'amorechat-200001010000.db');
  await backup(live, old);
  // Since then: alice changed hers, bob removed his.
  addPasscode(live, alice, 'scrypt$alice-new', { idle: 60 });
  live.prepare('DELETE FROM tele_passcodes WHERE user_id = ?').run(bob);
  writeCarry(live, path.join(dir, CARRY_NAME));
  live.close();

  swapIn(dir, old);
  const r = start(dir);
  assert.deepEqual(r.r, { applied: 1, skipped: 0, newer: 0 });
  assert.deepEqual(
    r.rows.map((x) => [x.user_id, x.hash, x.idle_min]),
    [
      [alice, 'scrypt$alice-new', 60],
      [bob, 'scrypt$bob', 15],
    ],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a kept file that cannot be read is set aside as .corrupt (never silently dropped)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-carry-'));
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE tele_passcodes (user_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, idle_min INTEGER, fails INTEGER, locked_until INTEGER, updated_at INTEGER);');
  const carry = path.join(dir, CARRY_NAME);
  const corrupt = path.join(dir, CORRUPT_NAME);
  assert.equal(applyCarry(d, carry, corrupt), null, 'no file: nothing to do');
  for (const bad of ['{"rows":[{"user_id":1}', '{"rows":[{"user_id":1,"hash":"","idle_min":5,"fails":0,"locked_until":null,"updated_at":1}]}', '{}']) {
    fs.writeFileSync(carry, bad);
    const r = applyCarry(d, carry, corrupt);
    assert.equal(r.corrupt, true);
    assert.ok(!fs.existsSync(carry));
    assert.equal(fs.readFileSync(corrupt, 'utf8'), bad, 'kept for whoever looks into it');
    if (process.platform !== 'win32') assert.equal(fs.statSync(corrupt).mode & 0o777, 0o600);
  }
  // Nobody had a passcode: an empty list is fine.
  writeCarry(d, carry);
  assert.deepEqual(applyCarry(d, carry, corrupt), { applied: 0, skipped: 0, newer: 0 });
  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a kept row replaces one as new or older, never a newer one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-carry-'));
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); CREATE TABLE tele_passcodes (user_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, idle_min INTEGER, fails INTEGER, locked_until INTEGER, updated_at INTEGER NOT NULL);');
  for (const id of [1, 2, 3, 4]) d.prepare('INSERT INTO users (id) VALUES (?)').run(id);
  const put = d.prepare('INSERT OR REPLACE INTO tele_passcodes (user_id, hash, idle_min, fails, locked_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const carry = path.join(dir, CARRY_NAME);
  // What the carry holds.
  put.run(1, 'kept-1', 15, 0, null, 1000);
  put.run(2, 'kept-2', 15, 0, null, 1000);
  put.run(3, 'kept-3', 15, 2, 5000, 1000);
  put.run(4, 'kept-4', 15, 0, null, 1000);
  writeCarry(d, carry);
  // What the database has when it is applied.
  put.run(1, 'db-older', 30, 0, null, 999);
  put.run(2, 'db-same', 30, 0, null, 1000);
  put.run(3, 'db-newer', 60, 0, null, 1001);
  d.prepare('DELETE FROM tele_passcodes WHERE user_id = 4').run();
  assert.deepEqual(applyCarry(d, carry, path.join(dir, CORRUPT_NAME)), { applied: 3, skipped: 0, newer: 1 });
  assert.deepEqual(
    d.prepare('SELECT user_id, hash, idle_min, fails, locked_until, updated_at FROM tele_passcodes ORDER BY user_id').all().map((r) => ({ ...r })),
    [
      { user_id: 1, hash: 'kept-1', idle_min: 15, fails: 0, locked_until: null, updated_at: 1000 },
      { user_id: 2, hash: 'kept-2', idle_min: 15, fails: 0, locked_until: null, updated_at: 1000 },
      { user_id: 3, hash: 'db-newer', idle_min: 60, fails: 0, locked_until: null, updated_at: 1001 },
      { user_id: 4, hash: 'kept-4', idle_min: 15, fails: 0, locked_until: null, updated_at: 1000 },
    ],
  );
  assert.ok(!fs.existsSync(carry));
  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt kept file: the server starts, Telegram is closed for everyone, the rest works', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-carry-'));
  fs.writeFileSync(path.join(dir, CARRY_NAME), '{"rows":[{"user_');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(SRC, 'index.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (b) => (out += b));
  srv.stderr.on('data', (b) => (out += b));
  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, `server did not start: ${out.slice(-2000)}`);
    assert.ok(fs.existsSync(path.join(dir, CORRUPT_NAME)) && !fs.existsSync(path.join(dir, CARRY_NAME)));
    const code = out.match(/SETUP CODE: (\S+)/)[1];
    let cookie = '';
    const call = async (method, url, body) => {
      const h = { 'x-requested-with': 'amorechat' };
      if (cookie) h.cookie = cookie;
      if (body) h['content-type'] = 'application/json';
      const res = await fetch(base + url, { method, headers: h, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { http: res.status, ...(await res.json().catch(() => ({}))) };
    };
    const reg = await call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'O', invite: code });
    assert.equal(reg.http, 200, JSON.stringify(reg));
    assert.equal((await call('GET', '/api/chats')).http, 200, 'the rest of the app works');
    const st = await call('GET', '/api/tele/status');
    assert.deepEqual([st.locked, st.quarantined, st.account], [true, true, undefined]);
    const s = await call('GET', '/api/tele/sessions');
    assert.equal(s.http, 423, 'even without a passcode of their own');
    assert.match(s.error, /با مدیر سرور تماس بگیرید/);
    assert.equal((await call('POST', '/api/tele/passcode/unlock', { passcode: '12345' })).http, 423);
    assert.equal((await call('GET', '/api/tele/passcode')).unlocked, false);
    // The admins are told (alert in Saved Messages / panel).
    const db = new DatabaseSync(path.join(dir, 'amorechat.db'), { readOnly: true });
    let alert = null;
    for (let i = 0; i < 40 && !alert; i++) {
      alert = db.prepare("SELECT 1 AS ok FROM alerts WHERE key = 'tele-quarantine' AND resolved_at IS NULL").get();
      if (!alert) await new Promise((r) => setTimeout(r, 100));
    }
    db.close();
    assert.ok(alert, 'an alert was raised');
  } finally {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('start: unfinished backups (.partial) are removed, finished ones and others stay', async () => {
  const { BACKUP_DIR, cleanBackupsAtStart } = await import('../src/backup.js');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const names = ['amorechat-200001010000.db.partial', 'amorechat-200001010000.db.partial-journal'];
  const stay = ['amorechat-200001020000.db', 'before-restore-20000101000000.db', 'amorechat-200001020000.db.check.json'];
  for (const n of [...names, ...stay]) fs.writeFileSync(path.join(BACKUP_DIR, n), 'x');
  const log = { info() {}, warn() {} };
  cleanBackupsAtStart(log);
  for (const n of names) assert.ok(!fs.existsSync(path.join(BACKUP_DIR, n)), n);
  for (const n of stay) assert.ok(fs.existsSync(path.join(BACKUP_DIR, n)), n);
  for (const n of stay) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
});

test('start: with a passcode set, backups on disk are redacted once in the background', async () => {
  const { db, run, now } = await import('../src/db.js');
  const { BACKUP_DIR, redactBackupsAtStart } = await import('../src/backup.js');
  const errors = [];
  const log = { error: (...a) => errors.push(a) };
  const uid = Number(run('INSERT INTO users (username, display_name, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', 'zed', 'zed', 'x', now(), now()).lastInsertRowid);
  const acc = Number(run("INSERT INTO tele_accounts (user_id, display_name, created_at, updated_at) VALUES (?, 'z', ?, ?)", uid, now(), now()).lastInsertRowid);
  const dlg = Number(run("INSERT INTO tele_dialogs (account_id, tg_chat_id, title, created_at, updated_at) VALUES (?, '1', 'ZEDTITLE', ?, ?)", acc, now(), now()).lastInsertRowid);
  run("INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, text, created_at) VALUES (?, ?, 1, 'ZEDSECRET', ?)", acc, dlg, now());
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const keep = path.join(BACKUP_DIR, 'before-restore-20000101000000.db');
  await backup(db, keep);
  // Nobody has a passcode yet: left alone.
  redactBackupsAtStart(log);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readFileSync(keep).includes('ZEDSECRET'));
  run('INSERT INTO tele_passcodes (user_id, hash, updated_at) VALUES (?, ?, ?)', uid, 'h', now());
  redactBackupsAtStart(log);
  const clean = () => !fs.existsSync(`${keep}-journal`) && !fs.readFileSync(keep).includes('ZEDSECRET');
  for (let i = 0; i < 60 && !clean(); i++) await new Promise((r) => setTimeout(r, 250));
  assert.ok(clean(), 'the database of before the restore lost that history');
  assert.deepEqual(errors, []);
  fs.rmSync(keep, { force: true });
});
