// Phase 3 API test: voice tokens, per-user limits, call signaling and webhooks.
// Needs a server started on an EMPTY data dir with LIVEKIT_API_KEY=amorechat and
// LIVEKIT_API_SECRET=$LK_SECRET (LiveKit itself does not have to be running).
// Usage: LK_SECRET=... node test/rtc-api.mjs <baseUrl> <setupCode>
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { io } from 'socket.io-client';
import http from 'node:http';

// A stand-in for LiveKit's RoomService API (LIVEKIT_URL=http://127.0.0.1:7999): records calls.
const lkCalls = [];
let lkParticipants = [];
const fakeLk = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    // ListRooms fails like before, so the periodic resync doesn't wipe the webhook-built state.
    if (method === 'ListRooms') return res.writeHead(500).end();
    lkCalls.push({ method, body: JSON.parse(body || '{}') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(method === 'ListParticipants' ? { participants: lkParticipants } : {}));
  });
});
await new Promise((ok) => fakeLk.listen(7999, '127.0.0.1', ok));

const BASE = process.argv[2];
const SETUP = process.argv[3];
const SECRET = process.env.LK_SECRET;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function client() {
  let cookie = '';
  async function call(method, url, body, { form, headers = {} } = {}) {
    const h = { 'x-requested-with': 'amorechat', ...headers };
    if (cookie) h.cookie = cookie;
    if (body && !form) h['content-type'] = h['content-type'] || 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: form || (body && (typeof body === 'string' ? body : JSON.stringify(body))) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  const events = [];
  let sock;
  return {
    call,
    events,
    async connect() {
      sock = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
      sock.onAny((name, data) => events.push({ name, data }));
      await new Promise((ok, bad) => (sock.on('connect', ok), sock.on('connect_error', bad)));
    },
    close: () => sock?.close(),
    last: (name) => events.filter((e) => e.name === name).at(-1)?.data,
  };
}

const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
function webhook(evt) {
  const body = JSON.stringify(evt);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const payload = b64({ iss: 'amorechat', nbf: now - 5, exp: now + 60, sha256: crypto.createHash('sha256').update(body).digest('base64') });
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${payload}`).digest('base64url');
  return { body, auth: `${head}.${payload}.${sig}` };
}
async function sendWebhook(evt, auth) {
  const w = webhook(evt);
  const res = await fetch(BASE + '/api/livekit/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/webhook+json', authorization: auth ?? w.auth },
    body: w.body,
  });
  return res.status;
}

const owner = client();
const bob = client();
const carol = client();

let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200);
assert.equal(r.user.limits.canStream, true);
r = await owner.call('POST', '/api/admin/invites', { maxUses: 2 });
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob', invite: r.invite.code });
const bobId = r.user.id;
r = await owner.call('GET', '/api/admin/invites');
r = await carol.call('POST', '/api/auth/register', { username: 'carol', password: 'Str0ng-Pass-77', displayName: 'Carol', invite: r.invites[0].code });
const carolId = r.user.id;
await bob.connect();
await carol.connect();

// ---- Voice channels ----
r = await owner.call('POST', '/api/chats', { type: 'voice', title: 'لابی', isPublic: true });
assert.equal(r.status, 200, JSON.stringify(r));
const lobby = r.chat.id;
r = await bob.call('GET', '/api/rtc/voice-channels');
assert.deepEqual(r.channels.map((c) => [c.id, c.isMember]), [[lobby, false]]);
r = await bob.call('POST', '/api/rtc/join', { chatId: lobby });
assert.equal(r.status, 200, JSON.stringify(r));
let c = claims(r.token);
assert.equal(c.video.room, `chat-${lobby}`);
assert.equal(c.sub, `u${bobId}`);
assert.ok(c.video.canPublishSources.includes('screen_share'), 'streaming allowed by default');
r = await bob.call('GET', '/api/chats');
assert.ok(r.chats.some((x) => x.id === lobby), 'joining a public voice channel makes you a member');

// Admin turns streaming off for everyone, then allows it for bob only
await owner.call('PATCH', '/api/admin/settings', { default_can_stream: '0' });
c = claims((await carol.call('POST', '/api/rtc/join', { chatId: lobby })).token);
assert.deepEqual(c.video.canPublishSources, ['microphone']);
r = await owner.call('PATCH', `/api/admin/users/${bobId}/limits`, { can_stream: true, stream_quality: 1080 });
assert.equal(r.limits.canStream, true);
r = await bob.call('POST', '/api/rtc/join', { chatId: lobby });
assert.ok(claims(r.token).video.canPublishSources.includes('screen_share'));
assert.equal(r.streamQuality, 1080);
r = await carol.call('PATCH', `/api/admin/users/${bobId}/limits`, { can_stream: false });
assert.equal(r.status, 403, 'regular users cannot change limits');

// Per-user upload limit
await owner.call('PATCH', '/api/admin/settings', { max_upload_mb: 1 });
const twoMb = () => {
  const f = new FormData();
  f.append('file', new Blob([new Uint8Array(2 * 1024 * 1024)]), 'x.bin');
  return f;
};
r = await carol.call('POST', '/api/upload', null, { form: twoMb() });
assert.equal(r.status, 413);
await owner.call('PATCH', `/api/admin/users/${carolId}/limits`, { upload_mb: 5 });
r = await carol.call('POST', '/api/upload', null, { form: twoMb() });
assert.equal(r.status, 201, 'override raises the limit for carol only');
r = await bob.call('POST', '/api/upload', null, { form: twoMb() });
assert.equal(r.status, 413);
r = await owner.call('POST', '/api/upload', null, { form: twoMb() });
assert.equal(r.status, 201, 'owner is never limited');
await owner.call('PATCH', '/api/admin/settings', { max_upload_mb: 100 });

// ---- Channel voice chat = "stage": admins start & speak, others raise a hand ----
r = await owner.call('POST', '/api/chats', { type: 'channel', title: 'رادیو', memberIds: [bobId, carolId] });
const radio = r.chat.id;
r = await bob.call('POST', '/api/rtc/join', { chatId: radio });
assert.equal(r.status, 403, 'only admins can start a channel voice chat');
r = await owner.call('POST', '/api/rtc/join', { chatId: radio });
assert.equal(r.canSpeak, true);
assert.equal(r.stage.admin, true);
const ownerId = claims(r.token).sub.slice(1) * 1;
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${radio}` }, participant: { identity: `u${ownerId}`, name: 'Owner' } });
r = await bob.call('POST', '/api/rtc/join', { chatId: radio });
c = claims(r.token);
assert.equal(c.video.canPublish, false, 'listener');
assert.equal(c.video.hidden, true, 'channel listeners are invisible to other clients');
assert.equal(r.stage.admin, false);
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${radio}` }, participant: { identity: `u${bobId}`, name: 'Bob' } });
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${radio}` }, participant: { identity: `u${carolId}`, name: 'Carol' } });
await sleep(200);
let st = carol.last('voice:state');
assert.deepEqual(st.participants.map((p) => p.userId), [ownerId], 'members only see the speakers');
assert.equal(st.listeners, 2);
r = await bob.call('POST', `/api/rtc/${radio}/hand`, { up: true });
assert.equal(r.hand, true);
r = await owner.call('GET', '/api/rtc/state');
let full = r.rooms.find((x) => x.chatId === radio);
assert.deepEqual(full.hands, [bobId], 'admin sees the raised hand');
assert.equal(full.participants.length, 3, 'admin sees the listeners');
r = await carol.call('GET', '/api/rtc/state');
assert.deepEqual(r.rooms.find((x) => x.chatId === radio).hands, []);
r = await carol.call('POST', `/api/rtc/${radio}/moderate`, { action: 'grant', userId: carolId });
assert.equal(r.status, 403, 'members cannot grant');
r = await owner.call('POST', `/api/rtc/${radio}/moderate`, { action: 'grant', userId: bobId });
assert.equal(r.ok, true);
await sleep(200);
assert.equal(bob.last('rtc:speak')?.canSpeak, true);
r = await bob.call('POST', '/api/rtc/join', { chatId: radio });
assert.equal(r.canSpeak, true, 'granted speaker rejoins with publish rights');
assert.ok(!claims(r.token).video.hidden);
st = carol.last('voice:state');
assert.deepEqual(st.participants.map((p) => p.userId).sort(), [ownerId, bobId].sort());
r = await owner.call('POST', `/api/rtc/${radio}/moderate`, { action: 'revoke', userId: bobId });
assert.equal(r.ok, true);
assert.equal((await bob.call('POST', '/api/rtc/join', { chatId: radio })).canSpeak, false);
r = await owner.call('POST', `/api/rtc/${radio}/moderate`, { action: 'kick', userId: carolId, ban: true });
r = await carol.call('POST', '/api/rtc/join', { chatId: radio });
assert.equal(r.status, 403, 'banned from this voice chat');
// The voice chat ends when everyone leaves: bans reset
for (const id of [ownerId, bobId, carolId]) await sendWebhook({ event: 'participant_left', room: { name: `chat-${radio}` }, participant: { identity: `u${id}` } });
await owner.call('POST', '/api/rtc/join', { chatId: radio });
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${radio}` }, participant: { identity: `u${ownerId}`, name: 'Owner' } });
assert.equal((await carol.call('POST', '/api/rtc/join', { chatId: radio })).status, 200, 'new voice chat, ban lifted');
await sendWebhook({ event: 'participant_left', room: { name: `chat-${radio}` }, participant: { identity: `u${ownerId}` } });
// Channel members are hidden from regular subscribers, reactions are anonymous
r = await carol.call('GET', `/api/chats/${radio}`);
assert.deepEqual(r.members.map((m) => m.id), [carolId], 'subscriber sees only self, not even the admins');
assert.equal(r.membersHidden, true);
r = await owner.call('GET', `/api/chats/${radio}`);
assert.equal(r.members.length, 3);
r = await owner.call('POST', `/api/chats/${radio}/messages`, { text: 'خبر' });
const post = r.message.id;
assert.equal(r.message.sender.id, 0, 'channel posts are signed by the channel');
assert.equal(r.message.sender.displayName, 'رادیو');
r = await carol.call('GET', `/api/chats/${radio}/messages`);
assert.ok(r.messages.every((m) => !m.sender || m.sender.id === 0), 'no admin identity in channel history');
// Site owner manages any chat, even one they're not in
r = await bob.call('POST', '/api/chats', { type: 'group', title: 'گروه باب' });
const bobGroup = r.chat.id;
r = await owner.call('GET', '/api/admin/chats');
assert.equal(r.chats.find((c) => c.id === bobGroup).isMember, false);
assert.ok(r.chats.some((c) => c.type === 'voice'), 'voice channels are listed too');
r = await carol.call('DELETE', `/api/chats/${bobGroup}`);
assert.equal(r.status, 403);
r = await owner.call('DELETE', `/api/chats/${bobGroup}`);
assert.equal(r.ok, true, 'site owner deletes a group without being in it');
r = await owner.call('GET', '/api/admin/chats');
assert.ok(!r.chats.some((c) => c.id === bobGroup));
const vc = (await bob.call('POST', '/api/chats', { type: 'voice', title: 'اتاق باب' })).chat;
assert.equal((await owner.call('DELETE', `/api/chats/${vc.id}`)).ok, true, 'voice channels too');
r = await carol.call('POST', `/api/messages/${post}/react`, { emoji: '👍' });
assert.deepEqual(r.message.reactions, [{ emoji: '👍', users: [], count: 1, mine: true }]);
r = await bob.call('GET', `/api/chats/${radio}/messages`);
assert.deepEqual(r.messages.find((m) => m.id === post).reactions, [{ emoji: '👍', users: [], count: 1, mine: false }]);

// Groups stay open by default; the admin can turn on the managed mode
r = await owner.call('POST', '/api/chats', { type: 'group', title: 'جمع', memberIds: [bobId] });
const group = r.chat.id;
await owner.call('PATCH', `/api/chats/${group}/members/${bobId}`, { mutedUntil: Date.now() + 60000 });
c = claims((await bob.call('POST', '/api/rtc/join', { chatId: group })).token);
assert.equal(c.video.canPublish, false);
r = await carol.call('POST', '/api/rtc/join', { chatId: group });
assert.equal(r.status, 403, 'non-members cannot join a private group room');
await owner.call('PATCH', `/api/chats/${group}/members/${bobId}`, { mutedUntil: null });
r = await bob.call('POST', '/api/rtc/join', { chatId: group });
assert.ok(!r.stage, 'groups are open by default');
r = await owner.call('PATCH', `/api/chats/${group}`, { voiceStage: true, hideMembers: true });
assert.equal(r.chat.voiceStage, true);
assert.equal(r.chat.hideMembers, true);
r = await bob.call('POST', '/api/rtc/join', { chatId: group });
assert.equal(r.status, 403, 'managed group voice chat: only admins start it');
r = await bob.call('GET', `/api/chats/${group}`);
assert.equal(r.membersHidden, true);

// ---- Webhooks drive "who is in the room" ----
assert.equal(await sendWebhook({ event: 'participant_joined', room: { name: `chat-${lobby}` }, participant: { identity: `u${bobId}`, name: 'Bob' } }, 'Bearer bad.token.here'), 401);
assert.equal(await sendWebhook({ event: 'participant_joined', room: { name: `chat-${lobby}` }, participant: { identity: `u${bobId}`, name: 'Bob' } }), 200);
await sleep(200);
assert.deepEqual(carol.last('voice:state')?.participants.map((p) => p.userId), [bobId], 'everyone sees public voice channel presence');
await sendWebhook({ event: 'track_published', room: { name: `chat-${lobby}` }, participant: { identity: `u${bobId}` }, track: { source: 'SCREEN_SHARE' } });
await sleep(200);
assert.equal(carol.last('voice:state').participants[0].screen, true, 'LIVE badge');
r = await carol.call('GET', '/api/rtc/state');
assert.equal(r.rooms.find((x) => x.chatId === lobby).participants.length, 1);
r = await owner.call('GET', '/api/admin/live');
assert.equal(r.rooms[0].title, 'لابی');
await sendWebhook({ event: 'participant_left', room: { name: `chat-${lobby}` }, participant: { identity: `u${bobId}` } });
await sleep(200);
assert.deepEqual(carol.last('voice:state').participants, []);

// ---- One-to-one calls ----
r = await bob.call('POST', '/api/calls', { userId: carolId, video: true });
assert.equal(r.status, 200, JSON.stringify(r));
const call1 = r.call;
assert.ok(call1.token, 'caller joins the room right away');
await sleep(200);
assert.equal(carol.last('call:incoming')?.id, call1.id);
r = await owner.call('POST', '/api/calls', { userId: carolId });
assert.equal(r.status, 409, 'busy');
r = await carol.call('GET', '/api/rtc/state');
assert.equal(r.call.token, null, 'callee gets no token before answering');
r = await carol.call('POST', `/api/calls/${call1.id}/accept`);
assert.ok(r.call.token);
assert.equal(claims(r.call.token).video.room, `call-${call1.id}`);
await sleep(200);
assert.equal(bob.last('call:accepted')?.id, call1.id);
// Callee closes the tab -> LiveKit reports the participant left -> call ends for both
await sendWebhook({ event: 'participant_left', room: { name: `call-${call1.id}` }, participant: { identity: `u${carolId}` } });
await sleep(300);
assert.equal(bob.last('call:ended')?.reason, 'ended');
let dm = (await bob.call('GET', '/api/chats')).chats.find((x) => x.type === 'dm' && x.peer?.id === carolId);
let msgs = (await bob.call('GET', `/api/chats/${dm.id}/messages`)).messages;
assert.equal(JSON.parse(msgs.at(-1).text).status, 'ended');
assert.equal(msgs.at(-1).type, 'call');

r = await bob.call('POST', '/api/calls', { userId: carolId });
await carol.call('POST', `/api/calls/${r.call.id}/decline`);
msgs = (await bob.call('GET', `/api/chats/${dm.id}/messages`)).messages;
assert.equal(JSON.parse(msgs.at(-1).text).status, 'declined');

r = await bob.call('POST', '/api/calls', { userId: carolId });
await bob.call('POST', `/api/calls/${r.call.id}/end`);
msgs = (await bob.call('GET', `/api/chats/${dm.id}/messages`)).messages;
assert.equal(JSON.parse(msgs.at(-1).text).status, 'cancelled');

await owner.call('PATCH', `/api/admin/users/${carolId}/limits`, { can_call: false });
r = await bob.call('POST', '/api/calls', { userId: carolId });
assert.equal(r.status, 403, 'admin disabled calls for carol');

// ---- Old tokens can't be reused: access is re-checked on every join / publish ----
const called = (method, who, room) => lkCalls.some((c) => c.method === method && c.body.identity === who && (!room || c.body.room === room));
lkCalls.length = 0;
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${group}` }, participant: { identity: `u${carolId}`, name: 'Carol' } });
await sleep(300);
assert.ok(called('RemoveParticipant', `u${carolId}`, `chat-${group}`), 'a non-member joining with some token is thrown out');
lkParticipants = [{ identity: `u${bobId}`, tracks: [{ sid: 'TR_mic', source: 'MICROPHONE' }] }];
await sendWebhook({ event: 'participant_joined', room: { name: `chat-${group}` }, participant: { identity: `u${bobId}`, name: 'Bob' } });
await sendWebhook({ event: 'track_published', room: { name: `chat-${group}` }, participant: { identity: `u${bobId}` }, track: { source: 'MICROPHONE', sid: 'TR_mic' } });
await sleep(300);
assert.ok(!called('RemoveParticipant', `u${bobId}`, `chat-${group}`), 'members may stay');
assert.ok(called('MutePublishedTrack', `u${bobId}`), 'listener publishing with an old speaker token is muted');
assert.ok(called('UpdateParticipant', `u${bobId}`), '...and loses publish rights');
lkCalls.length = 0;
await owner.call('DELETE', `/api/chats/${group}/members/${bobId}`);
await sleep(300);
assert.ok(called('RemoveParticipant', `u${bobId}`, `chat-${group}`), 'removed from the group = out of its voice chat');
fakeLk.close();

bob.close();
carol.close();
console.log('RTC API TEST PASSED');
