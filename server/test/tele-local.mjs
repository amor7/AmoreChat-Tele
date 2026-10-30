// Tele without Telegram: who may use it (all / none / only listed / all but listed), the checks on
// the new routes, and settings that only their own routes may change.
// Usage: node test/tele-local.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client() {
  let cookie = '';
  const ip = `10.0.1.${ipN++}`;
  return async (method, url, body) => {
    const h = { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body && JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { http: res.status, ...(await res.json().catch(() => ({}))) };
  };
}

const owner = client();
let r = await owner('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP });
assert.equal(r.http, 200, JSON.stringify(r));
await owner('PATCH', '/api/admin/settings', { registration_mode: 'open' });
const users = {};
for (const name of ['alice', 'bob', 'carol']) {
  const c = client();
  r = await c('POST', '/api/auth/register', { username: name, password: PASS, displayName: name });
  assert.equal(r.http, 200, JSON.stringify(r));
  users[name] = { call: c, id: r.user.id };
}
const { alice, bob, carol } = users;

const allowed = async (u) => {
  const s = await u.call('GET', '/api/tele/status');
  assert.equal(s.http, 200);
  // The status and the other routes agree.
  const f = await u.call('GET', '/api/tele/find?q=abc');
  assert.equal(f.http === 403 && /مدیر بسته/.test(f.message || f.error || ''), !s.access, JSON.stringify({ s: s.access, f }));
  return s.access;
};

console.log('- default: everyone may use Telegram');
assert.equal(await allowed(alice), true);
r = await alice.call('GET', '/api/tele/find?q=abc');
assert.equal(r.http, 400, 'no account yet: a plain 400');
r = await alice.call('POST', '/api/tele/login/resend');
assert.equal(r.http, 400);
r = await alice.call('POST', '/api/tele/login/phone', { phone: 'abc' });
assert.equal(r.http, 400);

console.log('- only admins change it');
r = await bob.call('GET', '/api/admin/tele/access');
assert.equal(r.http, 403);
r = await bob.call('PATCH', '/api/admin/tele/access', { mode: 'none' });
assert.equal(r.http, 403);
r = await owner('PATCH', '/api/admin/tele/access', { mode: 'whatever' });
assert.equal(r.http, 400);
r = await owner('GET', '/api/admin/tele/access');
assert.equal(r.mode, 'all');
assert.ok(r.users.find((u) => u.username === 'alice')?.allowed);

console.log('- closed for all (the owner always may)');
r = await owner('PATCH', '/api/admin/tele/access', { mode: 'none' });
assert.equal(r.mode, 'none');
assert.equal(r.users.find((u) => u.owner).allowed, true);
assert.equal(await allowed(alice), false);
assert.equal(await allowed(bob), false);
assert.equal((await owner('GET', '/api/tele/status')).access, true);
r = await alice.call('POST', '/api/tele/login/phone', { phone: '+989120000000' });
assert.equal(r.http, 403);
for (const [m, u] of [['GET', '/api/tele/sessions'], ['POST', '/api/tele/dialogs/refresh'], ['POST', '/api/tele/join'], ['GET', '/api/tele/dialogs/1/messages']]) {
  r = await alice.call(m, u, m === 'POST' ? {} : undefined);
  assert.equal(r.http, 403, `${m} ${u}`);
}
// Logging out still works.
r = await alice.call('POST', '/api/tele/disconnect');
assert.equal(r.http, 200);

console.log('- only the listed users');
r = await owner('PATCH', '/api/admin/tele/access', { mode: 'allow', add: [alice.id] });
assert.deepEqual(r.users.filter((u) => u.listed).map((u) => u.username), ['alice']);
assert.equal(await allowed(alice), true);
assert.equal(await allowed(bob), false);
assert.equal(await allowed(carol), false);

console.log('- everyone but the listed users');
r = await owner('PATCH', '/api/admin/tele/access', { mode: 'deny', remove: [alice.id], add: [bob.id, 999999, 'x'] });
assert.deepEqual(r.users.filter((u) => u.listed).map((u) => u.username), ['bob']);
assert.equal(await allowed(alice), true);
assert.equal(await allowed(bob), false);
assert.equal(await allowed(carol), true);

console.log('- the general settings route can not change Telegram or security settings');
r = await owner('PATCH', '/api/admin/settings', { tele_access: 'all', sec_alerts: '0', tele_quota_mb: 'x' });
assert.equal(r.http, 200);
assert.equal((await owner('GET', '/api/admin/tele/access')).mode, 'deny');
assert.equal((await owner('GET', '/api/admin/security')).settings.alerts, true);
r = await owner('PATCH', '/api/admin/tele/access', { mode: 'all' });
assert.equal(await allowed(bob), true);

console.log('- mirrors and mirrored photos');
r = await alice.call('POST', '/api/mirror-photos/999999');
assert.equal(r.http, 404);
r = await alice.call('GET', '/api/admin/tele/mirrors/channels');
assert.equal(r.http, 403);
r = await owner('GET', '/api/admin/tele/mirrors/channels');
assert.equal(r.http, 400, 'no Telegram account: asks to connect one');
r = await owner('GET', '/api/admin/tele/mirrors');
assert.equal(r.connected, false);

console.log('- explore needs a connected account and the permission');
r = await carol.call('POST', '/api/tele/open', { tgChatId: '123' });
assert.equal(r.http, 400);
r = await carol.call('POST', '/api/tele/dialogs/1/leave');
assert.equal(r.http, 400);

console.log('\nTele (local): all checks passed');
