// TDLib session folders that no account row owns are removed (ids of tele_accounts can be given out
// again), the session key and anything not named by a number stay; a new account starts from an
// empty folder. Usage: DATA_DIR=/tmp/x node --test server/test/tele-orphans.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { pruneOrphanSessions, wipeSessionDir, sessionsRoot } from '../src/tele/session-dirs.js';

const SRC = path.resolve(import.meta.dirname, '../src');

// A session folder as TDLib leaves it: a database and downloaded files.
function fakeSession(root, name) {
  fs.mkdirSync(path.join(root, name, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, name, 'files'), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'db', 'td.binlog'), 'auth keys of ' + name);
}

test('only numbered folders without an account row go; .key, other names, files stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-orphans-'));
  const root = sessionsRoot(dir);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE tele_accounts (id INTEGER PRIMARY KEY, user_id INTEGER)');
  db.prepare('INSERT INTO tele_accounts (id, user_id) VALUES (?, ?)').run(1, 10);
  db.prepare('INSERT INTO tele_accounts (id, user_id) VALUES (?, ?)').run(3, 30);
  assert.deepEqual(pruneOrphanSessions(db, root), [], 'no folder yet (Telegram never used): nothing to do');
  for (const n of ['1', '2', '3', '7', 'abc', '007', 'tmp-4']) fakeSession(root, n);
  fs.writeFileSync(path.join(root, '.key'), 'the session key');
  fs.writeFileSync(path.join(root, '5'), 'a file named by a number');

  const removed = pruneOrphanSessions(db, root).sort();
  assert.deepEqual(removed, ['2', '7']);
  for (const n of ['2', '7']) assert.ok(!fs.existsSync(path.join(root, n)), n);
  for (const n of ['1', '3']) assert.equal(fs.readFileSync(path.join(root, n, 'db', 'td.binlog'), 'utf8'), 'auth keys of ' + n, 'an account with a row keeps its session');
  for (const n of ['abc', '007', 'tmp-4']) assert.ok(fs.existsSync(path.join(root, n)), `not an account id: ${n}`);
  assert.equal(fs.readFileSync(path.join(root, '.key'), 'utf8'), 'the session key');
  assert.ok(fs.statSync(path.join(root, '5')).isFile());
  assert.deepEqual(pruneOrphanSessions(db, root), [], 'a second pass changes nothing');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a new account id starts from an empty folder; only that folder is touched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-orphans-'));
  const root = sessionsRoot(dir);
  fakeSession(root, '4');
  fakeSession(root, '40');
  fs.writeFileSync(path.join(root, '.key'), 'k');
  wipeSessionDir(root, 4);
  assert.ok(!fs.existsSync(path.join(root, '4')));
  assert.ok(fs.existsSync(path.join(root, '40', 'db', 'td.binlog')));
  assert.equal(fs.readFileSync(path.join(root, '.key'), 'utf8'), 'k');
  wipeSessionDir(root, 9); // nothing there: fine
  for (const bad of [0, -1, 'x', '../4', 1.5, null]) assert.throws(() => wipeSessionDir(root, bad), /bad account id/, String(bad));
  assert.ok(fs.existsSync(root), 'the root itself stays');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('server start: a session left by a restored-away account is removed, the rest stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-orphans-'));
  // The database as an older backup has it: one account (id 1), migrated by db.js.
  const code = `
    const { run, now } = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'db.js')).href)});
    const uid = Number(run('INSERT INTO users (username, display_name, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', 'a', 'a', 'x', now(), now()).lastInsertRowid);
    run('INSERT INTO tele_accounts (id, user_id, created_at, updated_at) VALUES (1, ?, ?, ?)', uid, now(), now());`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: dir } });
  const root = sessionsRoot(dir);
  fakeSession(root, '1');
  fakeSession(root, '2'); // the account that was added after that backup
  fs.writeFileSync(path.join(root, '.key'), 'the session key');

  const port = 30000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(SRC, 'index.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (b) => (out += b));
  srv.stderr.on('data', (b) => (out += b));
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, `server did not start: ${out.slice(-2000)}`);
    assert.ok(!fs.existsSync(path.join(root, '2')), 'the orphan is gone');
    assert.ok(fs.existsSync(path.join(root, '1', 'db', 'td.binlog')), 'the account in the database keeps its session');
    assert.equal(fs.readFileSync(path.join(root, '.key'), 'utf8'), 'the session key');
    assert.match(out, /removed 1 session folder\(s\) with no account: 2/);
  } finally {
    srv.kill();
    await new Promise((r) => srv.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
