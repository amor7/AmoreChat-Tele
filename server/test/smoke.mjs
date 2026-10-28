// End-to-end smoke test against a freshly started server with an empty DATA_DIR.
// Usage: node test/smoke.mjs <baseUrl> <setupCode>
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const BASE = process.argv[2] || 'http://localhost:3000';
const SETUP = process.argv[3];

function client() {
  let cookie = '';
  async function call(method, url, body, { raw = false, form } = {}) {
    const headers = { 'x-requested-with': 'amorechat' };
    if (cookie) headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: form || (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const data = await res.json();
    return { status: res.status, ...data };
  }
  return { call, cookie: () => cookie };
}

const owner = client();
const bob = client();
const eve = client();

// Registration requires the setup code first.
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner' });
assert.equal(r.status, 403);
r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'مدیر', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal(r.user.role, 'owner');

// CSRF guard
const noHeader = await fetch(BASE + '/api/auth/logout', { method: 'POST' });
assert.equal(noHeader.status, 403);

// Invite-only signup
r = await owner.call('POST', '/api/admin/invites', { maxUses: 2, note: 'test' });
const code = r.invite.code;
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob' });
assert.equal(r.status, 403);
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'باب', invite: code });
assert.equal(r.status, 200);
const bobId = r.user.id;
r = await eve.call('POST', '/api/auth/register', { username: 'eve', password: 'Str0ng-Pass-77', displayName: 'Eve', invite: code });
const eveId = r.user.id;

// Everyone has saved messages + emergency channel
r = await bob.call('GET', '/api/chats');
assert.equal(r.chats.length, 2);
const emergency = r.chats.find((c) => c.isEmergency);
assert.ok(emergency);
r = await bob.call('POST', `/api/chats/${emergency.id}/messages`, { text: 'hi' });
assert.equal(r.status, 403);

// Realtime: bob listens
const sock = io(BASE, { extraHeaders: { cookie: bob.cookie() }, transports: ['websocket'] });
await new Promise((ok, bad) => {
  sock.on('connect', ok);
  sock.on('connect_error', bad);
});
const received = [];
sock.on('message:new', (m) => received.push(m));
sock.on('emergency', (m) => received.push({ emergency: true, ...m }));

// Owner creates a group with bob
r = await owner.call('POST', '/api/chats', { type: 'group', title: 'گروه تست', memberIds: [bobId] });
assert.equal(r.status, 200);
const groupId = r.chat.id;
r = await owner.call('POST', `/api/chats/${groupId}/messages`, { text: 'سلام بچه‌ها' });
const firstMsg = r.message;
await new Promise((ok) => setTimeout(ok, 200));
assert.ok(received.some((m) => m.text === 'سلام بچه‌ها'), 'bob got message via socket');

// Eve isn't a member
r = await eve.call('GET', `/api/chats/${groupId}/messages`);
assert.equal(r.status, 403);

// Bob replies; unread for owner
r = await bob.call('POST', `/api/chats/${groupId}/messages`, { text: 'سلام', replyTo: firstMsg.id });
assert.equal(r.message.replyTo.id, firstMsg.id);
r = await owner.call('GET', '/api/chats');
assert.equal(r.chats.find((c) => c.id === groupId).unread, 1);

// Make bob a limited admin who can only delete messages
r = await owner.call('PATCH', `/api/chats/${groupId}/members/${bobId}`, { role: 'admin', perms: ['delete_messages'] });
assert.equal(r.status, 200);
r = await bob.call('POST', `/api/chats/${groupId}/members`, { userIds: [eveId] });
assert.equal(r.status, 403, 'bob lacks add_members');
r = await owner.call('POST', `/api/chats/${groupId}/members`, { userIds: [eveId] });
assert.equal(r.added, 1);
r = await eve.call('POST', `/api/chats/${groupId}/messages`, { text: 'spam' });
const spamId = r.message.id;
r = await bob.call('DELETE', `/api/messages/${spamId}`);
assert.equal(r.status, 200);
r = await bob.call('PATCH', `/api/chats/${groupId}/members/${eveId}`, { mutedUntil: Date.now() + 60000 });
assert.equal(r.status, 403, 'bob lacks mute_members');

// Owner mutes eve
r = await owner.call('PATCH', `/api/chats/${groupId}/members/${eveId}`, { mutedUntil: Date.now() + 60000 });
r = await eve.call('POST', `/api/chats/${groupId}/messages`, { text: 'x' });
assert.equal(r.status, 403);

