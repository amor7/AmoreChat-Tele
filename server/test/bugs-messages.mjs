// Regression checks for message / upload bugs: quota on single uploads, editing forwarded and
// call messages, demoted channel admins, hidden-members mentions, bogus read pointers, restricted
// users, repeated pins, replies to deleted messages, invisible-only text, forward budget, reactions.
// Usage: node test/bugs-messages.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
// With DATA_DIR set to the server's data folder, call-log messages are checked too.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { io } from 'socket.io-client';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let ipN = 10;
function client(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') {
  let cookie = '';
  const ip = `10.0.1.${ipN++}`; // separate per-IP rate-limit buckets
  async function call(method, url, body, { raw, headers = {}, rawBody } = {}) {
    const h = { 'x-requested-with': 'amorechat', 'user-agent': ua, 'x-forwarded-for': ip, ...headers };
    if (cookie) h.cookie = cookie;
    if (body && rawBody === undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: rawBody ?? (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  function sock() {
    return new Promise((ok, bad) => {
      const s = io(BASE, { extraHeaders: { cookie, 'x-forwarded-for': ip }, transports: ['websocket'] });
      s.events = [];
      s.onAny((e, d) => s.events.push([e, d]));
      s.on('connect', () => ok(s));
      s.on('connect_error', bad);
    });
  }
  return { call, sock, cookie: () => cookie };
}

const owner = client();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
r = await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open', allow_user_groups: '1' });
assert.equal(r.status, 200, JSON.stringify(r));

async function user(name) {
  const c = client();
  const res = await c.call('POST', '/api/auth/register', { username: name, password: PASS, displayName: name[0].toUpperCase() + name.slice(1) });
  assert.equal(res.status, 200, JSON.stringify(res));
  c.id = res.user.id;
  c.name = name;
  return c;
}
const step = (name) => console.log('-', name);
const newGroup = async (c, title, members) => (await c.call('POST', '/api/chats', { type: 'group', title, memberIds: members.map((m) => m.id) })).chat.id;
const send = async (c, chatId, body) => c.call('POST', `/api/chats/${chatId}/messages`, typeof body === 'string' ? { text: body } : body);
const history = async (c, chatId) => (await c.call('GET', `/api/chats/${chatId}/messages?limit=100`)).messages;
const summary = async (c, chatId) => (await c.call('GET', '/api/chats')).chats.find((x) => x.id === chatId);

const alice = await user('alice');
const bob = await user('bob');
const carol = await user('carol');
const dave = await user('dave');

// ---- 1. Single-request upload respects the storage quota ----
step('single upload: quota');
assert.equal((await owner.call('PATCH', `/api/admin/users/${carol.id}/limits`, { quota_mb: 1, upload_mb: 5 })).status, 200);
async function multipart(c, size) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(size, 1)], { type: 'application/octet-stream' }), 'f.bin');
  const res = await c.call('POST', '/api/upload', null, { raw: true, rawBody: fd });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
const usage = async (c) => (await c.call('GET', '/api/me/usage')).usedBytes;
r = await multipart(carol, 3 * 1024 * 1024);
assert.equal(r.status, 413, `3MB over a 1MB quota: ${r.status}`);
assert.equal(await usage(carol), 0, 'nothing stored');
r = await multipart(carol, 600 * 1024);
assert.equal(r.status, 201, `within the quota: ${r.status} ${r.error}`);
const carolFile = r.file;
r = await multipart(carol, 600 * 1024);
assert.equal(r.status, 413, `second upload passes the quota: ${r.status}`);
assert.equal(await usage(carol), 600 * 1024, 'only the first is stored');

// ---- Chunk with another content type: refused instead of an endless "same offset" ----
step('chunk with wrong content type');
r = await bob.call('POST', '/api/uploads', { size: 10, name: 'x.txt', mime: 'text/plain' });
assert.equal(r.status, 200);
const up = r.id;
r = await bob.call('PUT', `/api/uploads/${up}`, { a: 1 }, { headers: { 'upload-offset': '0' } });
assert.equal(r.status, 415, `json chunk: ${r.status}`);
r = await bob.call('PUT', `/api/uploads/${up}`, null, { headers: { 'upload-offset': '0', 'content-type': 'text/plain' }, rawBody: '0123456789' });
assert.equal(r.status, 415, `text chunk: ${r.status}`);
r = await bob.call('PUT', `/api/uploads/${up}`, null, { headers: { 'upload-offset': '0', 'content-type': 'application/octet-stream' }, rawBody: Buffer.from('0123456789') });
assert.equal(r.status, 201, `octet-stream chunk still works: ${r.status} ${r.error}`);

