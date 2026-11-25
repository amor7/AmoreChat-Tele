// Regression checks for group/channel management bugs: ban lifting by adders, public/private
// values, the chat owner's place, null/typed fields, handle letter case, bad ids, the auto-delete
// notice in an unseen private chat, folders whose chats are gone, and the moderation mute values.
// Usage: node test/bugs-chats.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') {
  let cookie = '';
  const ip = `10.0.1.${ipN++}`; // separate per-IP rate-limit buckets
  async function call(method, url, body) {
    const h = { 'x-requested-with': 'amorechat', 'user-agent': ua, 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return { call };
}

async function register(username, extra = {}) {
  const c = client();
  const r = await c.call('POST', '/api/auth/register', { username, password: PASS, displayName: username, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r));
  c.id = r.user.id;
  return c;
}

const owner = await register('owner', { invite: SETUP });
assert.equal((await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open', allow_user_groups: '1' })).status, 200);
const alice = await register('alice');
const bob = await register('bob');
const carol = await register('carol');
const dave = await register('dave');

const chatOf = async (c, id) => (await c.call('GET', `/api/chats/${id}`)).chat;
const membersOf = async (c, id) => (await c.call('GET', `/api/chats/${id}`)).members || [];
const newChat = async (c, body) => {
  const r = await c.call('POST', '/api/chats', { type: 'group', title: 'G', ...body });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.chat.id;
};
let r;

// ---- 1. An admin who may only add members can't lift a ban by adding the banned user ----
{
  const g = await newChat(alice, { memberIds: [bob.id, carol.id] });
  assert.equal((await alice.call('PATCH', `/api/chats/${g}/members/${carol.id}`, { role: 'admin', perms: ['add_members'] })).status, 200);
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/${bob.id}?ban=1`)).status, 200);
  r = await carol.call('GET', `/api/chats/${g}`);
  assert.deepEqual(r.bannedIds, [bob.id], 'the adder is told who is banned (to leave them out of the picker)');
  r = await carol.call('POST', `/api/chats/${g}/members`, { userIds: [bob.id] });
  assert.equal(r.status, 403, 'adding a banned user without ban rights is refused');
  r = await alice.call('GET', `/api/chats/${g}`);
  assert.ok(r.bans.some((b) => b.id === bob.id), 'the ban is still there');
  assert.ok(!r.members.some((m) => m.id === bob.id), 'and bob is not back');
  // Someone with ban rights still lifts the ban this way.
  r = await alice.call('POST', `/api/chats/${g}/members`, { userIds: [bob.id] });
  assert.equal(r.added, 1);
  assert.equal((await alice.call('GET', `/api/chats/${g}`)).bans.length, 0);
  // A member's view tells nothing about bans.
  assert.deepEqual((await bob.call('GET', `/api/chats/${g}`)).bannedIds, []);
}

// ---- 2. Public/private: one meaning for every value ----
{
  const g = await newChat(alice, { isPublic: true, handle: 'pub_club' });
  for (const v of [0, null, '', 1, 'yes']) {
    r = await alice.call('PATCH', `/api/chats/${g}`, { isPublic: v });
    assert.equal(r.status, 400, `isPublic ${JSON.stringify(v)} refused`);
  }
  let c = await chatOf(alice, g);
  assert.equal(c.isPublic, true, 'still public');
  assert.equal(c.handle, 'pub_club', 'handle kept');
  r = await alice.call('PATCH', `/api/chats/${g}`, { isPublic: 'false' });
  assert.equal(r.status, 200);
  c = await chatOf(alice, g);
  assert.equal(c.isPublic, false);
  assert.equal(c.handle || '', '', 'going private gives the handle back');
  assert.ok((await alice.call('GET', `/api/chats/${g}/invites`)).invites.length >= 1, 'and makes an invite link');

  r = await alice.call('POST', '/api/chats', { type: 'group', title: 'S', isPublic: 'false' });
  assert.equal(r.status, 200);
  assert.equal(r.chat.isPublic, false, 'the text "false" makes a private chat');
  assert.ok((await alice.call('GET', `/api/chats/${r.chat.id}/invites`)).invites.length >= 1);
  r = await alice.call('POST', '/api/chats', { type: 'group', title: 'S', isPublic: 'true' });
  assert.equal(r.chat.isPublic, true);
  for (const v of [1, 'no', null]) {
    r = await alice.call('POST', '/api/chats', { type: 'group', title: 'S', isPublic: v });
    assert.equal(r.status, 400, `POST isPublic ${JSON.stringify(v)} refused`);
  }
}

// ---- 3. Nobody removes, bans or mutes the chat's owner, not the site owner nor themselves ----
{
  const g = await newChat(alice, { memberIds: [bob.id] });
  r = await owner.call('DELETE', `/api/chats/${g}/members/${alice.id}`);
  assert.equal(r.status, 400, 'site owner kicking the chat owner');
  r = await owner.call('DELETE', `/api/chats/${g}/members/${alice.id}?ban=1`);
  assert.equal(r.status, 400, 'site owner banning the chat owner');
  r = await owner.call('PATCH', `/api/chats/${g}/members/${alice.id}`, { mutedUntil: Date.now() + 3600e3 });
  assert.equal(r.status, 400, 'site owner muting the chat owner');
  r = await alice.call('DELETE', `/api/chats/${g}/members/${alice.id}`);
  assert.ok(r.status >= 400 && r.status < 500, 'the owner removing themselves');
  const m = (await membersOf(alice, g)).find((x) => x.id === alice.id);
  assert.equal(m?.chatRole, 'owner', 'still the owner');
  assert.ok(!m.mutedUntil, 'not muted');
  assert.equal((await alice.call('GET', `/api/chats/${g}`)).bans.length, 0, 'not banned');
  // The site owner's own chat: not by themselves either.
  const og = await newChat(owner, {});
  r = await owner.call('DELETE', `/api/chats/${og}/members/${owner.id}`);
  assert.equal(r.status, 400, 'owner of the chat removing themselves');
  assert.ok((await membersOf(owner, og)).some((x) => x.id === owner.id && x.chatRole === 'owner'));
  // Other members are still removed as before.
  assert.equal((await owner.call('DELETE', `/api/chats/${g}/members/${bob.id}`)).status, 200);
}

// ---- 4. null and wrong types for title/description ----
{
  r = await alice.call('POST', '/api/chats', { type: 'group', title: 'N', description: null });
  assert.equal(r.status, 200);
  const g = r.chat.id;
  assert.equal((await chatOf(alice, g)).description, '', 'null description is empty, not "null"');
  r = await alice.call('POST', '/api/chats', { type: 'group', title: null });
  assert.equal(r.status, 400);
  for (const bad of [{ title: 5 }, { title: 'x', description: 5 }, { title: ['a'] }]) {
    assert.equal((await alice.call('POST', '/api/chats', { type: 'group', ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { description: 'hello' })).status, 200);
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { description: null })).status, 200);
  assert.equal((await chatOf(alice, g)).description, '');
  for (const bad of [{ title: null }, { title: 7 }, { description: {} }]) {
    assert.equal((await alice.call('PATCH', `/api/chats/${g}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await chatOf(alice, g)).title, 'N', 'title unchanged');
}

// ---- 5. A handle's letter case can be changed ----
{
  const g = await newChat(alice, { isPublic: true, handle: 'caseclub' });
  r = await alice.call('PATCH', `/api/chats/${g}`, { handle: 'CaseClub' });
  assert.equal(r.status, 200);
  assert.equal((await chatOf(alice, g)).handle, 'CaseClub');
  // Still the one name: nobody else can take the other case of it.
  r = await bob.call('POST', '/api/chats', { type: 'group', title: 'X', isPublic: true, handle: 'caseclub' });
  assert.equal(r.status, 409);
}

// ---- 6. Bad values are a 4xx, not a server error ----
{
  const g = await newChat(alice, {});
  for (const avatar of [{ x: 1 }, 'abc', 1.5, -3, true]) {
    r = await alice.call('PATCH', `/api/chats/${g}`, { avatar });
    assert.equal(r.status, 400, `avatar ${JSON.stringify(avatar)}`);
  }
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { avatar: null })).status, 200);
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/999999?ban=1`)).status, 404);
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/999999`)).status, 404);
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/abc`)).status, 400);
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/abc?ban=1`)).status, 400);
  // Banning someone who isn't (yet) a member still works.
  assert.equal((await alice.call('DELETE', `/api/chats/${g}/members/${dave.id}?ban=1`)).status, 200);
  assert.ok((await alice.call('GET', `/api/chats/${g}`)).bans.some((b) => b.id === dave.id));
}

