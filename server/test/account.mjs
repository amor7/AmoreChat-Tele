// v0.5 test: devices, two-step login, password change, lockout, mentions, mute,
// "seen by", media gallery and owner-only backups.
// Usage: node test/account.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { io } from 'socket.io-client';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let ipN = 10;
function client(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') {
  let cookie = '';
  const ip = `10.0.0.${ipN++}`; // separate per-IP rate-limit buckets
  async function call(method, url, body, { raw } = {}) {
    const h = { 'x-requested-with': 'amorechat', 'user-agent': ua, 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return { call, cookie: () => cookie, setCookie: (c) => (cookie = c) };
}

// RFC 6238 code computed independently of the server code.
function totp(secret, offset = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const owner = client();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' });

// ---- Password rules ----
const weak = client();
for (const p of ['short1', 'password123', 'aaaaaaaaaa', 'alice-secret-1']) {
  r = await weak.call('POST', '/api/auth/register', { username: 'alice', password: p, displayName: 'A' });
  assert.equal(r.status, 400, `weak password accepted: ${p}`);
}

const alice = client('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile');
r = await alice.call('POST', '/api/auth/register', { username: 'alice', password: PASS, displayName: 'Alice' });
const aliceId = r.user.id;
const bob = client();
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: PASS, displayName: 'Bob' });
const bobId = r.user.id;

// ---- Devices ----
const alice2 = client('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1');
r = await alice2.call('POST', '/api/auth/login', { username: 'alice', password: PASS });
assert.equal(r.status, 200);
r = await alice.call('GET', '/api/me/sessions');
assert.equal(r.sessions.length, 2);
assert.equal(r.sessions.filter((s) => s.current).length, 1);
assert.ok(r.sessions.some((s) => /Android/.test(s.device)), JSON.stringify(r.sessions));
const other = r.sessions.find((s) => !s.current);
// New-login note in Saved Messages
const saved = (await alice.call('GET', '/api/chats')).chats.find((c) => c.type === 'saved');
const notes = (await alice.call('GET', `/api/chats/${saved.id}/messages`)).messages;
assert.ok(notes.some((m) => m.type === 'system' && m.text.includes('ورود جدید')));

// A revoked device is disconnected from realtime too
const sock = io(BASE, { extraHeaders: { cookie: alice2.cookie() }, transports: ['websocket'] });
await new Promise((ok, bad) => (sock.on('connect', ok), sock.on('connect_error', bad)));
const rtt = await new Promise((ok) => {
  const t = Date.now();
  sock.emit('rtt', t, () => ok(Date.now() - t));
});
assert.ok(rtt < 1000, 'ping ack');
let kicked = false;
sock.on('disconnect', () => (kicked = true));
r = await alice.call('DELETE', `/api/me/sessions/${other.id}`);
assert.equal(r.ok, true);
await sleep(300);
assert.ok(kicked, 'socket of the revoked device disconnected');
sock.close();
assert.equal((await alice2.call('GET', '/api/auth/me')).status, 401);
r = await bob.call('DELETE', `/api/me/sessions/${(await alice.call('GET', '/api/me/sessions')).sessions[0].id}`);
assert.equal(r.status, 404, "can't revoke someone else's device");

// ---- Password change logs out the other devices ----
await alice2.call('POST', '/api/auth/login', { username: 'alice', password: PASS });
r = await alice.call('POST', '/api/auth/password', { current: PASS, next: PASS });
assert.equal(r.status, 400, 'same password rejected');
r = await alice.call('POST', '/api/auth/password', { current: PASS, next: 'Better-Pass-88' });
assert.equal(r.loggedOut, 1);
assert.equal((await alice2.call('GET', '/api/auth/me')).status, 401, 'old device logged out');
assert.equal((await alice.call('GET', '/api/auth/me')).status, 200, 'this device stays');
const APASS = 'Better-Pass-88';

// ---- Two-step login ----
r = await alice.call('POST', '/api/me/2fa/setup', { password: 'wrong' });
assert.equal(r.status, 400);
r = await alice.call('POST', '/api/me/2fa/setup', { password: APASS });
assert.ok(r.uri.startsWith('otpauth://totp/'), r.uri);
const secret = r.secret;
r = await alice.call('POST', '/api/me/2fa/enable', { code: '000000' === totp(secret) ? '111111' : '000000' });
assert.equal(r.status, 400);
r = await alice.call('POST', '/api/me/2fa/enable', { code: totp(secret) });
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.recoveryCodes.length, 8);
assert.equal(r.user.twoFactor, true);
const recovery = r.recoveryCodes;