const G = await newGroup(alice, 'Bugs', [bob, carol]);

// ---- 13 (server side). A file's caption can be cleared ----
step('clear a file caption');
r = await send(carol, G, { fileId: carolFile.id, text: 'caption' });
assert.equal(r.status, 200, r.error);
r = await carol.call('PATCH', `/api/messages/${r.message.id}`, { text: '' });
assert.equal(r.status, 200, `empty caption: ${r.status} ${r.error}`);
assert.equal(r.message.text, '');

// ---- 2. A forwarded message can't be edited ----
step('edit forwarded');
const am = (await send(alice, G, 'original by alice')).message;
assert.equal((await bob.call('POST', `/api/messages/${am.id}/forward`, { chatIds: [G] })).status, 200);
const fwd = (await history(bob, G)).at(-1);
assert.ok(fwd.forwardedFrom, 'is a forward');
r = await bob.call('PATCH', `/api/messages/${fwd.id}`, { text: 'alice says she owes me money' });
assert.equal(r.status, 400, `edit forwarded: ${r.status}`);
assert.equal((await history(bob, G)).find((m) => m.id === fwd.id).text, 'original by alice');

// ---- 3. A demoted channel admin loses their posts ----
step('demoted channel admin');
const CH = (await alice.call('POST', '/api/chats', { type: 'channel', title: 'Chan', memberIds: [bob.id, dave.id] })).chat.id;
await alice.call('PATCH', `/api/chats/${CH}/members/${bob.id}`, { role: 'admin', perms: ['post_messages'] });
const post = (await send(bob, CH, 'official post')).message;
assert.ok(post?.id, 'admin posts');
r = await bob.call('PATCH', `/api/messages/${post.id}`, { text: 'official post (edited)' });
assert.equal(r.status, 200, `admin edits: ${r.error}`);
await alice.call('PATCH', `/api/chats/${CH}/members/${bob.id}`, { role: 'member' });
assert.equal((await bob.call('PATCH', `/api/messages/${post.id}`, { text: 'hacked' })).status, 403, 'demoted edit');
assert.equal((await bob.call('DELETE', `/api/messages/${post.id}`)).status, 403, 'demoted delete');
const seen = (await history(dave, CH)).find((m) => m.id === post.id);
assert.equal(seen.type, 'text');
assert.equal(seen.text, 'official post (edited)');
// The channel owner still can.
assert.equal((await alice.call('PATCH', `/api/messages/${post.id}`, { text: 'by owner' })).status, 200);

