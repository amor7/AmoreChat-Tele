// Names of channels copied from Telegram. Usage: DATA_DIR=/tmp/x node server/test/handles.test.mjs
import assert from 'node:assert/strict';
import { run, now } from '../src/db.js';
import { createChat } from '../src/chats.js';
import { assignMirrorHandle, checkHandle, handleTaken } from '../src/handles.js';

const channel = () => createChat({ type: 'channel', title: 'c', isPublic: true });
const owner = { role: 'owner' };
const user = { role: 'user' };

// Free: the digit name, and the original is kept.
const a = channel();
assert.equal(assignMirrorHandle(a, 'varzesh3', '-100123'), '1varzesh3');
assert.ok(handleTaken('varzesh3'), 'the original name is reserved');
assert.ok(handleTaken('VARZESH3'), 'whatever the case');
assert.ok(!handleTaken('varzesh3', a), 'but not against the channel itself');
assert.throws(() => checkHandle(user, 'varzesh3'), /گرفته شده/);

// Running again changes nothing.
assert.equal(assignMirrorHandle(a, 'varzesh3', '-100123'), '1varzesh3');

// The original belongs to a user: still a digit name, nothing reserved.
run('INSERT INTO users (username, display_name, password_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', 'news24', 'x', 'x', now(), now());
const b = channel();
assert.equal(assignMirrorHandle(b, 'news24', '-100124'), '1news24');

// The same name twice.
const c = channel();
assert.equal(assignMirrorHandle(c, 'varzesh3', '-100125'), '2varzesh3');

// A private Telegram channel has no name.
const d = channel();
assert.equal(assignMirrorHandle(d, '', '-100126'), '1tg100126');

// Digits are the owner's.
assert.throws(() => checkHandle(user, '1abc'), /مالک سرور/);
assert.equal(checkHandle(owner, '@1abc'), '1abc');

// A deleted channel frees its names.
run('DELETE FROM chats WHERE id = ?', a);
assert.ok(!handleTaken('varzesh3'));
assert.ok(!handleTaken('1varzesh3'));

console.log('handles: all checks passed');