// ---- 8. Auto-delete in a private chat nobody has written in doesn't reveal it ----
{
  const dm = (await alice.call('POST', '/api/chats/dm', { userId: carol.id })).chat.id;
  assert.equal((await alice.call('PATCH', `/api/chats/${dm}`, { autoDelete: 3600 })).status, 200);
  assert.equal((await chatOf(alice, dm)).autoDelete, 3600, 'the timer is set');
  assert.ok(!(await carol.call('GET', '/api/chats')).chats.some((c) => c.id === dm), 'carol does not see the empty chat');
  // Once there is a conversation the notice is posted as before.
  assert.equal((await alice.call('POST', `/api/chats/${dm}/messages`, { text: 'hi' })).status, 200);
  assert.equal((await alice.call('PATCH', `/api/chats/${dm}`, { autoDelete: 0 })).status, 200);
  const msgs = (await carol.call('GET', `/api/chats/${dm}/messages`)).messages;
  assert.ok(msgs.some((m) => m.type === 'system' && m.text.includes('حذف خودکار')), 'notice after a real message');
  assert.equal(msgs.filter((m) => m.type === 'system').length, 1, 'and only that one');
}

// ---- 9. A folder whose only chat is gone ----
{
  const g = await newChat(alice, {});
  const keep = await newChat(alice, {});
  r = await alice.call('POST', '/api/folders', { name: 'Only', chatIds: [g] });
  assert.equal(r.status, 200);
  const fid = r.folder.id;
  r = await alice.call('POST', '/api/folders', { name: 'Two', chatIds: [g, keep] });
  const fid2 = r.folder.id;
  assert.equal((await alice.call('DELETE', `/api/chats/${g}`)).status, 200);
  let fs = (await alice.call('GET', '/api/folders')).folders;
  assert.deepEqual(fs.find((f) => f.id === fid).chatIds, [], 'a deleted chat leaves the folder');
  assert.deepEqual(fs.find((f) => f.id === fid2).chatIds, [keep]);
  r = await alice.call('PATCH', `/api/folders/${fid}`, { name: 'Renamed' });
  assert.equal(r.status, 200, 'an emptied folder can be renamed');
  assert.equal(r.folder.name, 'Renamed');
  r = await alice.call('PATCH', `/api/folders/${fid2}`, { name: 'Two renamed', emoji: '⭐' });
  assert.equal(r.status, 200);
  r = await alice.call('PATCH', `/api/folders/${fid}`, { chatIds: [] });
  assert.equal(r.status, 400, 'emptying a folder on purpose is still refused');
  assert.match(r.error, /پوشه/);
  r = await alice.call('PATCH', `/api/folders/${fid}`, { filters: ['groups'] });
  assert.equal(r.status, 200);
  // Leaving a chat drops it too.
  const other = await newChat(bob, { memberIds: [alice.id] });
  r = await alice.call('POST', '/api/folders', { name: 'Left', chatIds: [other, keep] });
  const fid3 = r.folder.id;
  assert.equal((await alice.call('POST', `/api/chats/${other}/leave`)).status, 200);
  fs = (await alice.call('GET', '/api/folders')).folders;
  assert.deepEqual(fs.find((f) => f.id === fid3).chatIds, [keep]);
}