// ---- 4. Hidden member list: mentions don't reveal members ----
step('hidden members: mentions');
const H = await newGroup(alice, 'Hidden', [bob, carol, dave]);
assert.equal((await alice.call('PATCH', `/api/chats/${H}`, { hideMembers: true })).status, 200);
const sCarol = await carol.sock();
const sDave = await dave.sock();
await sleep(200);
r = await send(bob, H, `hi @${carol.name} and @owner`);
const hm = r.message;
assert.deepEqual(hm.mentions, [], 'sender sees no ids');
await sleep(300);
const evOf = (s, id) => s.events.find(([e, d]) => e === 'message:new' && d.id === id)?.[1];
assert.deepEqual(evOf(sDave, hm.id)?.mentions, [], 'live copy for another member');
assert.deepEqual(evOf(sCarol, hm.id)?.mentions, [carol.id], 'the mentioned member learns it');
assert.equal(sCarol.events.filter(([e, d]) => e === 'message:new' && d.id === hm.id).length, 1, 'once');
assert.deepEqual((await history(dave, H)).find((m) => m.id === hm.id).mentions, [], 'history for another member');
assert.deepEqual((await history(carol, H)).find((m) => m.id === hm.id).mentions, [carol.id], 'history for the mentioned');
assert.equal((await summary(carol, H)).unreadMentions, 1, 'unread mention still counted');
// Probing by editing: still nothing.
r = await bob.call('PATCH', `/api/messages/${hm.id}`, { text: `@${carol.name} @${dave.name} @nobody_here` });
assert.equal(r.status, 200);
assert.deepEqual(r.message.mentions, [], 'edit reply');
r = await bob.call('POST', `/api/messages/${hm.id}/react`, { emoji: '👍' });
assert.deepEqual(r.message.mentions, [], 'react reply');
await sleep(300);
const edits = sDave.events.filter(([e, d]) => e === 'message:edit' && d.id === hm.id);
// Dave is named in the edit too: he learns only about himself, never about carol.
assert.ok(edits.length >= 2, `live edits: ${edits.length}`);
for (const [, d] of edits) assert.deepEqual(d.mentions, [dave.id], 'live edit for a mentioned member: only himself');
sCarol.close();
sDave.close();
// An open member list still shows them.
r = await send(bob, G, `hey @${carol.name}`);
assert.deepEqual(r.message.mentions, [carol.id], 'normal group');

// ---- 5. A made-up read pointer is clamped ----
step('bogus read pointer');
const R = await newGroup(alice, 'Reads', [bob, carol]);
assert.equal((await carol.call('POST', `/api/chats/${R}/read`, { messageId: 2147483647 })).status, 200);
const nm = (await send(bob, R, 'new after')).message;
assert.ok((await summary(bob, R)).othersRead < nm.id, 'a new message is not shown as read');
r = await bob.call('GET', `/api/messages/${nm.id}/readers`);
assert.deepEqual(r.readers.map((u) => u.id), [], 'nobody read it yet');
assert.equal((await carol.call('POST', `/api/chats/${R}/read`, { messageId: nm.id })).status, 200);
assert.ok((await summary(bob, R)).othersRead >= nm.id, 'reading for real still works');

// ---- 6. Call logs: no edit, no forward ----
if (process.env.DATA_DIR) {
  step('call log');
  const { DatabaseSync } = await import('node:sqlite');
  const dm = (await alice.call('POST', '/api/chats/dm', { userId: bob.id })).chat.id;
  const db = new DatabaseSync(path.join(process.env.DATA_DIR, fs.existsSync(path.join(process.env.DATA_DIR, 'amorechat.db')) ? 'amorechat.db' : fs.readdirSync(process.env.DATA_DIR).find((f) => f.endsWith('.db'))));
  const callId = Number(
    db.prepare("INSERT INTO messages (chat_id, sender_id, type, text, created_at) VALUES (?, ?, 'call', ?, ?)").run(dm, alice.id, JSON.stringify({ video: false, status: 'missed', duration: 0 }), Date.now()).lastInsertRowid,
  );
  db.close();
  assert.equal((await alice.call('PATCH', `/api/messages/${callId}`, { text: '{"status":"ended","duration":3600}' })).status, 400, 'edit call');
  assert.equal((await alice.call('POST', `/api/messages/${callId}/forward`, { chatIds: [G] })).status, 400, 'forward call');
} else console.log('  (skipped call-log checks: DATA_DIR not set)');

// ---- 7. "send" restriction also covers edits and reactions ----
step('restricted user');
const bm = (await send(bob, G, 'before restriction')).message;
assert.equal((await owner.call('POST', `/api/admin/users/${bob.id}/restrict`, { send: 1 })).status, 200);
assert.equal((await send(bob, G, 'x')).status, 403);
assert.equal((await bob.call('PATCH', `/api/messages/${bm.id}`, { text: 'spam via edit' })).status, 403, 'edit');
assert.equal((await bob.call('POST', `/api/messages/${am.id}/react`, { emoji: '👍' })).status, 403, 'react');
assert.equal((await owner.call('POST', `/api/admin/users/${bob.id}/restrict`, { send: 0 })).status, 200);
assert.equal((await bob.call('PATCH', `/api/messages/${bm.id}`, { text: 'fine again' })).status, 200);

