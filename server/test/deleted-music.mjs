// Deleted messages (gone for everyone, kept a while for moderators in groups and channels only),
// the account lock (strangers can't keep a known device out), and music file tags.
// Usage: node test/deleted-music.mjs <baseUrl> <setupCode>   (fresh DATA_DIR; ffmpeg for the music part)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client() {
  const jar = new Map();
  const ip = `10.0.2.${ipN++}`;
  const call = async (method, url, body, form) => {
    const h = { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: form || (body && JSON.stringify(body)) });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      jar.set(k, v);
    }
    if (url.includes('raw=1')) return res;
    return { http: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return { call, jar };
}
const ok = (r) => {
  assert.ok(r.http >= 200 && r.http < 300, JSON.stringify(r));
  return r;
};

const owner = client();
ok(await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP }));
ok(await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' }));
const reg = async (name) => {
  const c = client();
  c.id = ok(await c.call('POST', '/api/auth/register', { username: name, password: PASS, displayName: name })).user.id;
  return c;
};
const alice = await reg('alice');
const bob = await reg('bob');
const upload = async (who, buf, type, name) => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  return ok(await who.call('POST', '/api/upload', null, form));
};
const listed = async (who, chat) => ok(await who.call('GET', `/api/chats/${chat}/messages`)).messages;

console.log('- deleted in a group: gone for members, moderators can see what it was');
const group = ok(await owner.call('POST', '/api/chats', { type: 'group', title: 'g', memberIds: [alice.id, bob.id] })).chat.id;
const keepFirst = ok(await alice.call('POST', `/api/chats/${group}/messages`, { text: 'stays' })).message.id;
const gone = ok(await alice.call('POST', `/api/chats/${group}/messages`, { text: 'secret text' })).message.id;
const reply = ok(await bob.call('POST', `/api/chats/${group}/messages`, { text: 'a reply', replyTo: gone })).message.id;
const f1 = await upload(alice, Buffer.from('attached body'), 'text/plain', 'a.txt');
const withFile = ok(await alice.call('POST', `/api/chats/${group}/messages`, { fileId: f1.id ?? f1.file?.id, text: 'with file' })).message;
ok(await alice.call('DELETE', `/api/messages/${gone}`));
ok(await alice.call('DELETE', `/api/messages/${withFile.id}`));
let m = (await listed(bob, group)).find((x) => x.id === gone);
assert.equal(m.type, 'deleted');
assert.equal(m.text, '');
assert.equal(m.sender, null, 'who wrote it is not sent');
assert.equal(m.kept, true);
assert.equal((await listed(bob, group)).find((x) => x.id === reply).replyTo.text, '');
let r = await bob.call('GET', `/api/messages/${gone}/deleted`);
assert.equal(r.http, 403);
r = await alice.call('GET', `/api/messages/${gone}/deleted`);
assert.equal(r.http, 403, 'not even for who wrote it');
r = ok(await owner.call('GET', `/api/messages/${gone}/deleted`));
assert.equal(r.text, 'secret text');
assert.equal(r.sender, 'alice');
assert.equal(r.deletedBy, 'alice');
r = ok(await owner.call('GET', `/api/messages/${withFile.id}/deleted`));
assert.equal(r.file.name, 'a.txt');
assert.equal((await owner.call('GET', `/api/files/${r.file.id}?raw=1`)).status, 200, 'moderators open the kept file');
assert.equal((await bob.call('GET', `/api/files/${r.file.id}?raw=1`)).status, 403, 'members do not');
r = ok(await owner.call('GET', '/api/admin/audit'));
assert.ok(JSON.stringify(r).includes('message.view_deleted'), 'looking at a deleted message is logged');

console.log('- search finds files by name, in a chat and everywhere, for its members only');
const docF = await upload(alice, Buffer.from('x'), 'application/pdf', 'hayedeh - mast.pdf');
const doc = ok(await alice.call('POST', `/api/chats/${group}/messages`, { fileId: docF.id ?? docF.file?.id, text: 'no name here' })).message;
const found = async (who, q, chat) => ok(await who.call('GET', `/api/search?q=${encodeURIComponent(q)}${chat ? `&chatId=${chat}` : ''}`)).messages.map((x) => x.id);
assert.deepEqual(await found(bob, 'mast', group), [doc.id]);
assert.deepEqual(await found(bob, 'mast'), [doc.id]);
assert.deepEqual(await found(bob, 'hayedeh mast'), [doc.id]);
assert.deepEqual(await found(bob, 'mas'), [doc.id], 'the start of a word is enough');
assert.deepEqual(await found(bob, 'no name'), [doc.id], 'the caption still counts');
const outsider = await reg('outsider');
assert.deepEqual(await found(outsider, 'mast'), [], 'not for someone outside the chat');
ok(await alice.call('DELETE', `/api/messages/${doc.id}`));
assert.deepEqual(await found(bob, 'mast'), [], 'not after it is deleted');

