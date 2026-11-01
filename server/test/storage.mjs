// Storage management, the user overview and temporary restrictions.
// Usage: node test/storage.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function client() {
  let cookie = '';
  async function call(method, url, body, form) {
    const headers = { 'x-requested-with': 'amorechat' };
    if (cookie) headers.cookie = cookie;
    if (body) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers, body: form || (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  }
  return { call };
}
async function upload(c, name, mime, kb) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.alloc(kb * 1024, 7)], { type: mime }), name);
  const r = await c.call('POST', '/api/upload', null, form);
  assert.ok(r.id || r.file?.id, JSON.stringify(r));
  return r.id || r.file.id;
}

const owner = client();
const ali = client();
const sara = client();
const mod = client();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
const ownerId = r.user.id;
const code = (await owner.call('POST', '/api/admin/invites', { maxUses: 5, note: 'test' })).invite.code;
const aliId = (await ali.call('POST', '/api/auth/register', { username: 'ali', password: PASS, displayName: 'Ali', invite: code })).user.id;
const saraId = (await sara.call('POST', '/api/auth/register', { username: 'sara', password: PASS, displayName: 'Sara', invite: code })).user.id;
const modId = (await mod.call('POST', '/api/auth/register', { username: 'moderator', password: PASS, displayName: 'Mod', invite: code })).user.id;

// Who may look.
assert.equal((await ali.call('GET', '/api/admin/storage')).status, 403);
assert.equal((await ali.call('GET', '/api/admin/storage/files')).status, 403);
assert.equal((await ali.call('POST', '/api/admin/storage/delete', { ids: [1] })).status, 403);
assert.equal((await ali.call('GET', `/api/admin/users/${saraId}/overview`)).status, 403);
assert.equal((await ali.call('POST', `/api/admin/users/${saraId}/restrict`, { send: 1 })).status, 403);

// Files of each kind, sent in a chat.
const dm = (await ali.call('POST', '/api/chats/dm', { userId: saraId })).chat.id;
const send = async (id, type = 'file') => {
  const m = await ali.call('POST', `/api/chats/${dm}/messages`, { fileId: id, type });
  assert.equal(m.status, 200, JSON.stringify(m));
  return m.message.id;
};
const photo = await upload(ali, 'a.png', 'image/png', 300);
const photo2 = await upload(ali, 'b.png', 'image/png', 200);
const app = await upload(ali, 'setup.APK', 'application/octet-stream', 500);
const zip = await upload(ali, 'old.zip', 'application/zip', 100);
const misc = await upload(ali, 'data.bin', 'application/octet-stream', 50);
const photoMsg = await send(photo, 'image');
await send(photo2, 'image');
await send(app);
await send(zip);
await send(misc);
const saraFile = await upload(sara, 's.pdf', 'application/pdf', 40);
const ownerFile = await upload(owner, 'o.pdf', 'application/pdf', 40);
const avatar = await upload(ali, 'me.png', 'image/png', 20);
await ali.call('PATCH', '/api/me', { avatar });

// The breakdown of one user.
let s = await owner.call('GET', `/api/admin/storage?userId=${aliId}`);
assert.equal(s.status, 200, JSON.stringify(s));
const cat = (name) => s.categories.find((c) => c.category === name);
assert.equal(cat('image').count, 3);
assert.equal(cat('image').bytes, 520 * 1024);
assert.equal(cat('app').bytes, 500 * 1024, 'by extension, whatever the case');
assert.equal(cat('archive').bytes, 100 * 1024);
assert.equal(cat('other').bytes, 50 * 1024);
assert.equal(s.matched.count, 6);

s = await owner.call('GET', '/api/admin/storage');
assert.equal(s.users[0].id, aliId, 'the biggest user first');
assert.ok(s.chats.some((c) => c.id === dm));
assert.ok(s.dbBytes > 0);

// The list: filters and order.
let l = await owner.call('GET', `/api/admin/storage/files?userId=${aliId}&category=image`);
assert.deepEqual(l.files.map((f) => f.name), ['a.png', 'b.png', 'me.png'], 'biggest first');
assert.equal(l.files[0].chats[0].type, 'dm');
assert.equal((await owner.call('GET', '/api/admin/storage/files?q=setup')).files.length, 1);
assert.equal((await owner.call('GET', '/api/admin/storage/files?q=%25')).files.length, 0, 'LIKE wildcards are plain text');