// DM + file upload + access control
r = await bob.call('POST', '/api/chats/dm', { userId: eveId });
const dmId = r.chat.id;
assert.equal(r.chat.title, 'Eve');
const form = new FormData();
form.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'text/html' }), 'x.html');
r = await bob.call('POST', '/api/upload', null, { form });
assert.equal(r.status, 201);
const fileId = r.file.id;
r = await bob.call('POST', `/api/chats/${dmId}/messages`, { fileId, type: 'image' });
assert.equal(r.message.type, 'file', 'html cannot pose as image');
let res = await eve.call('GET', `/api/files/${fileId}`, null, { raw: true });
assert.equal(res.status, 200);
assert.equal(res.headers.get('content-type'), 'application/octet-stream');
assert.match(res.headers.get('content-disposition'), /^attachment/);
res = await owner.call('GET', `/api/files/${fileId}`, null, { raw: true });
assert.equal(res.status, 403);

// Emergency broadcast
r = await owner.call('POST', `/api/chats/${emergency.id}/messages`, { text: 'اطلاعیه مهم' });
await new Promise((ok) => setTimeout(ok, 200));
assert.ok(received.some((m) => m.emergency));

// Site admin with limited perms
r = await owner.call('PATCH', `/api/admin/users/${bobId}`, { role: 'admin', adminPerms: ['manage_invites'] });
r = await bob.call('GET', '/api/admin/invites');
assert.equal(r.status, 200);
r = await bob.call('GET', '/api/admin/users');
assert.equal(r.status, 403);

// Ban kicks the session
r = await owner.call('POST', `/api/admin/users/${eveId}/ban`, { banned: true });
r = await eve.call('GET', '/api/auth/me');
assert.equal(r.status, 401);

r = await owner.call('GET', '/api/admin/stats');
assert.equal(r.users, 3);
r = await owner.call('GET', '/api/admin/audit');
assert.ok(r.entries.length > 5);

// ---------- Phase 2 ----------
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Reactions toggle
r = await bob.call('POST', `/api/messages/${firstMsg.id}/react`, { emoji: '👍' });
assert.deepEqual(r.message.reactions, [{ emoji: '👍', users: [bobId] }]);
r = await owner.call('POST', `/api/messages/${firstMsg.id}/react`, { emoji: '👍' });
assert.equal(r.message.reactions[0].users.length, 2);
r = await bob.call('POST', `/api/messages/${firstMsg.id}/react`, { emoji: '👍' });
assert.equal(r.message.reactions[0].users.length, 1);

// Jump-to-message window
r = await owner.call('GET', `/api/chats/${groupId}/messages?around=${firstMsg.id}&limit=10`);
assert.ok(r.messages.some((m) => m.id === firstMsg.id));

// Search only covers chats you are in
r = await owner.call('POST', '/api/admin/invites', { maxUses: 1 });
const carol = client();
r = await carol.call('POST', '/api/auth/register', { username: 'carol', password: 'Str0ng-Pass-77', displayName: 'Carol', invite: r.invite.code });
const ownerId = (await owner.call('GET', '/api/auth/me')).user.id;
r = await bob.call('POST', '/api/chats/dm', { userId: ownerId });
const secretDm = r.chat.id;
await bob.call('POST', `/api/chats/${secretDm}/messages`, { text: 'کلمه‌رمز محرمانه‌ترین' });
r = await owner.call('GET', `/api/search?q=${encodeURIComponent('محرمانه')}`);
assert.equal(r.messages.length, 1, 'owner finds DM text by prefix');
r = await carol.call('GET', `/api/search?q=${encodeURIComponent('محرمانه')}`);
assert.equal(r.messages.length, 0, 'carol cannot search chats she is not in');
r = await owner.call('GET', `/api/search?q=${encodeURIComponent('"bad OR')}`);
assert.equal(r.status, 200, 'FTS syntax is escaped');

// Forward into saved messages keeps the original author
const bobChats = (await bob.call('GET', '/api/chats')).chats;
const bobSaved = bobChats.find((c) => c.type === 'saved').id;
r = await bob.call('POST', `/api/messages/${firstMsg.id}/forward`, { chatIds: [bobSaved, emergency.id] });
assert.deepEqual(r.sent, [bobSaved], 'cannot forward into the broadcast channel');
r = await bob.call('GET', `/api/chats/${bobSaved}/messages`);
assert.equal(r.messages.at(-1).forwardedFrom, 'مدیر');