// ---- 8. Pinning the same message again posts no new notice ----
step('repeated pin');
const P = await newGroup(alice, 'Pins', [bob]);
const pm = (await send(alice, P, 'to pin')).message;
for (let i = 0; i < 3; i++) assert.equal((await alice.call('POST', `/api/messages/${pm.id}/pin`, {})).status, 200);
const notices = async () => (await history(alice, P)).filter((m) => m.type === 'system' && m.text.includes('سنجاق')).length;
assert.equal(await notices(), 1, 'one notice');
await alice.call('POST', `/api/messages/${pm.id}/pin`, { pinned: false });
await alice.call('POST', `/api/messages/${pm.id}/pin`, { pinned: false });
assert.equal((await alice.call('GET', `/api/chats/${P}/pinned`)).messages.length, 0);
await alice.call('POST', `/api/messages/${pm.id}/pin`, {});
assert.equal(await notices(), 2, 'pinning again after unpinning is a new notice');

// ---- 9. Replies to deleted messages ----
step('reply to deleted');
const gone = (await send(bob, G, 'to delete')).message;
assert.equal((await bob.call('DELETE', `/api/messages/${gone.id}`)).status, 200);
r = await send(alice, G, { text: 'reply to deleted', replyTo: gone.id });
assert.equal(r.status, 200);
assert.equal(r.message.replyTo, null, 'no quote of a deleted message');
assert.deepEqual(r.message.mentions, [], 'its author is not mentioned');
const live = (await send(bob, G, 'will be deleted later')).message;
const reply = (await send(alice, G, { text: 'replying', replyTo: live.id })).message;
assert.deepEqual(reply.mentions, [bob.id]);
await bob.call('DELETE', `/api/messages/${live.id}`);
r = await alice.call('PATCH', `/api/messages/${reply.id}`, { text: 'replying (edited)' });
assert.deepEqual(r.message.mentions, [], 'edit after the replied message was deleted');

// ---- 10. Text of only invisible characters ----
step('invisible-only text');
for (const t of ['​', '‏‎', ' ⁦⁩ ', '﻿‮']) {
  assert.equal((await send(alice, G, t)).status, 400, `send ${JSON.stringify(t)}`);
}
assert.equal((await alice.call('PATCH', `/api/messages/${am.id}`, { text: '​‌' })).status, 400, 'edit to invisible');
r = await send(alice, G, '‏سلام');
assert.equal(r.status, 200, 'a mark next to real text is fine');

// ---- 11. Forwards to chats it can't go to don't use up the send budget ----
step('forward to invalid targets');
for (let i = 0; i < 4; i++) {
  r = await dave.call('POST', `/api/messages/${post.id}/forward`, { chatIds: Array.from({ length: 20 }, (_, k) => 900000 + k) });
  assert.equal(r.status, 400, `invalid forward ${i}: ${r.status}`);
}
const daveSaved = (await dave.call('GET', '/api/chats')).chats.find((c) => c.type === 'saved').id;
assert.equal((await send(dave, daveSaved, 'still allowed')).status, 200, 'send after invalid forwards');
r = await dave.call('POST', `/api/messages/${post.id}/forward`, { chatIds: [daveSaved, 900001] });
assert.deepEqual(r.sent, [daveSaved], 'valid target still gets it');

// ---- Reactions: not on system notices, no control characters ----
step('reactions');
const sys = (await history(alice, P)).find((m) => m.type === 'system');
assert.equal((await alice.call('POST', `/api/messages/${sys.id}/react`, { emoji: '👍' })).status, 400, 'system notice');
for (const e of ['‮👍', '👍‏', '⁦x', 'a\u0007']) {
  assert.equal((await alice.call('POST', `/api/messages/${am.id}/react`, { emoji: e })).status, 400, `reaction ${JSON.stringify(e)}`);
}
for (const e of ['👍', '👨‍👩‍👧', '❤️']) {
  assert.equal((await alice.call('POST', `/api/messages/${am.id}/react`, { emoji: e })).status, 200, `reaction ${e}`);
}

console.log('BUGS-MESSAGES TEST PASSED');
process.exit(0);
