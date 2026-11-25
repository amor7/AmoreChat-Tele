// Regression checks for account bugs: PATCH /api/me half-saves and wrong types, profile and
// last-seen privacy (empty private chats, hidden-member groups, the lookup budget), two-step
// login brute force and stale tickets, the trusted-device lock after an admin reset, and two
// Telegram passcodes turned on at once.
// Usage: node test/bugs-account.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

// Keeps every cookie (session and trusted-device) and sends each request from a new IP, so the
// per-IP rate limit doesn't hide what the per-account / per-device counters do.
let ipN = 1;
function client(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') {
  const jar = {};
  async function call(method, url, body, { form } = {}) {
    const ip = `10.1.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
    const h = { 'x-requested-with': 'amorechat', 'user-agent': ua, 'x-forwarded-for': ip };
    const c = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (c) h.cookie = c;
    if (body && !form) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: form || (body && JSON.stringify(body)) });
    for (const s of res.headers.getSetCookie()) {
      const [kv] = s.split(';');
      const i = kv.indexOf('=');
      jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return { call, jar };
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
const wrongCode = (secret) => ['000000', '111111', '222222'].find((c) => ![-1, 0, 1].some((o) => totp(secret, o) === c));

const owner = client();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
const ownerId = r.user.id;
await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' });

async function reg(name, ua) {
  const c = client(ua);
  const res = await c.call('POST', '/api/auth/register', { username: name, password: PASS, displayName: name });
  assert.equal(res.status, 200, JSON.stringify(res));
  c.id = res.user.id;
  return c;
}
const me = async (c) => (await c.call('GET', '/api/auth/me')).user;

// Turns two-step login on (using the previous step's code, so the current and next stay usable).
async function enable2fa(c, password = PASS) {
  const s = await c.call('POST', '/api/me/2fa/setup', { password });
  assert.ok(s.secret, JSON.stringify(s));
  const e = await c.call('POST', '/api/me/2fa/enable', { code: totp(s.secret, -1) });
  assert.equal(e.status, 200, JSON.stringify(e));
  return s.secret;
}

// ---- 1. PATCH /api/me: a bad field changes nothing ----
const carol = await reg('carol');
r = await carol.call('PATCH', '/api/me', { lastSeenPrivacy: 'nobody', displayName: '   ' });
assert.equal(r.status, 400);
assert.equal((await me(carol)).lastSeenPrivacy, 'everyone', 'privacy not written before the bad name');
r = await carol.call('PATCH', '/api/me', { displayName: 'Changed', bio: 'BIO', avatar: 999999 });
assert.equal(r.status, 400);
let m = await me(carol);
assert.deepEqual([m.displayName, m.bio || ''], ['carol', ''], 'name and bio not written before the bad avatar');
r = await carol.call('PATCH', '/api/me', { displayName: '  Carol  ', bio: 'hi', lastSeenPrivacy: 'contacts' });
assert.equal(r.status, 200, JSON.stringify(r));
assert.deepEqual([r.user.displayName, r.user.bio, r.user.lastSeenPrivacy], ['Carol', 'hi', 'contacts']);

// ---- 2. Wrong types are refused, not stored as "null" / "[object Object]" or a 500 ----
for (const body of [{ displayName: null }, { displayName: { a: 1 } }, { displayName: 5 }, { bio: { a: 1 } }, { bio: 7 }, { avatar: true }, { avatar: {} }, { avatar: '1' }, { avatar: 1.5 }]) {
  r = await carol.call('PATCH', '/api/me', body);
  assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
}
m = await me(carol);
assert.deepEqual([m.displayName, m.bio], ['Carol', 'hi']);
r = await carol.call('PATCH', '/api/me', { bio: null });
assert.equal(r.status, 200);
assert.equal(r.user.bio, '', 'bio null clears it');
// Avatar: set, then removed with null
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const f = new FormData();
f.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
const img = await carol.call('POST', '/api/upload', null, { form: f });
if (img.file?.id) {
  r = await carol.call('PATCH', '/api/me', { avatar: img.file.id });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.user.avatar, img.file.id);
  r = await carol.call('PATCH', '/api/me', { avatar: null });
  assert.equal(r.status, 200);
  assert.equal(r.user.avatar, null);
} else console.log('(upload unavailable, avatar set/remove skipped)', img.status);
for (const body of [
  { username: 'zed1', password: PASS, displayName: { a: 1 } },
  { username: 'zed2', password: PASS, displayName: null },
  { username: ['zed3'], password: PASS, displayName: 'Zed' },
]) {
  r = await client().call('POST', '/api/auth/register', body);
  assert.equal(r.status, 400, `register ${JSON.stringify(body)} → ${r.status}`);
}

// ---- 3. An empty private chat is not a "contact" ----
const dave = await reg('dave');
const erin = await reg('erin');
await dave.call('PATCH', '/api/me', { lastSeenPrivacy: 'contacts' });
r = await erin.call('POST', '/api/chats/dm', { userId: dave.id });
assert.equal(r.status, 200, JSON.stringify(r));
const dm = r.chat.id;
r = await erin.call('GET', `/api/users/${dave.id}`);
assert.equal(r.status, 404, 'an empty private chat does not open the profile');
r = await erin.call('POST', `/api/chats/${dm}/messages`, { text: 'سلام' });
assert.equal(r.status, 200, JSON.stringify(r));
r = await erin.call('GET', `/api/users/${dave.id}`);
assert.equal(r.status, 200);
assert.ok(!r.user.lastSeenHidden && r.user.lastSeen, 'with a message they are contacts');

// ---- 4. Hidden member list: no profile / last seen of other members ----
await owner.call('PATCH', '/api/admin/settings', { allow_user_groups: '1' });
const frank = await reg('frank');
const gina = await reg('gina');
await frank.call('PATCH', '/api/me', { lastSeenPrivacy: 'contacts' });
r = await owner.call('POST', '/api/chats', { type: 'group', title: 'پنهان', memberIds: [frank.id, gina.id] });
const g = r.chat.id;
r = await owner.call('PATCH', `/api/chats/${g}`, { hideMembers: true });
assert.equal(r.status, 200, JSON.stringify(r));
r = await gina.call('GET', `/api/users/${frank.id}`);
assert.equal(r.status, 404, 'a hidden member is not found');
r = await gina.call('GET', `/api/users/${ownerId}`);
assert.equal(r.status, 200, 'the group owner is shown in the list, so the profile opens');
r = await frank.call('POST', `/api/chats/${g}/messages`, { text: 'hi' });
assert.equal(r.status, 200);
r = await gina.call('GET', `/api/users/${frank.id}`);
assert.equal(r.status, 200, 'someone who posted in the group can be opened');
assert.equal(r.user.lastSeenHidden, true, 'but a hidden group does not make them contacts');
// The profile lookup has a budget: ids can't be walked through.
const hal = await reg('hal');
let refused = false;
for (let i = 0; i < 30 && !refused; i++) refused = (await hal.call('GET', `/api/users/${1000 + i}`)).status === 429;
assert.ok(refused, 'profile lookups by id are limited per minute');
r = await hal.call('GET', `/api/users/${hal.id}`);
assert.equal(r.status, 200, 'your own profile is not counted');

// ---- 5. Wrong two-step codes lock the account (a right password doesn't reset the count) ----
const ivan = await reg('ivan');
const ivanSecret = await enable2fa(ivan);
const bad = wrongCode(ivanSecret);
let spare = null;
for (let i = 0; i < 10; i++) {
  const c = client();
  r = await c.call('POST', '/api/auth/login', { username: 'ivan', password: PASS });
  assert.equal(r.twoFactor, true, `round ${i}: ${JSON.stringify(r)}`);
  if (i === 9) spare = (await client().call('POST', '/api/auth/login', { username: 'ivan', password: PASS })).ticket;
  r = await c.call('POST', '/api/auth/2fa', { ticket: r.ticket, code: bad });
  assert.equal(r.status, 401);
}
assert.ok(spare);
r = await client().call('POST', '/api/auth/2fa', { ticket: spare, code: totp(ivanSecret) });
assert.equal(r.status, 401, '/2fa refuses a locked account even with the right code');
r = await client().call('POST', '/api/auth/login', { username: 'ivan', password: PASS });
assert.equal(r.status, 401, 'login is locked after 10 wrong codes');

// ---- 6. Old tickets stop working ----
// 2FA turned off: was a 500
const jane = await reg('jane');
const janeSecret = await enable2fa(jane);
const janeTicket = (await client().call('POST', '/api/auth/login', { username: 'jane', password: PASS })).ticket;
r = await jane.call('POST', '/api/me/2fa/disable', { password: PASS, code: totp(janeSecret) });
assert.equal(r.status, 200, JSON.stringify(r));
r = await client().call('POST', '/api/auth/2fa', { ticket: janeTicket, code: totp(janeSecret, 1) });
assert.equal(r.status, 401, `ticket after 2FA off → ${r.status}`);
// Password changed
const kate = await reg('kate');
const kateSecret = await enable2fa(kate);
const kateTicket = (await client().call('POST', '/api/auth/login', { username: 'kate', password: PASS })).ticket;
r = await kate.call('POST', '/api/auth/password', { current: PASS, next: 'Other-Pass-99' });
assert.equal(r.status, 200, JSON.stringify(r));
r = await client().call('POST', '/api/auth/2fa', { ticket: kateTicket, code: totp(kateSecret) });
assert.equal(r.status, 401, 'ticket from before a password change');
// Admin reset
const liam = await reg('liam');
const liamSecret = await enable2fa(liam);
const liamTicket = (await client().call('POST', '/api/auth/login', { username: 'liam', password: PASS })).ticket;
r = await owner.call('POST', `/api/admin/users/${liam.id}/reset-password`);
assert.ok(r.password, JSON.stringify(r));
const liamPass = r.password;
r = await client().call('POST', '/api/auth/2fa', { ticket: liamTicket, code: totp(liamSecret) });
assert.equal(r.status, 401, 'ticket from before an admin reset');
// A fresh ticket still works
const liamC = client();
r = await liamC.call('POST', '/api/auth/login', { username: 'liam', password: liamPass });
r = await liamC.call('POST', '/api/auth/2fa', { ticket: r.ticket, code: totp(liamSecret) });
assert.equal(r.status, 200, JSON.stringify(r));

// ---- Trusted-device lock is lifted by an admin password reset ----
const mia = await reg('mia');
for (let i = 0; i < 10; i++) await mia.call('POST', '/api/auth/login', { username: 'mia', password: 'wrong-' + i });
r = await mia.call('POST', '/api/auth/login', { username: 'mia', password: PASS });
assert.equal(r.status, 401, 'this device is locked');
r = await owner.call('POST', `/api/admin/users/${mia.id}/reset-password`);
r = await mia.call('POST', '/api/auth/login', { username: 'mia', password: r.password });
assert.equal(r.status, 200, `after an admin reset the device can log in → ${JSON.stringify(r)}`);

// ---- 7. Two passcodes at once: one wins, the other is a 400 (was a 500) ----
const nina = await reg('nina');
const both = await Promise.all(['12345', '67890'].map((passcode) => nina.call('POST', '/api/tele/passcode', { password: PASS, passcode })));
assert.deepEqual(both.map((x) => x.status).sort(), [200, 400], JSON.stringify(both));

console.log('bugs-account: all checks passed');
process.exit(0);