// Deleting by id: gone from the disk, the message says so.
r = await owner.call('POST', '/api/admin/storage/delete', { ids: [photo] });
assert.equal(r.deleted, 1, JSON.stringify(r));
assert.equal(r.bytes, 300 * 1024);
assert.equal((await ali.call('GET', `/api/files/${photo}`)).status, 410);
const msgs = (await sara.call('GET', `/api/chats/${dm}/messages?limit=50`)).messages;
assert.equal(msgs.find((m) => m.id === photoMsg).file.purged, true);

// Deleting by filter needs the password and a filter, and spares what is in use.
const all = { filter: { userId: aliId, category: 'image' } };
assert.equal((await owner.call('POST', '/api/admin/storage/delete', all)).status, 403);
assert.equal((await owner.call('POST', '/api/admin/storage/delete', { ...all, password: 'wrong' })).status, 403);
assert.equal((await owner.call('POST', '/api/admin/storage/delete', { filter: {}, password: PASS })).status, 400);
r = await owner.call('POST', '/api/admin/storage/delete', { ...all, password: PASS });
assert.equal(r.status, 200, JSON.stringify(r));
assert.equal((await ali.call('GET', `/api/files/${photo2}`)).status, 410);

// A storage admin: not the files of those above them.
await owner.call('PATCH', `/api/admin/users/${modId}`, { role: 'admin', adminPerms: ['manage_storage'] });
assert.equal((await mod.call('GET', '/api/admin/storage')).status, 200);
assert.equal((await mod.call('POST', '/api/admin/storage/delete', { ids: [ownerFile] })).deleted, 0);
assert.equal((await mod.call('POST', '/api/admin/storage/delete', { ids: [saraFile] })).deleted, 1);
assert.equal((await mod.call('POST', '/api/admin/storage/compact', {})).status, 403);
assert.equal((await owner.call('POST', '/api/admin/storage/compact', {})).status, 200);

// The user overview.
const o = await owner.call('GET', `/api/admin/users/${aliId}/overview`);
assert.equal(o.status, 200, JSON.stringify(o));
assert.equal(o.messages, 5);
assert.ok(o.files.some((c) => c.category === 'app'));
assert.ok(o.sessions.length >= 1);
assert.ok(o.history.some((h) => h.action), 'what was done to them');

// Temporary restrictions.
await sara.call('POST', '/api/auth/login', { username: 'sara', password: PASS });
r = await owner.call('POST', `/api/admin/users/${saraId}/restrict`, { send: 1, reason: 'تست' });
assert.equal(r.status, 200, JSON.stringify(r));
r = await sara.call('POST', `/api/chats/${dm}/messages`, { text: 'hi' });
assert.equal(r.status, 403);
assert.match(r.error, /تست/, 'the reason is in the message');
await owner.call('POST', `/api/admin/users/${saraId}/restrict`, { send: 0, media: 1, call: 1 });
assert.equal((await sara.call('POST', `/api/chats/${dm}/messages`, { text: 'hi' })).status, 200);
const form = new FormData();
form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
assert.equal((await sara.call('POST', '/api/upload', null, form)).status, 403);
assert.equal((await sara.call('GET', '/api/auth/me')).user.limits.canCall, false);
// It ends by itself.
await owner.call('POST', `/api/admin/users/${saraId}/restrict`, { send: 0.0002, media: 0, call: 0 });
assert.equal((await sara.call('POST', `/api/chats/${dm}/messages`, { text: 'no' })).status, 403);
await sleep(1000);
assert.equal((await sara.call('POST', `/api/chats/${dm}/messages`, { text: 'yes' })).status, 200);
assert.equal((await sara.call('GET', '/api/auth/me')).user.limits.canCall, true);
// Not upwards.
assert.equal((await owner.call('POST', `/api/admin/users/${ownerId}/restrict`, { send: 1 })).status, 403);

console.log('STORAGE TEST PASSED');