// Reports
r = await bob.call('POST', `/api/chats/${groupId}/messages`, { text: 'پیام بد' });
const badId = r.message.id;
r = await owner.call('POST', `/api/messages/${badId}/report`, { reason: 'توهین' });
assert.equal(r.status, 200);
r = await owner.call('GET', '/api/admin/reports');
assert.equal(r.reports.length, 1);
r = await owner.call('POST', `/api/admin/reports/${r.reports[0].id}`, { action: 'delete' });
r = await owner.call('GET', `/api/chats/${groupId}/messages`);
assert.equal(r.messages.find((m) => m.id === badId).type, 'deleted');

// Auto-delete timer on a DM (either member may set it)
r = await bob.call('PATCH', `/api/chats/${secretDm}`, { autoDelete: 2 });
assert.equal(r.status, 200);
r = await bob.call('POST', `/api/chats/${secretDm}/messages`, { text: 'خودتخریب' });
assert.ok(r.message.expiresAt);
const ephemeralId = r.message.id;
if (Number(process.env.SWEEP_MS) <= 1000) {
  await sleep(3500);
  r = await bob.call('GET', `/api/chats/${secretDm}/messages`);
  assert.equal(r.messages.find((m) => m.id === ephemeralId).type, 'deleted', 'expired message swept');
}
await bob.call('PATCH', `/api/chats/${secretDm}`, { autoDelete: 0 });

// Voice note: a tiny generated WAV
function wav(seconds = 1, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return b;
}
const config = await owner.call('GET', '/api/config');
const vform = new FormData();
vform.append('file', new Blob([wav()], { type: 'audio/wav' }), 'voice.wav');
r = await bob.call('POST', '/api/upload?voice=1&dur=1&wave=0f1v2a', null, { form: vform });
assert.equal(r.status, 201);
assert.equal(r.file.mime, config.videoProcessing ? 'audio/mp4' : 'audio/wav');
r = await bob.call('POST', `/api/chats/${groupId}/messages`, { fileId: r.file.id, type: 'voice' });
assert.equal(r.message.type, 'voice');
assert.equal(r.message.file.waveform, '0f1v2a');

// Video processing (only where ffmpeg exists on both server and test machine)
const { spawnSync } = await import('node:child_process');
const FF = process.env.FFMPEG_PATH || 'ffmpeg';
const haveFf = spawnSync(FF, ['-version']).status === 0;
if (config.videoProcessing && haveFf) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const src = path.join(os.tmpdir(), `ac-test-${Date.now()}.mp4`);
  const made = spawnSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  assert.equal(made.status, 0, 'generated test video');
  const buf = fs.readFileSync(src);

  async function sendVideo(q) {
    const f = new FormData();
    f.append('file', new Blob([buf], { type: 'video/mp4' }), 'clip.mp4');
    const up = await bob.call('POST', `/api/upload?q=${q}`, null, { form: f });
    assert.equal(up.file.status, 'processing');
    const sent = await bob.call('POST', `/api/chats/${groupId}/messages`, { fileId: up.file.id, type: 'video' });
    for (let i = 0; i < 120; i++) {
      const list = await bob.call('GET', `/api/chats/${groupId}/messages`);
      const m = list.messages.find((x) => x.id === sent.message.id);
      if (m.file.status === 'ready') return m;
      await sleep(500);
    }
    throw new Error('video never finished processing');
  }

  let m = await sendVideo('360');
  assert.equal(m.file.height, 360, 'downscaled to 360p as requested');
  assert.deepEqual(m.file.variants, []);
  assert.ok(m.file.thumb);

  m = await sendVideo('original');
  assert.equal(m.file.height, 720, 'original kept');
  assert.deepEqual(m.file.variants.map((v) => v.q), [360]);
  res = await owner.call('GET', `/api/files/${m.file.id}?v=360`, null, { raw: true });
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  res = await owner.call('GET', `/api/files/${m.file.id}?thumb=1`, null, { raw: true });
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  fs.rmSync(src, { force: true });
  console.log('video processing checks passed');
} else {
  console.log('(skipped video processing checks: ffmpeg not available)');
}

sock.close();
console.log('SMOKE TEST PASSED');