const a3 = client();
r = await a3.call('POST', '/api/auth/login', { username: 'alice', password: APASS });
assert.equal(r.twoFactor, true);
assert.ok(!a3.cookie(), 'no session before the second step');
const ticket = r.ticket;
r = await a3.call('POST', '/api/auth/2fa', { ticket, code: '12345' });
assert.equal(r.status, 401);
r = await a3.call('POST', '/api/auth/2fa', { ticket, code: totp(secret) });
assert.equal(r.status, 401, 'a code that was already used (enable step) cannot be replayed');
r = await a3.call('POST', '/api/auth/2fa', { ticket, code: recovery[0] });
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal((await a3.call('GET', '/api/auth/me')).user.username, 'alice');
// A recovery code works only once
const a4 = client();
r = await a4.call('POST', '/api/auth/login', { username: 'alice', password: APASS });
r = await a4.call('POST', '/api/auth/2fa', { ticket: r.ticket, code: recovery[0] });
assert.equal(r.status, 401);
r = await alice.call('GET', '/api/me/2fa');
assert.deepEqual(r, { status: 200, enabled: true, recoveryCodesLeft: 7 });

// Admin can reset a lost authenticator
r = await bob.call('POST', `/api/admin/users/${aliceId}/reset-2fa`);
assert.equal(r.status, 403);
r = await owner.call('POST', `/api/admin/users/${aliceId}/reset-2fa`);
assert.equal(r.ok, true);
r = await a4.call('POST', '/api/auth/login', { username: 'alice', password: APASS });
assert.ok(r.user, 'no second step after reset');
r = await owner.call('POST', `/api/admin/users/${aliceId}/logout-all`);
assert.ok(r.loggedOut >= 3);
assert.equal((await alice.call('GET', '/api/auth/me')).status, 401);
await alice.call('POST', '/api/auth/login', { username: 'alice', password: APASS });

// ---- Account lockout after 10 wrong passwords ----
const mallory = client();
for (let i = 0; i < 10; i++) {
  r = await mallory.call('POST', '/api/auth/login', { username: 'bob', password: 'nope' + i, });
  if (r.status === 429 && i < 9) break; // per-IP limiter may trigger first
}
r = await client().call('POST', '/api/auth/login', { username: 'bob', password: PASS });
assert.equal(r.status, 429, 'locked even with the right password');

// ---- Mentions & per-chat mute ----
r = await owner.call('POST', '/api/chats', { type: 'group', title: 'تیم', memberIds: [aliceId, bobId] });
const g = r.chat.id;
r = await alice.call('PATCH', `/api/chats/${g}/notify`, { mutedUntil: -1 });
assert.ok(r.notifyMutedUntil > Date.now());
r = await owner.call('POST', `/api/chats/${g}/messages`, { text: 'سلام @alice و @nobody' });
assert.deepEqual(r.message.mentions, [aliceId]);
const m1 = r.message.id;
r = await owner.call('POST', `/api/chats/${g}/messages`, { text: 'email a@alice.com is not a mention' });
assert.deepEqual(r.message.mentions, []);
r = await alice.call('GET', '/api/chats');
let sum = r.chats.find((c) => c.id === g);
assert.equal(sum.unreadMentions, 1);
assert.ok(sum.notifyMutedUntil);
// Reply to someone = mention
r = await alice.call('POST', `/api/chats/${g}/messages`, { text: 'باشه', replyTo: m1 });
assert.deepEqual(r.message.mentions, [(await owner.call('GET', '/api/auth/me')).user.id]);
r = await alice.call('PATCH', `/api/chats/${g}/notify`, { mutedUntil: null });
assert.equal(r.notifyMutedUntil, null);

// ---- Seen by ----
r = await owner.call('GET', `/api/messages/${m1}/readers`);
assert.deepEqual(r.readers.map((u) => u.id), [aliceId], 'alice posted after it, so she read it');
assert.equal(r.total, 2);
r = await bob.call('GET', `/api/messages/${m1}/readers`);
assert.equal(r.status, 403, 'only the sender sees readers');