// ---- Moderation mute values (also in a voice channel) ----
{
  const g = await newChat(alice, { memberIds: [bob.id] });
  for (const v of ['abc', -5, true, '123', {}]) {
    r = await alice.call('PATCH', `/api/chats/${g}/members/${bob.id}`, { mutedUntil: v });
    assert.equal(r.status, 400, `mutedUntil ${JSON.stringify(v)}`);
  }
  // A refused mute leaves the role change in the same request unsaved.
  r = await alice.call('PATCH', `/api/chats/${g}/members/${bob.id}`, { role: 'admin', perms: ['edit_info'], mutedUntil: 'abc' });
  assert.equal(r.status, 400);
  let m = (await membersOf(alice, g)).find((x) => x.id === bob.id);
  assert.equal(m.chatRole, 'member', 'role unchanged');
  assert.ok(!m.mutedUntil, 'not muted');
  // -1 means forever, as for /notify.
  assert.equal((await alice.call('PATCH', `/api/chats/${g}/members/${bob.id}`, { mutedUntil: -1 })).status, 200);
  m = (await membersOf(alice, g)).find((x) => x.id === bob.id);
  assert.ok(m.mutedUntil > Date.now() + 50 * 365 * 86400e3, 'muted for good');
  assert.equal((await bob.call('POST', `/api/chats/${g}/messages`, { text: 'x' })).status, 403, 'and cannot post');
  assert.equal((await alice.call('PATCH', `/api/chats/${g}/members/${bob.id}`, { mutedUntil: null })).status, 200);
  assert.equal((await bob.call('POST', `/api/chats/${g}/messages`, { text: 'x' })).status, 200);

  const v = await newChat(alice, { type: 'voice', isPublic: true, memberIds: [bob.id] });
  r = await alice.call('PATCH', `/api/chats/${v}/members/${bob.id}`, { mutedUntil: Date.now() + 3600e3 });
  assert.equal(r.status, 200, 'muting in a voice channel');
  assert.ok((await membersOf(alice, v)).find((x) => x.id === bob.id).mutedUntil > Date.now());
}

