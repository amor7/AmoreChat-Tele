// Tele without Telegram: who may use it (all / none / only listed / all but listed), the checks on
// the new routes, settings that only their own routes may change, who may fetch mirrored videos /
// files, OpenVPN configs (cleaned and handed to the ovpn service), updating from the panel, and the
// user's own Telegram passcode (what it locks, what admins can't undo, backups without that history).
// Usage: DATA_DIR=<the server's> node test/tele-local.mjs <baseUrl> <setupCode>   (fresh, empty DATA_DIR)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client() {
  let cookie = '';
  const ip = `10.0.1.${ipN++}`;
  return async (method, url, body, raw = null, extra = {}) => {
    const { binary, ...more } = extra;
    const h = { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip, ...more };
    if (cookie) h.cookie = cookie;
    if (body) h['content-type'] = 'application/json';
    if (raw) h['content-type'] = 'application/octet-stream';
    const res = await fetch(BASE + url, { method, headers: h, body: raw || (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (binary) return { http: res.status, body: Buffer.from(await res.arrayBuffer()) };
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
r = await bob.call('GET', '/api/admin/access/tele');
assert.equal(r.http, 403);
r = await bob.call('PATCH', '/api/admin/access/tele', { mode: 'none' });
assert.equal(r.http, 403);
r = await owner('PATCH', '/api/admin/access/tele', { mode: 'whatever' });
assert.equal(r.http, 400);
r = await owner('GET', '/api/admin/access/tele');
assert.equal(r.mode, 'all');
assert.ok(r.users.find((u) => u.username === 'alice')?.allowed);

console.log('- closed for all (the owner always may)');
r = await owner('PATCH', '/api/admin/access/tele', { mode: 'none' });
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
r = await owner('PATCH', '/api/admin/access/tele', { mode: 'allow', add: [alice.id] });
assert.deepEqual(r.users.filter((u) => u.listed).map((u) => u.username), ['alice']);
assert.equal(await allowed(alice), true);
assert.equal(await allowed(bob), false);
assert.equal(await allowed(carol), false);

console.log('- everyone but the listed users');
r = await owner('PATCH', '/api/admin/access/tele', { mode: 'deny', remove: [alice.id], add: [bob.id, 999999, 'x'] });
assert.deepEqual(r.users.filter((u) => u.listed).map((u) => u.username), ['bob']);
assert.equal(await allowed(alice), true);
assert.equal(await allowed(bob), false);
assert.equal(await allowed(carol), true);

console.log('- the general settings route can not change Telegram or security settings');
r = await owner('PATCH', '/api/admin/settings', { tele_access: 'all', sec_alerts: '0', tele_quota_mb: 'x' });
assert.equal(r.http, 200);
assert.equal((await owner('GET', '/api/admin/access/tele')).mode, 'deny');
assert.equal((await owner('GET', '/api/admin/security')).settings.alerts, true);
r = await owner('PATCH', '/api/admin/access/tele', { mode: 'all' });
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

console.log('- Telegram passcode: turning it on');
const login = async (username, password = PASS) => {
  const c = client();
  const res = await c('POST', '/api/auth/login', { username, password });
  assert.equal(res.http, 200, JSON.stringify(res));
  return c;
};
const newUser = async (name) => {
  const c = client();
  const res = await c('POST', '/api/auth/register', { username: name, password: PASS, displayName: name });
  assert.equal(res.http, 200, JSON.stringify(res));
  return { call: c, id: res.user.id };
};
const dave = await newUser('dave');
const erin = await newUser('erin');
r = await dave.call('GET', '/api/tele/passcode');
assert.deepEqual([r.http, r.enabled, r.unlocked], [200, false, true]);
for (const [body, why] of [
  [{ password: PASS, passcode: '123' }, 'too short'],
  [{ password: PASS, passcode: '۱۲۳' }, 'too short in Persian digits'],
  [{ password: PASS, passcode: 'x'.repeat(65) }, 'too long'],
  [{ password: 'wrong-password', passcode: '12345' }, 'wrong account password'],
  [{ password: PASS, passcode: 12345 }, 'not text'],
  [{ password: PASS, passcode: '12345', idleMin: 30 }, 'idle not one of the choices'],
]) {
  r = await dave.call('POST', '/api/tele/passcode', body);
  assert.equal(r.http, 400, why);
}
assert.equal((await dave.call('GET', '/api/tele/passcode')).enabled, false);
r = await dave.call('POST', '/api/tele/passcode', { password: PASS, passcode: '۱۲۳۴۵', idleMin: 15 });
assert.equal(r.http, 200, JSON.stringify(r));
assert.deepEqual([r.enabled, r.unlocked, r.idleMin], [true, true, 15]);
assert.ok(!('hash' in r));
r = await dave.call('POST', '/api/tele/passcode', { password: PASS, passcode: '99999' });
assert.equal(r.http, 400, 'already on');
// The login that turned it on stays open.
assert.notEqual((await dave.call('GET', '/api/tele/sessions')).http, 423);

// Telegram data as the bridge would have stored it (no Telegram here): dave has a passcode, bob none.
const DBF = DATA && path.join(DATA, 'amorechat.db');
if (DBF) {
  const live = new DatabaseSync(DBF);
  live.exec('PRAGMA busy_timeout = 5000');
  const t = Date.now();
  for (const [u, name] of [[dave, 'Dave TG'], [bob, 'Bob TG']]) {
    const acc = Number(live.prepare("INSERT INTO tele_accounts (user_id, display_name, status, created_at, updated_at) VALUES (?, ?, 'disconnected', ?, ?)").run(u.id, name, t, t).lastInsertRowid);
    const dlg = Number(live.prepare("INSERT INTO tele_dialogs (account_id, tg_chat_id, title, last_text, created_at, updated_at) VALUES (?, '777', ?, 'secret preview', ?, ?)").run(acc, `${name} chat`, t, t).lastInsertRowid);
    for (let i = 1; i <= 3; i++) live.prepare('INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(acc, dlg, i, `${name} secret ${i}`, t);
  }
  live.close();
}

console.log('- a new login is locked: only the status (saying so) answers');
const dave2 = await login('dave');
r = await dave2('GET', '/api/tele/status');
assert.equal(r.http, 200);
assert.equal(r.locked, true);
assert.deepEqual(r.passcode, { idleMin: 15 });
for (const k of ['account', 'dialogs', 'traffic', 'usage', 'runtime', 'codeInfo']) assert.ok(!(k in r), `status hides ${k}`);
const guarded = [
  ['GET', '/api/tele/sessions'],
  ['POST', '/api/tele/sessions/end-others'],
  ['DELETE', '/api/tele/sessions/1'],
  ['POST', '/api/tele/dialogs/refresh'],
  ['GET', '/api/tele/dialogs/1/messages'],
  ['GET', '/api/tele/dialogs/1/search?q=a'],
  ['PATCH', '/api/tele/dialogs/1'],
  ['POST', '/api/tele/dialogs/1/messages'],
  ['POST', '/api/tele/dialogs/1/leave'],
  ['POST', '/api/tele/forward'],
  ['POST', '/api/tele/messages/1/forward'],
  ['GET', '/api/tele/messages/1/photo'],
  ['GET', '/api/tele/messages/1/voice'],
  ['GET', '/api/tele/messages/1/file'],
  ['DELETE', '/api/tele/messages/1'],
  ['GET', '/api/tele/find?q=abc'],
  ['POST', '/api/tele/open'],
  ['POST', '/api/tele/join'],
  ['POST', '/api/tele/login/phone'],
  ['POST', '/api/tele/login/code'],
  ['POST', '/api/tele/disconnect'],
];
for (const [m, u] of guarded) {
  r = await dave2(m, u, m === 'GET' ? undefined : {});
  assert.equal(r.http, 423, `${m} ${u}`);
  assert.equal(r.error, 'بخش تلگرام قفل است');
}
// The router decodes the path; the lock must not depend on how the URL is written.
r = await dave2('GET', '/api/%74ele/sessions');
assert.ok(r.http === 423 || r.http === 404, `encoded path: ${r.http}`);
r = await dave2('GET', '/api/tele/passcode');
assert.deepEqual([r.enabled, r.unlocked], [true, false]);
// Other users are not affected.
r = await bob.call('GET', '/api/tele/status');
assert.ok(!r.locked && 'dialogs' in r);

console.log('- the owner: mirror settings are locked, the rest of the panel is not; no Telegram names');
r = await owner('POST', '/api/tele/passcode', { password: PASS, passcode: 'owner-pc-1' });
assert.equal(r.http, 200, JSON.stringify(r));
const owner2 = await login('owner');
for (const u of ['/api/admin/tele/mirrors', '/api/admin/tele/mirrors/channels']) assert.equal((await owner2('GET', u)).http, 423, u);
assert.equal((await owner2('PATCH', '/api/admin/tele/mirrors-settings', { minutes: 5 })).http, 423);
assert.equal((await owner('GET', '/api/admin/tele/mirrors')).http, 200, 'the owner login that turned it on');
assert.equal((await owner2('POST', '/api/mirror-media/999999')).http, 404, 'public mirrored posts are not locked');
r = await owner2('GET', '/api/admin/tele/accounts');
assert.equal(r.http, 200);
if (DBF) {
  assert.equal(r.accounts.find((a) => a.userId === dave.id).tgName, '');
  assert.equal(r.accounts.find((a) => a.userId === bob.id).tgName, 'Bob TG');
}
assert.equal((await owner('DELETE', '/api/tele/passcode', { current: 'wrong-one' })).http, 400);
r = await owner('DELETE', '/api/tele/passcode', { current: 'owner-pc-1' });
assert.deepEqual([r.http, r.enabled], [200, false]);
assert.equal((await owner2('GET', '/api/admin/tele/mirrors')).http, 200);

console.log('- unlock (Persian or Latin digits), lock, idle choices');
assert.equal((await dave2('POST', '/api/tele/passcode/unlock', { passcode: '00000' })).http, 400);
r = await dave2('POST', '/api/tele/passcode/unlock', { passcode: '12345' });
assert.deepEqual([r.http, r.unlocked], [200, true]);
for (const [m, u] of guarded.filter(([, u]) => u !== '/api/tele/disconnect')) {
  r = await dave2(m, u, m === 'GET' ? undefined : {});
  assert.notEqual(r.http, 423, `${m} ${u} unlocked`);
}
r = await dave2('GET', '/api/tele/status', undefined, null, { 'x-amore-poll': '1' });
assert.ok(!r.locked && 'dialogs' in r);
r = await dave2('POST', '/api/tele/passcode/lock');
assert.equal(r.unlocked, false);
assert.equal((await dave2('GET', '/api/tele/sessions')).http, 423);
r = await dave2('POST', '/api/tele/passcode/unlock', { passcode: '۱۲۳۴۵' });
assert.equal(r.unlocked, true);
assert.equal((await dave.call('PATCH', '/api/tele/passcode', { current: '12345', idleMin: 7 })).http, 400);
assert.equal((await dave.call('PATCH', '/api/tele/passcode', { current: '12345' })).http, 400, 'nothing to change');
r = await dave.call('PATCH', '/api/tele/passcode', { current: '12345', idleMin: 0 });
assert.deepEqual([r.http, r.idleMin], [200, 0]);
assert.notEqual((await dave2('GET', '/api/tele/sessions')).http, 423, 'an idle change keeps other logins open');

console.log('- a new passcode locks the other logins');
assert.equal((await dave.call('PATCH', '/api/tele/passcode', { current: '12345', next: 'ab' })).http, 400);
r = await dave.call('PATCH', '/api/tele/passcode', { current: '12345', next: 'new-pass-۷' });
assert.deepEqual([r.http, r.unlocked], [200, true]);
assert.equal((await dave2('GET', '/api/tele/sessions')).http, 423);
assert.notEqual((await dave.call('GET', '/api/tele/sessions')).http, 423);
assert.equal((await dave2('POST', '/api/tele/passcode/unlock', { passcode: '12345' })).http, 400, 'the old one no longer works');
assert.equal((await dave2('POST', '/api/tele/passcode/unlock', { passcode: 'new-pass-7' })).http, 200);

console.log('- logging out locks it, also on the same device');
await dave2('POST', '/api/auth/logout');
assert.equal((await dave2('POST', '/api/auth/login', { username: 'dave', password: PASS })).http, 200);
assert.equal((await dave2('GET', '/api/tele/status')).locked, true);

console.log('- an admin who resets the password and logs in as the user is still locked out');
r = await owner('POST', `/api/admin/users/${dave.id}/reset-password`);
assert.equal(r.http, 200);
const davePass = r.password;
const asAdmin = await login('dave', davePass);
r = await asAdmin('GET', '/api/tele/passcode');
assert.deepEqual([r.enabled, r.unlocked], [true, false]);
assert.equal((await asAdmin('GET', '/api/tele/status')).locked, true);
assert.equal((await asAdmin('GET', '/api/tele/dialogs/1/messages')).http, 423);
// Turning it off or changing it needs the passcode itself, not the (reset) account password.
assert.equal((await asAdmin('DELETE', '/api/tele/passcode', { current: davePass })).http, 400);
assert.equal((await asAdmin('POST', '/api/tele/passcode', { password: davePass, passcode: '11111' })).http, 400, 'can not be set over');
assert.equal((await owner('PATCH', `/api/admin/users/${dave.id}`, { role: 'admin', adminPerms: ['manage_users'] })).http, 200);
assert.equal((await owner('PATCH', `/api/admin/users/${dave.id}`, { role: 'user' })).http, 200);
assert.equal((await owner('POST', `/api/admin/users/${dave.id}/reset-2fa`)).http, 200);
assert.equal((await owner('POST', `/api/admin/users/${dave.id}/logout-all`)).http, 200);
const dave3 = await login('dave', davePass);
r = await dave3('GET', '/api/tele/passcode');
assert.deepEqual([r.enabled, r.unlocked, r.idleMin], [true, false, 0], 'admin actions leave the passcode as it was');
assert.ok(!JSON.stringify(await owner('GET', '/api/admin/users')).includes('scrypt$'), 'no hash in the user list');

console.log('- 5 wrong passcodes: even the right one waits 15 minutes');
assert.equal((await erin.call('POST', '/api/tele/passcode', { password: PASS, passcode: 'erin-pc' })).http, 200);
const erin2 = await login('erin');
for (let i = 1; i <= 4; i++) assert.equal((await erin2('POST', '/api/tele/passcode/unlock', { passcode: `wrong-${i}` })).http, 400);
assert.equal((await erin2('POST', '/api/tele/passcode/unlock', { passcode: 'wrong-5' })).http, 429);
r = await erin2('POST', '/api/tele/passcode/unlock', { passcode: 'erin-pc' });
assert.equal(r.http, 429, 'the right one is not even checked');
assert.match(r.error, /دقیقه/);
assert.ok(r.lockedUntil > Date.now() + 14 * 60_000, 'the 429 says until when (for a countdown)');
r = await erin2('GET', '/api/tele/passcode');
assert.ok(r.lockedUntil > Date.now() + 14 * 60_000);
assert.equal(r.unlocked, false);
assert.equal((await erin.call('PATCH', '/api/tele/passcode', { current: 'erin-pc', idleMin: 5 })).http, 429, 'nor by changing it');
assert.equal((await erin.call('DELETE', '/api/tele/passcode', { current: 'erin-pc' })).http, 429, 'nor by turning it off');
assert.notEqual((await erin.call('GET', '/api/tele/sessions')).http, 423, 'a login that was already open stays open');

if (DBF) {
  console.log('- backups leave out the Telegram history of passcode users');
  const count = (f, sql, ...a) => {
    const d = new DatabaseSync(f, { readOnly: true });
    try {
      return d.prepare(sql).get(...a).n;
    } finally {
      d.close();
    }
  };
  const msgs = (f, u) => count(f, 'SELECT COUNT(*) AS n FROM tele_messages m JOIN tele_accounts a ON a.id = m.account_id WHERE a.user_id = ?', u.id);
  const named = (f, u) => count(f, "SELECT COUNT(*) AS n FROM tele_dialogs d JOIN tele_accounts a ON a.id = d.account_id WHERE a.user_id = ? AND (title != '' OR last_text != '')", u.id);
  assert.equal(msgs(DBF, dave), 3, 'the live database keeps them');
  const dl = await owner('GET', '/api/admin/backup/db', undefined, null, { binary: true });
  assert.equal(dl.http, 200);
  const snap = path.join(DATA, 'snapshot-test.db');
  fs.writeFileSync(snap, dl.body);
  assert.equal(msgs(snap, dave), 0);
  assert.equal(named(snap, dave), 0);
  assert.equal(msgs(snap, bob), 3);
  assert.equal(named(snap, bob), 1);
  assert.ok(!dl.body.includes(Buffer.from('Dave TG secret')), 'not even in free pages');
  fs.rmSync(snap, { force: true });
  const made = (await owner('POST', '/api/admin/backups')).name;
  const auto = path.join(DATA, 'backups', made);
  assert.equal(msgs(auto, dave), 0);
  assert.equal(msgs(auto, bob), 3);
  r = await owner('POST', `/api/admin/backups/${made}/check`, {});
  assert.equal(r.check.ok, true, JSON.stringify(r));

  console.log('- backups taken before the passcode was turned on lose that history too');
  const frank = await newUser('frank');
  {
    const live = new DatabaseSync(DBF);
    live.exec('PRAGMA busy_timeout = 5000');
    const t = Date.now();
    const acc = Number(live.prepare("INSERT INTO tele_accounts (user_id, display_name, status, created_at, updated_at) VALUES (?, 'Frank TG', 'disconnected', ?, ?)").run(frank.id, t, t).lastInsertRowid);
    const dlg = Number(live.prepare("INSERT INTO tele_dialogs (account_id, tg_chat_id, title, last_text, created_at, updated_at) VALUES (?, '778', 'Frank TG chat', 'frank preview', ?, ?)").run(acc, t, t).lastInsertRowid);
    for (let i = 1; i <= 3; i++) live.prepare('INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(acc, dlg, i, `Frank TG secret ${i}`, t);
    live.close();
  }
  const before = (await owner('POST', '/api/admin/backups')).name;
  const beforeFile = path.join(DATA, 'backups', before);
  const secret = Buffer.from('Frank TG secret');
  assert.equal(msgs(beforeFile, frank), 3, 'no passcode yet: the history is in the backup');
  // What deploy/panel-update.sh keeps of the database when restoring: never redacted when written.
  const keep = path.join(DATA, 'backups', 'before-restore-20000101000000.db');
  fs.copyFileSync(beforeFile, keep);
  assert.equal((await frank.call('POST', '/api/tele/passcode', { password: PASS, passcode: 'frank-pc' })).http, 200);
  // Download right away: redacted on the way out whether or not the background pass is done.
  const got = await owner('GET', `/api/admin/backups/${before}`, undefined, null, { binary: true });
  assert.equal(got.http, 200);
  assert.ok(!got.body.includes(secret), 'the downloaded file has no trace of it');
  const gotFile = path.join(DATA, 'download-test.db');
  fs.writeFileSync(gotFile, got.body);
  assert.equal(msgs(gotFile, frank), 0);
  assert.equal(msgs(gotFile, bob), 3, 'others keep theirs');
  fs.rmSync(gotFile, { force: true });
  // The files on disk are redacted in the background soon after, in name order: before-restore-*
  // comes last, so once it is clean (and its journal gone) the pass is over.
  const clean = () => [beforeFile, keep].every((f) => fs.existsSync(f) && !fs.existsSync(`${f}-journal`) && !fs.readFileSync(f).includes(secret));
  for (let i = 0; i < 60 && !clean(); i++) await new Promise((res) => setTimeout(res, 500));
  assert.ok(clean(), 'backups on disk redacted after the passcode was turned on');
  assert.equal(msgs(beforeFile, bob), 3);
  r = await owner('POST', `/api/admin/backups/${before}/check`, {});
  assert.equal(r.check.ok, true, JSON.stringify(r));
  fs.rmSync(keep, { force: true, maxRetries: 20, retryDelay: 250 });
}

console.log('- forgot: only by disconnecting Telegram, with the account password and a confirm');
assert.equal((await dave3('POST', '/api/tele/passcode/forgot', { password: davePass })).http, 400, 'no confirm');
assert.equal((await dave3('POST', '/api/tele/passcode/forgot', { password: PASS, confirm: true })).http, 400, 'wrong password');
assert.equal((await dave3('GET', '/api/tele/passcode')).enabled, true);
r = await dave3('POST', '/api/tele/passcode/forgot', { password: davePass, confirm: true });
assert.deepEqual([r.http, r.enabled], [200, false], JSON.stringify(r));
assert.notEqual((await dave3('GET', '/api/tele/sessions')).http, 423);
assert.ok(!(await dave3('GET', '/api/tele/status')).locked);
if (DBF) {
  const d = new DatabaseSync(DBF, { readOnly: true });
  const n = (u) => d.prepare('SELECT COUNT(*) AS n FROM tele_messages m JOIN tele_accounts a ON a.id = m.account_id WHERE a.user_id = ?').get(u.id).n;
  assert.equal(n(dave), 0);
  assert.equal(n(bob), 3);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tele_passcodes WHERE user_id = ?').get(dave.id).n, 0);
  assert.equal(d.prepare('SELECT status FROM tele_accounts WHERE user_id = ?').get(dave.id).status, 'disconnected');
  d.close();
}
assert.equal((await dave3('POST', '/api/tele/passcode/forgot', { password: davePass, confirm: true })).http, 400, 'nothing left to forget');

console.log('- backups: owner only, bad names and a wrong password are refused');
const backup = (await owner('POST', '/api/admin/backups')).name;
r = await alice.call('POST', `/api/admin/backups/${backup}/check`);
assert.equal(r.http, 403);
r = await owner('POST', `/api/admin/backups/${backup}/check`, {});
assert.equal(r.check.ok, true, JSON.stringify(r));
assert.ok(r.check.users >= 4);
r = await owner('POST', '/api/admin/backups/evil.db/check', {});
assert.equal(r.http, 400);
r = await alice.call('POST', `/api/admin/backups/${backup}/restore`, { password: PASS });
assert.equal(r.http, 403);
r = await owner('POST', `/api/admin/backups/${backup}/restore`, { password: 'wrong' });
assert.equal(r.http, 403);
if (DATA) {
  console.log('- restore from the panel: the Telegram passcodes of now are kept for the restored database');
  // The swap itself is deploy/panel-update.sh's (root, app stopped) and the putting back is the
  // next start's: both in server/test/passcode-carry.test.mjs and recovery-e2e.sh. Here: the route.
  const carry = path.join(DATA, 'tele-passcodes.carry.json');
  assert.ok(fs.existsSync(path.join(DATA, 'update', 'host.json')));
  r = await owner('POST', `/api/admin/backups/${backup}/restore`, { password: PASS });
  assert.deepEqual([r.http, r.ok], [200, true], JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(DATA, 'update', 'request'), 'utf8').trim(), 'restore');
  const kept = JSON.parse(fs.readFileSync(carry, 'utf8')).rows;
  assert.ok(kept.some((x) => x.user_id === erin.id && x.hash.startsWith('scrypt$') && x.locked_until > Date.now()), 'with the wait after the wrong tries');
  assert.ok(!kept.some((x) => x.user_id === dave.id), 'one removed since is not brought back');
  assert.deepEqual(Object.keys(kept[0]).sort(), ['fails', 'hash', 'idle_min', 'locked_until', 'updated_at', 'user_id']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(carry).mode & 0o777, 0o600);
  for (const f of [carry, path.join(DATA, 'update', 'request'), path.join(DATA, 'update', 'restore-name')]) fs.rmSync(f, { force: true });

  fs.rmSync(path.join(DATA, 'update', 'host.json'), { force: true });
  r = await owner('POST', `/api/admin/backups/${backup}/restore`, { password: PASS });
  assert.equal(r.http, 400, 'without the helper on the server it says so');
  // A damaged backup says it is damaged, and is not restored.
  const damaged = path.join(DATA, 'backups', backup);
  fs.writeFileSync(damaged, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(9000, 7)]));
  r = await owner('POST', `/api/admin/backups/${backup}/check`, {});
  assert.equal(r.check.ok, false);
  assert.equal((await owner('GET', '/api/admin/backups')).files.find((f) => f.name === backup).check.ok, false);
}

console.log('\nTele (local): all checks passed');
