// Tele without Telegram: who may use it (all / none / only listed / all but listed), the checks on
// the new routes, settings that only their own routes may change, who may fetch mirrored videos /
// files, OpenVPN configs (cleaned and handed to the ovpn service), and updating from the panel.
// Usage: DATA_DIR=<the server's> node test/tele-local.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client() {
  let cookie = '';
  const ip = `10.0.1.${ipN++}`;
  return async (method, url, body, raw = null) => {
    const h = { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body) h['content-type'] = 'application/json';
    if (raw) h['content-type'] = 'application/octet-stream';
    const res = await fetch(BASE + url, { method, headers: h, body: raw || (body && JSON.stringify(body)) });
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

console.log('- fetching mirrored videos / files: only listed users by default, the owner always');
assert.equal((await owner('GET', '/api/auth/me')).user.mirrorFiles, true);
assert.equal((await alice.call('GET', '/api/auth/me')).user.mirrorFiles, false);
r = await alice.call('GET', '/api/admin/access/mirror-files');
assert.equal(r.http, 403);
r = await owner('GET', '/api/admin/access/mirror-files');
assert.equal(r.mode, 'allow');
r = await owner('PATCH', '/api/admin/access/mirror-files', { add: [alice.id] });
assert.deepEqual(r.users.filter((u) => u.listed).map((u) => u.username), ['alice']);
assert.equal((await alice.call('GET', '/api/auth/me')).user.mirrorFiles, true);
assert.equal((await bob.call('GET', '/api/auth/me')).user.mirrorFiles, false);
r = await owner('PATCH', '/api/admin/access/mirror-files', { mode: 'all' });
assert.equal((await bob.call('GET', '/api/auth/me')).user.mirrorFiles, true);
assert.equal(await allowed(bob), true, 'the Telegram list is a different one');
r = await owner('PATCH', '/api/admin/access/nope', { mode: 'all' });
assert.equal(r.http, 404);
r = await alice.call('POST', '/api/mirror-media/999999');
assert.equal(r.http, 404);

console.log('- OpenVPN: a .ovpn file is cleaned and handed to the ovpn service');
const DATA = process.env.DATA_DIR;
const OVPN = [
  '# comment',
  'client',
  'dev tun',
  'proto udp',
  'remote vpn.example.com 1194',
  'resolv-retry infinite',
  'script-security 2',
  'up /bin/sh -c "touch /tmp/pwned"',
  'route-up "/tmp/x.sh"',
  'redirect-gateway def1',
  'auth-user-pass',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'MIIBfake',
  '-----END CERTIFICATE-----',
  '</ca>',
  '',
].join('\n');
r = await alice.call('POST', '/api/admin/tele/proxies', { openvpn: { ovpn: OVPN } });
assert.equal(r.http, 403);
r = await owner('POST', '/api/admin/tele/proxies', { name: 'ovpn test', openvpn: { ovpn: OVPN, username: 'u1', password: 'p1' } });
assert.equal(r.http, 200, JSON.stringify(r));
const vpnId = r.proxy.id;
assert.equal(r.proxy.protocol, 'openvpn');
if (DATA) {
  const dir = path.join(DATA, 'ovpn', String(vpnId));
  const conf = fs.readFileSync(path.join(dir, 'client.ovpn'), 'utf8');
  assert.match(conf, /^remote vpn\.example\.com 1194$/m);
  assert.match(conf, /BEGIN CERTIFICATE/);
  for (const bad of ['script-security', 'up ', 'route-up', 'redirect-gateway', 'auth-user-pass', 'dev tun']) assert.ok(!conf.split('\n').some((l) => l.startsWith(bad)), `${bad} removed`);
  assert.equal(fs.readFileSync(path.join(dir, 'auth.txt'), 'utf8'), 'u1\np1\n');
  assert.ok(fs.readFileSync(path.join(dir, 'socks.auth'), 'utf8').length >= 32);
  // Turned off: its folder goes (the service stops it); on again: back.
  await owner('PATCH', `/api/admin/tele/proxies/${vpnId}`, { enabled: false });
  assert.ok(!fs.existsSync(dir));
  await owner('PATCH', `/api/admin/tele/proxies/${vpnId}`, { enabled: true });
  assert.ok(fs.existsSync(path.join(dir, 'client.ovpn')));
}
r = await owner('POST', '/api/admin/tele/proxies', { openvpn: { ovpn: OVPN.replace('dev tun', 'dev tap') } });
assert.equal(r.http, 400);
r = await owner('POST', '/api/admin/tele/proxies', { openvpn: { ovpn: 'client\ndev tun\n' } });
assert.equal(r.http, 400, 'no remote');
r = await owner('POST', '/api/admin/tele/proxies', { openvpn: { ovpn: OVPN.replace('<ca>', '<foo>').replace('</ca>', '</foo>') } });
assert.equal(r.http, 400, 'unknown block');
// Pasted as a "link": recognized as OpenVPN.
r = await owner('POST', '/api/admin/tele/proxies', { links: OVPN });
assert.equal(r.http, 200, JSON.stringify(r));
assert.equal(r.proxy.protocol, 'openvpn');
await owner('DELETE', `/api/admin/tele/proxies/${r.proxy.id}`);
if (DATA) assert.ok(!fs.existsSync(path.join(DATA, 'ovpn', String(r.proxy.id))));
await owner('DELETE', `/api/admin/tele/proxies/${vpnId}`);

console.log('- update from the panel: owner only, release file names only, resumable');
r = await alice.call('GET', '/api/admin/update');
assert.equal(r.http, 403);
r = await owner('GET', '/api/admin/update');
assert.equal(r.http, 200);
assert.equal(r.agent, false, 'no helper on a test server');
assert.ok(r.problems.some((p) => /amorechat-update/.test(p)));
assert.equal(r.ready, false);
r = await owner('PUT', '/api/admin/update/files/evil.sh?offset=0', null, Buffer.from('x'));
assert.equal(r.http, 400);
r = await owner('PUT', '/api/admin/update/files/..%2Fx?offset=0', null, Buffer.from('x'));
assert.ok(r.http === 400 || r.http === 404);
r = await alice.call('PUT', '/api/admin/update/files/manifest.json?offset=0', null, Buffer.from('{}'));
assert.equal(r.http, 403);
const manifest = Buffer.from(JSON.stringify({ version: '99.0.0', runtime: 'aaaaaaaaaaaa', deps: 'bbbbbbbbbbbb', caddy: 'caddy:x', caddyId: 'sha256:c', livekit: 'lk:x', livekitId: 'sha256:l' }));
r = await owner('PUT', '/api/admin/update/files/manifest.json?offset=0', null, manifest.subarray(0, 10));
assert.equal(r.size, 10);
r = await owner('PUT', '/api/admin/update/files/manifest.json?offset=5', null, manifest.subarray(5));
assert.equal(r.resend, true, 'a wrong offset is not appended');
r = await owner('PUT', '/api/admin/update/files/manifest.json?offset=10', null, manifest.subarray(10));
assert.equal(r.size, manifest.length);
if (DATA) {
  // As the server helper would write it: this server has none of the new images.
  fs.writeFileSync(path.join(DATA, 'update', 'host.json'), JSON.stringify({ at: 1, version: '1.0.0', images: ['amorechat-runtime:000000000000 sha256:x'] }));
}
r = await owner('GET', '/api/admin/update');
assert.equal(r.target, '99.0.0');
assert.equal(r.ready, false);
if (DATA) {
  const need = r.needed.map((n) => n.name);
  for (const n of ['amorechat-source.tar.gz', 'manifest.json', 'amorechat-app.tar.gz', 'SHA256SUMS', 'SHA256SUMS.sig', 'amorechat-runtime-aaaaaaaaaaaa-amd64.tar.gz', 'amorechat-deps-bbbbbbbbbbbb-amd64.tar.gz']) assert.ok(need.includes(n), `needs ${n}`);
  assert.ok(r.needed.find((n) => n.name === 'manifest.json').have);
  // Caddy and LiveKit here under their names, with other ids (other Docker): nothing more is needed.
  fs.writeFileSync(path.join(DATA, 'update', 'host.json'), JSON.stringify({ at: 1, version: '1.0.0', images: ['amorechat-runtime:aaaaaaaaaaaa sha256:r', 'docker.io/library/caddy:x sha256:other', 'lk:x sha256:other2'] }));
  fs.utimesSync(path.join(DATA, 'update', 'host.json'), new Date(), new Date());
  const again = (await owner('GET', '/api/admin/update')).needed.map((n) => n.name);
  assert.ok(!again.some((n) => n.includes('amorechat-deps-')), 'the deps file is not asked for again');
  assert.ok(!again.some((n) => n.includes('amorechat-runtime-')));
  // A signature that is not the release's.
  fs.copyFileSync(path.resolve(import.meta.dirname, '../../deploy/release-signing.pub'), path.join(DATA, 'update', 'release-signing.pub'));
  await owner('PUT', '/api/admin/update/files/SHA256SUMS?offset=0', null, Buffer.from('0'.repeat(64) + '  manifest.json\n'));
  await owner('PUT', '/api/admin/update/files/SHA256SUMS.sig?offset=0', null, Buffer.alloc(64, 1));
  r = await owner('GET', '/api/admin/update');
  assert.equal(r.signed, false);
  assert.ok(r.problems.some((p) => /امضا/.test(p)));
}
r = await owner('POST', '/api/admin/update/apply');
assert.equal(r.http, 400);
r = await owner('DELETE', '/api/admin/update/files');
assert.equal(r.files.length, 0);

console.log('\nTele (local): all checks passed');