// ---- Group flags are real booleans ("false" used to turn them on) ----
{
  const g = await newChat(alice, {});
  for (const [k, v] of [['locked', 'nope'], ['hideMembers', 0], ['voiceStage', 'yes']]) {
    r = await alice.call('PATCH', `/api/chats/${g}`, { title: 'still', [k]: v });
    assert.equal(r.status, 400, `${k}: ${JSON.stringify(v)}`);
  }
  // The string "false" means off (it used to turn the lock on).
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { locked: 'false' })).status, 200);
  assert.equal((await alice.call('GET', `/api/chats/${g}`)).chat.locked, false, '"false" leaves it unlocked');
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { locked: true })).status, 200);
  assert.equal((await alice.call('PATCH', `/api/chats/${g}`, { locked: false })).status, 200);
}

// ---- Adding strangers costs from the lookup budget (no harvesting the user list via groups) ----
{
  const strangers = [];
  for (let i = 0; i < 25; i++) strangers.push((await register(`stranger${i}`)).id);
  const harvester = await register('harvester');
  r = await harvester.call('POST', '/api/chats', { type: 'group', title: 'harvest', memberIds: strangers });
  assert.equal(r.status, 429, 'pouring 25 strangers into a new group is refused');
  const g = await newChat(harvester, {});
  r = await harvester.call('POST', `/api/chats/${g}/members`, { userIds: strangers });
  assert.equal(r.status, 429, 'and into an existing one');
  assert.equal((await membersOf(harvester, g)).length, 1, 'nobody was added');
  // People you share a chat with cost nothing: alice adds bob to many groups in a row.
  for (let i = 0; i < 25; i++) assert.equal((await newChat(alice, { memberIds: [bob.id] })) > 0, true);
}

console.log('BUGS-CHATS TEST PASSED');
process.exit(0);