// ---- Media gallery ----
await owner.call('POST', `/api/chats/${g}/messages`, { text: 'ببین https://example.com/x' });
r = await bob.call('GET', `/api/chats/${g}/media?kind=links`);
assert.equal(r.messages.length, 1);
r = await bob.call('GET', `/api/chats/${g}/media?kind=media`);
assert.equal(r.messages.length, 0);

// ---- Android app: background notification stream (server-sent events) ----
async function openStream(cl) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/notify/stream`, { headers: { cookie: cl.cookie(), 'x-forwarded-for': '10.0.8.8' }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  let closed = false;
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('data:')) events.push(JSON.parse(block.slice(5)));
        }
      }
    } catch {
      /* aborted */
    }
    closed = true;
  })();
  return { events, close: () => ctrl.abort(), isClosed: () => closed };
}
// A fresh user (bob is locked out by the lockout test above)
const dave = client();
r = await dave.call('POST', '/api/auth/register', { username: 'dave', password: PASS, displayName: 'Dave' });
const daveId = r.user.id;
await owner.call('POST', `/api/chats/${g}/members`, { userIds: [daveId] });
const bobStream = await openStream(dave);
await sleep(100);
await alice.call('POST', `/api/chats/${g}/messages`, { text: 'سلام دیو' });
await sleep(200);
let ev = bobStream.events.at(-1);
assert.equal(ev.type, 'message');
assert.equal(ev.chatId, g);
assert.equal(ev.title, 'تیم');
assert.equal(ev.body, 'Alice: سلام دیو');
assert.equal(ev.mentioned, false);
await dave.call('PATCH', `/api/chats/${g}/notify`, { mutedUntil: -1 });
let n = bobStream.events.length;
await alice.call('POST', `/api/chats/${g}/messages`, { text: 'بی‌صدا' });
await alice.call('POST', `/api/chats/${g}/messages`, { text: 'ولی @dave ببین' });
await sleep(200);
assert.equal(bobStream.events.length, n + 1, 'muted chat: only the mention gets through');
assert.equal(bobStream.events.at(-1).mentioned, true);
await dave.call('PATCH', `/api/chats/${g}/notify`, { mutedUntil: null });
await dave.call('POST', `/api/chats/${g}/read`, { messageId: 1e9 });
await sleep(100);
assert.deepEqual(bobStream.events.at(-1), { type: 'read', chatId: g }, 'reading clears the phone notification');
n = bobStream.events.length;
await dave.call('POST', `/api/chats/${g}/messages`, { text: 'خودم' });
await sleep(150);
assert.equal(bobStream.events.length, n, 'no notification for my own message');
// Logging that device out closes its stream
const sid = (await dave.call('GET', '/api/me/sessions')).sessions.find((x) => x.current).id;
await dave.call('DELETE', `/api/me/sessions/${sid}`);
await sleep(300);
assert.ok(bobStream.isClosed(), 'stream closed when the session is revoked');

// ---- Android app download page ----
let res2 = await fetch(`${BASE}/app`);
assert.equal(res2.status, 200);
assert.match(await res2.text(), /اندروید/);
r = await alice.call('GET', '/api/app/android');
assert.ok('apk' in r);

// ---- Resumable uploads ----
async function putChunk(cl, id, offset, buf) {
  const res = await fetch(`${BASE}/api/uploads/${id}`, {
    method: 'PUT',
    headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/octet-stream', 'upload-offset': String(offset), cookie: cl.cookie(), 'x-forwarded-for': '10.0.9.9' },
    body: buf,
  });
  return { status: res.status, ...(await res.json()) };
}
const data = crypto.randomBytes(9 * 1024 * 1024 + 123); // 3 chunks of 4 MB
r = await alice.call('POST', '/api/uploads', { name: 'big.bin', size: data.length, mime: 'application/octet-stream' });
assert.equal(r.offset, 0);
const up = r.id;
const CH = r.chunkSize;
r = await putChunk(alice, up, 0, data.subarray(0, CH));
assert.equal(r.offset, CH);
// Connection dropped after the server got the chunk: the client resends it from offset 0
r = await putChunk(alice, up, 0, data.subarray(0, CH));
assert.equal(r.status, 409);
assert.equal(r.offset, CH, 'server tells where to continue');
assert.equal((await alice.call('GET', `/api/uploads/${up}`)).offset, CH);
assert.equal((await bob.call('GET', `/api/uploads/${up}`)).status, 404, "someone else's upload");
r = await putChunk(alice, up, CH, data.subarray(CH, 2 * CH));
r = await putChunk(alice, up, 2 * CH, data.subarray(2 * CH));
assert.equal(r.status, 201, JSON.stringify(r));
assert.equal(r.file.size, data.length);
const got = Buffer.from(await (await alice.call('GET', `/api/files/${r.file.id}?download=1`, null, { raw: true })).arrayBuffer());
assert.ok(got.equals(data), 'reassembled file is identical');
assert.equal((await alice.call('GET', `/api/uploads/${up}`)).status, 404, 'session closed');
await owner.call('PATCH', '/api/admin/settings', { max_upload_mb: 1 });
r = await bob.call('POST', '/api/uploads', { name: 'x', size: 2 * 1024 * 1024 });
assert.equal(r.status, 413, 'size limit checked before uploading anything');
await owner.call('PATCH', '/api/admin/settings', { max_upload_mb: 100 });
r = await bob.call('POST', '/api/uploads', { name: 'x', size: 10 });
assert.equal((await bob.call('DELETE', `/api/uploads/${r.id}`)).ok, true, 'cancel');
r = await bob.call('POST', '/api/uploads', { name: 'empty.txt', size: 0 });
assert.equal((await putChunk(bob, r.id, 0, Buffer.alloc(0))).status, 201, 'empty file');

// ---- Pinned chats and folders ----
r = await alice.call('PATCH', `/api/chats/${g}/pin`, { pinned: true });
assert.ok(r.chat.pinnedAt > 0);
assert.ok((await alice.call('GET', '/api/chats')).chats.find((c) => c.id === g).pinnedAt);
r = await alice.call('POST', '/api/folders', { name: 'کار', emoji: '💼', filters: ['groups', 'bogus'], chatIds: [g, 999999] });
assert.deepEqual(r.folder.filters, ['groups']);
assert.deepEqual(r.folder.chatIds, [g], 'only chats I am in');
const fid = r.folder.id;
r = await alice.call('PATCH', `/api/folders/${fid}`, { name: 'کار و تیم' });
assert.equal(r.folder.name, 'کار و تیم');
assert.equal((await bob.call('PATCH', `/api/folders/${fid}`, { name: 'x' })).status, 404, "someone else's folder");
assert.equal((await alice.call('POST', '/api/folders', { name: 'خالی' })).status, 400);
assert.equal((await alice.call('GET', '/api/folders')).folders.length, 1);
await alice.call('DELETE', `/api/folders/${fid}`);
assert.equal((await alice.call('GET', '/api/folders')).folders.length, 0);
r = await alice.call('POST', `/api/chats/${g}/read-all`);
assert.equal(r.chat.unread, 0);
await alice.call('PATCH', `/api/chats/${g}/pin`, { pinned: false });

// ---- Health dashboard ----
r = await owner.call('GET', '/api/admin/health?range=1h');
assert.equal(r.status, 200, JSON.stringify(r));
assert.ok(r.now.memTotal > 0 && r.now.diskTotal > 0, 'memory and disk measured');
assert.ok(Array.isArray(r.series) && Array.isArray(r.alerts));
assert.equal(r.mirror.enabled, false);
assert.equal((await alice.call('GET', '/api/admin/health')).status, 403);

// ---- Backups: owner only ----
r = await alice.call('GET', '/api/admin/backups');
assert.equal(r.status, 403);
r = await owner.call('POST', '/api/admin/backups');
assert.ok(/^amorechat-\d+\.db$/.test(r.name));
r = await owner.call('GET', '/api/admin/backups');
assert.equal(r.files.length, 1);
let res = await owner.call('GET', '/api/admin/backup/db', null, { raw: true });
let buf = Buffer.from(await res.arrayBuffer());
assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
res = await owner.call('GET', `/api/admin/backups/${r.files[0].name}`, null, { raw: true });
assert.equal(res.status, 200);
res = await owner.call('GET', '/api/admin/backups/..%2Famorechat.db', null, { raw: true });
assert.equal(res.status, 400);
res = await owner.call('GET', '/api/admin/backup/full', null, { raw: true });
buf = Buffer.from(await res.arrayBuffer());
assert.equal(buf.subarray(257, 262).toString(), 'ustar');
assert.equal(buf.subarray(0, 12).toString(), 'amorechat.db');
assert.equal(buf.length % 512, 0);
res = await alice.call('GET', '/api/admin/backup/full', null, { raw: true });
assert.equal(res.status, 403);

// ---- Channels like Telegram: only the channel's owner / admins (with the right) post ----
const chOwner = client();
const siteMod = client();
const reader = client();
const editor = client();
const ids = {};
for (const [c, n] of [[chOwner, 'chowner'], [siteMod, 'sitemod'], [reader, 'reader'], [editor, 'editor']]) {
  r = await c.call('POST', '/api/auth/register', { username: n, password: PASS, displayName: n });
  assert.equal(r.status, 200, JSON.stringify(r));
  ids[n] = r.user.id;
}
r = await owner.call('PATCH', `/api/admin/users/${ids.sitemod}`, { role: 'admin', adminPerms: ['manage_chats'] });
assert.equal(r.status, 200);
const chan = (await chOwner.call('POST', '/api/chats', { type: 'channel', title: 'News', isPublic: true })).chat.id;
for (const c of [siteMod, reader, editor]) assert.equal((await c.call('POST', `/api/chats/${chan}/join`)).status, 200);
const post = (c, text) => c.call('POST', `/api/chats/${chan}/messages`, { text });
assert.equal((await post(chOwner, 'from the owner')).status, 200, 'channel owner posts');
assert.equal((await post(reader, 'from a member')).status, 403, 'a member who joined cannot post');
assert.equal((await post(siteMod, 'from a site admin')).status, 403, 'a site admin who joined cannot post either');
assert.equal((await post(owner, 'from the site owner')).status, 403, 'nor the site owner (not a member)');
await chOwner.call('PATCH', `/api/chats/${chan}/members/${ids.editor}`, { role: 'admin', perms: [] });
assert.equal((await post(editor, 'admin without the right')).status, 403, 'admin without "post messages"');
await chOwner.call('PATCH', `/api/chats/${chan}/members/${ids.editor}`, { role: 'admin', perms: ['post_messages'] });
assert.equal((await post(editor, 'from the editor')).status, 200, 'admin with "post messages" posts');
r = await reader.call('GET', `/api/chats/${chan}`);
assert.equal(r.chat?.myRole, 'member');
// Subscriber list: only the channel's owner and admins see it (a site admin who joined does not).
const seen = async (c, chatId) => (await c.call('GET', `/api/chats/${chatId}`)).members.map((u) => u.id).sort();
const everyone = [ids.chowner, ids.sitemod, ids.reader, ids.editor].sort();
assert.deepEqual(await seen(chOwner, chan), everyone, 'channel owner sees all subscribers');
assert.deepEqual(await seen(editor, chan), everyone, 'channel admin sees all subscribers');
assert.deepEqual(await seen(reader, chan), [ids.reader], 'a subscriber sees only themselves');
assert.deepEqual(await seen(siteMod, chan), [ids.sitemod], 'a site admin who subscribed sees only themselves');
assert.equal((await reader.call('GET', `/api/chats/${chan}`)).membersHidden, true);
// Voice channels: everyone sees who is in it.
const lounge = (await chOwner.call('POST', '/api/chats', { type: 'voice', title: 'Lounge', isPublic: true })).chat.id;
await reader.call('POST', `/api/chats/${lounge}/join`);
assert.deepEqual(await seen(reader, lounge), [ids.chowner, ids.reader].sort(), 'voice channel members are visible to all');
// The site admin can still delete the channel from the panel.
assert.equal((await siteMod.call('DELETE', `/api/chats/${chan}`)).status, 200, 'site admin deletes the channel');

// ---- Finding people: strangers only by the exact username; profiles/DMs not by walking ids ----
const pa = client();
const pb = client();
const pc = client();
const pid = {};
for (const [c, n] of [[pa, 'priv_alpha'], [pb, 'priv_beta'], [pc, 'priv_gamma']]) {
  r = await c.call('POST', '/api/auth/register', { username: n, password: PASS, displayName: `Name ${n}` });
  assert.equal(r.status, 200, JSON.stringify(r));
  pid[n] = r.user.id;
}
const found = async (c, q) => (await c.call('GET', `/api/users/search?q=${encodeURIComponent(q)}`)).users?.map((u) => u.username) || [];
assert.deepEqual(await found(pa, 'priv'), [], 'strangers are not found by part of the name');
assert.deepEqual(await found(pa, 'Name'), [], 'nor by display name');
assert.deepEqual(await found(pa, 'priv_beta'), ['priv_beta'], 'found by the exact username');
assert.deepEqual(await found(pa, '@PRIV_BETA'), ['priv_beta'], 'exact username, any case, with @');
assert.equal((await pa.call('GET', `/api/users/${pid.priv_beta}`)).status, 404, 'a stranger\'s profile is not open by id');
// Opening a private chat leaves no trace for the other person until a message is sent.
const pdm = (await pa.call('POST', '/api/chats/dm', { userId: pid.priv_beta })).chat.id;
assert.ok(!(await pb.call('GET', '/api/chats')).chats.some((c) => c.id === pdm), 'empty private chat not listed for the other person');
assert.ok(!(await pa.call('GET', '/api/chats')).chats.some((c) => c.id === pdm), 'nor for the one who opened it');
assert.deepEqual(await found(pa, 'priv'), [], 'an empty private chat does not make them acquaintances');
await pa.call('POST', `/api/chats/${pdm}/messages`, { text: 'hi beta' });
assert.ok((await pb.call('GET', '/api/chats')).chats.some((c) => c.id === pdm), 'listed after the first message');
assert.deepEqual(await found(pa, 'priv'), ['priv_beta'], 'people you talked to are found by part of the name');
assert.equal((await pa.call('GET', `/api/users/${pid.priv_beta}`)).status, 200);
// A shared group makes people findable by name too.
await owner.call('PATCH', '/api/admin/settings', { allow_user_groups: '1' });
await pc.call('POST', '/api/chats', { type: 'group', title: 'Privacy group', memberIds: [pid.priv_alpha] });
assert.ok((await found(pa, 'Name priv_g')).includes('priv_gamma'), 'group members found by display name');
// Too many lookups in a minute: refused and logged.
let refused = 0;
for (let i = 0; i < 25; i++) if ((await pc.call('GET', `/api/users/search?q=x${i}`)).status === 429) refused++;
assert.ok(refused >= 4, `lookups limited (${refused} refused)`);
const auditRows = (await owner.call('GET', '/api/admin/audit?limit=50')).entries || (await owner.call('GET', '/api/admin/audit')).entries || [];
assert.ok(JSON.stringify(auditRows).includes('lookup.flood'), 'flood written to the activity log');
// Public groups/channels: by at least 3 letters; the full list can be turned off.
await chOwner.call('POST', '/api/chats', { type: 'group', title: 'Searchable Club', isPublic: true });
const disc = async (q) => await pa.call('GET', `/api/chats/discover${q ? `?q=${encodeURIComponent(q)}` : ''}`);
assert.deepEqual((await disc('Se')).chats, [], 'two letters are not enough');
assert.ok((await disc('Searchable')).chats.some((c) => c.title === 'Searchable Club'));
assert.ok((await disc('')).chats.some((c) => c.title === 'Searchable Club'), 'full list while allowed');
await owner.call('PATCH', '/api/admin/settings', { discover_list: '0' });
assert.deepEqual((await disc('')).chats, [], 'no full list when turned off');
assert.ok((await disc('Searchable')).chats.length >= 1, 'still found by name');
await owner.call('PATCH', '/api/admin/settings', { discover_list: '1' });

// ---- Stream frame rate: owner 60, others the site default (30) unless raised ----
const fpsOf = async (c) => (await c.call('GET', '/api/auth/me')).user?.limits?.streamFps;
assert.equal(await fpsOf(owner), 60, 'owner: 60 fps');
assert.equal(await fpsOf(reader), 30, 'default: 30 fps');
await owner.call('PATCH', `/api/admin/users/${ids.reader}/limits`, { stream_fps: 60 });
assert.equal(await fpsOf(reader), 60, 'per-user override to 60');
await owner.call('PATCH', `/api/admin/users/${ids.reader}/limits`, {});
assert.equal((await owner.call('PATCH', '/api/admin/settings', { max_stream_fps: '60' })).status, 200);
assert.equal(await fpsOf(reader), 60, 'site default raised to 60');
assert.equal((await owner.call('PATCH', '/api/admin/settings', { max_stream_fps: '45' })).status, 400);

console.log('ACCOUNT TEST PASSED');
process.exit(0);