console.log('- the chat list shows the last message that still exists');
const last = ok(await alice.call('POST', `/api/chats/${group}/messages`, { text: 'last one' })).message.id;
ok(await alice.call('DELETE', `/api/messages/${last}`));
r = ok(await bob.call('GET', '/api/chats')).chats.find((c) => c.id === group);
assert.equal(r.lastMessage.id, reply);
assert.ok(keepFirst);

console.log('- private chats and self-deleting messages: really gone');
const dm = ok(await alice.call('POST', '/api/chats/dm', { userId: bob.id })).chat.id;
const f2 = await upload(alice, Buffer.from('private body'), 'text/plain', 'p.txt');
const pm = ok(await alice.call('POST', `/api/chats/${dm}/messages`, { text: 'private', fileId: f2.id ?? f2.file?.id })).message;
ok(await alice.call('DELETE', `/api/messages/${pm.id}`));
m = (await listed(bob, dm)).find((x) => x.id === pm.id);
assert.equal(m.kept, false);
assert.equal((await owner.call('GET', `/api/messages/${pm.id}/deleted`)).http, 404);
assert.equal((await alice.call('GET', `/api/files/${pm.file.id}?raw=1`)).status, 410, 'the file is gone');

console.log('- a locked account: strangers stay out, a known device gets in, the answers look the same');
const victim = await reg('victim');
ok(await victim.call('POST', '/api/auth/logout', {}));
ok(await victim.call('POST', '/api/auth/login', { username: 'victim', password: PASS }));
ok(await victim.call('POST', '/api/auth/logout', {}));
for (let i = 0; i < 11; i++) await client().call('POST', '/api/auth/login', { username: 'victim', password: `nope${i}` });
const stranger = await client().call('POST', '/api/auth/login', { username: 'victim', password: PASS });
assert.equal(stranger.http, 401, 'locked for a new device');
const unknown = await client().call('POST', '/api/auth/login', { username: 'no-such-user', password: 'x' });
assert.deepEqual([unknown.http, unknown.error], [stranger.http, stranger.error]);
ok(await victim.call('POST', '/api/auth/login', { username: 'victim', password: PASS }));
ok(await victim.call('POST', '/api/auth/logout', {}));
// Wrong passwords from the known device count for that device only.
for (let i = 0; i < 10; i++) {
  assert.equal((await victim.call('POST', '/api/auth/login', { username: 'victim', password: `nope${i}` })).http, 401);
  if (i === 4) await new Promise((o) => setTimeout(o, 61000)); // the per-IP limit
}
assert.equal((await victim.call('POST', '/api/auth/login', { username: 'victim', password: PASS })).http, 401, 'the device is locked too after its own wrong tries');

let ffmpeg = true;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-'));
const song = path.join(dir, 'Some Artist - Name.mp3');
const cover = path.join(dir, 'c.png');
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', cover]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-i', cover, '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic', '-metadata', 'title=آهنگ تست', '-metadata', 'artist=خواننده', song]);
} catch {
  ffmpeg = false;
  console.log('- music tags: skipped (no ffmpeg here)');
}
if (ffmpeg) {
  console.log('- music: tags, length and cover come from the file; the chat lists its music');
  const f3 = await upload(alice, fs.readFileSync(song), 'audio/mpeg', path.basename(song));
  const msg = ok(await alice.call('POST', `/api/chats/${group}/messages`, { fileId: f3.id ?? f3.file?.id, type: 'file' })).message;
  assert.equal(msg.file.kind, 'audio');
  assert.equal(msg.file.title, 'آهنگ تست');
  assert.equal(msg.file.artist, 'خواننده');
  assert.ok(Math.abs(msg.file.duration - 3) < 1, `duration ${msg.file.duration}`);
  assert.equal(msg.file.thumb, true);
  assert.equal((await bob.call('GET', `/api/files/${msg.file.id}?thumb=1&raw=1`)).status, 200);
  assert.deepEqual((await ok(await bob.call('GET', `/api/search?q=${encodeURIComponent('خواننده')}`))).messages.map((x) => x.id), [msg.id], 'found by artist');
  r = ok(await bob.call('GET', `/api/chats/${group}/media?kind=music`));
  assert.deepEqual(r.messages.map((x) => x.id), [msg.id]);
}
console.log('\nDeleted messages, lock, music: all checks passed');
