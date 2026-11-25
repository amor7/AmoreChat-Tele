// Regression checks for admin-panel bugs: settings / security / Telegram saves that kept half of a
// refused request, proxy priority 0, unchecked settings, role changes that demoted admins, loose
// limit / ban / restriction / invite / report values, backups in the same second, and no-op
// actions written to the audit log.
// Usage: node test/bugs-admin.mjs <baseUrl> <setupCode> [dataDir]   (fresh, empty DATA_DIR)
// With dataDir (the server's DATA_DIR), the checks that need rows the API can't create (a
// Telegram account, a mirror) or files next to the backups run too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const DATA = process.argv[4];
const PASS = 'Str0ng-Pass-77';

let ipN = 10;
function client(ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0') {
  let cookie = '';
  const ip = `10.0.2.${ipN++}`; // separate per-IP rate-limit buckets
  async function call(method, url, body) {
    const h = { 'x-requested-with': 'amorechat', 'user-agent': ua, 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return { call, ip };
}

async function register(username, extra = {}) {
  const c = client();
  const r = await c.call('POST', '/api/auth/register', { username, password: PASS, displayName: username, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r));
  c.id = r.user.id;
  return c;
}

const owner = await register('owner', { invite: SETUP });
assert.equal((await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' })).status, 200);
const alice = await register('alice');
const bob = await register('bob');
const carol = await register('carol');
const mod = await register('mod');
assert.equal((await owner.call('PATCH', `/api/admin/users/${mod.id}`, { role: 'admin', adminPerms: ['manage_users', 'manage_chats'] })).status, 200);

const settings = async () => (await owner.call('GET', '/api/admin/settings')).settings;
const lastAudit = async () => (await owner.call('GET', '/api/admin/audit')).entries[0]?.id || 0;
// Runs fn and says whether it added audit entries.
async function audited(fn) {
  const before = await lastAudit();
  const r = await fn();
  return { r, audited: (await lastAudit()) > before };
}

// ---- 1, 4, 9: general settings ----
{
  const before = await settings();
  let { r, audited: a } = await audited(() => owner.call('PATCH', '/api/admin/settings', { site_name: 'PARTIAL', allow_user_groups: '0', registration_mode: 'bogus' }));
  assert.equal(r.status, 400);
  assert.equal(a, false, 'refused settings save audited');
  let after = await settings();
  assert.equal(after.site_name, before.site_name, 'site_name saved before the bad key');
  assert.equal(after.allow_user_groups, before.allow_user_groups, 'allow_user_groups saved before the bad key');

  for (const [k, v] of [['deleted_keep_days', 'abc'], ['deleted_keep_days', ''], ['deleted_keep_days', -5], ['deleted_keep_days', null], ['max_upload_mb', ''], ['max_upload_mb', true], ['user_quota_mb', ''], ['media_retention_days', 'x'], ['max_streams_per_room', -1], ['site_name', null], ['site_name', { a: 1 }], ['allow_user_groups', 'yes'], ['discover_list', ''], ['default_can_call', null], ['max_stream_quality', true], ['mirror_files_access', 'all'], ['mirror_files_access', 'garbage']]) {
    r = await owner.call('PATCH', '/api/admin/settings', { [k]: v });
    assert.equal(r.status, 400, `${k}=${JSON.stringify(v)} → ${r.status}`);
  }
  after = await settings();
  for (const k of ['deleted_keep_days', 'max_upload_mb', 'user_quota_mb', 'site_name', 'allow_user_groups', 'discover_list', 'default_can_call', 'mirror_files_access']) {
    assert.equal(after[k], before[k], `${k} changed by a refused save`);
  }
  r = await owner.call('PATCH', '/api/admin/settings', { deleted_keep_days: '7', max_upload_mb: 50, default_can_call: false, discover_list: 'true' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.settings.deleted_keep_days, '7');
  assert.equal(r.settings.max_upload_mb, '50');
  assert.equal(r.settings.default_can_call, '0');
  assert.equal(r.settings.discover_list, '1');
  r = await owner.call('PATCH', '/api/admin/settings', { deleted_keep_days: 0 });
  assert.equal(r.settings.deleted_keep_days, '0', '0 days is a valid value');
  // The panel sends the whole form back, mirror_files_access included unchanged: still fine.
  r = await owner.call('PATCH', '/api/admin/settings', { ...(await settings()), site_name: 'Amore' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.settings.site_name, 'Amore');
  // Nothing changed: no audit line.
  ({ r, audited: a } = await audited(async () => owner.call('PATCH', '/api/admin/settings', await settings())));
  assert.equal(r.status, 200);
  assert.equal(a, false, 'unchanged settings audited');
  assert.equal((await owner.call('PATCH', '/api/admin/settings', [1, 2])).status, 400);
  await owner.call('PATCH', '/api/admin/settings', { max_upload_mb: 100, default_can_call: '1', deleted_keep_days: 30 });
}

// ---- 2: security settings ----
{
  const base = (await owner.call('GET', '/api/admin/security')).settings;
  let { r, audited: a } = await audited(() => owner.call('PATCH', '/api/admin/security', { alerts: !base.alerts, autoBan: !base.autoBan, threshold: 2 }));
  assert.equal(r.status, 400);
  assert.equal(a, false);
  assert.deepEqual((await owner.call('GET', '/api/admin/security')).settings, base, 'security settings half-saved');
  r = await owner.call('PATCH', '/api/admin/security', { autoBan: 'false' });
  assert.equal(r.status, 400, '"false" is not a boolean');
  assert.equal((await owner.call('GET', '/api/admin/security')).settings.autoBan, base.autoBan);
  r = await owner.call('PATCH', '/api/admin/security', { threshold: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.settings.threshold, 7);
  await owner.call('PATCH', '/api/admin/security', base);
}

// ---- 2: Telegram policy / media / alerts ----
const policy = async () => (await owner.call('GET', '/api/admin/tele/policy')).policy;
{
  const base = await policy();
  for (const bad of [{ autoHealth: !base.autoHealth, healthIntervalSec: 120, mode: 'bogus' }, { autoHealth: !base.autoHealth, activeProxyId: 99999 }, { dns: 'not a dns!!', autoHealth: !base.autoHealth }, { healthIntervalSec: 'abc' }, { enabled: 'yes' }]) {
    const { r, audited: a } = await audited(() => owner.call('PATCH', '/api/admin/tele/policy', bad));
    assert.equal(r.status, 400, `policy ${JSON.stringify(bad)} → ${r.status}`);
    assert.equal(a, false);
    assert.deepEqual(await policy(), base, `policy half-saved by ${JSON.stringify(bad)}`);
  }
  const acc = await owner.call('GET', '/api/admin/tele/accounts');
  let { r, audited: a } = await audited(() => owner.call('PATCH', '/api/admin/tele/media', { maxMb: 10, fileMaxMb: 99999 }));
  assert.equal(r.status, 400);
  assert.equal(a, false);
  assert.equal((await owner.call('GET', '/api/admin/tele/accounts')).mediaMaxMb, acc.mediaMaxMb, 'tele media half-saved');
  r = await owner.call('PATCH', '/api/admin/tele/media', { maxMb: 10, fileMaxMb: 30 });
  assert.equal(r.status, 200);
  assert.deepEqual([r.mediaMaxMb, r.fileMaxMb], [10, 30]);

  const al0 = (await owner.call('GET', '/api/admin/tele/alerts')).alerts;
  ({ r, audited: a } = await audited(() => owner.call('PATCH', '/api/admin/tele/alerts', { enabled: !al0.enabled, to: 'nobody' })));
  assert.equal(r.status, 400);
  assert.equal(a, false);
  assert.deepEqual((await owner.call('GET', '/api/admin/tele/alerts')).alerts, al0, 'tele alerts half-saved');
}

// ---- 3: proxy priority 0 ----
{
  let r = await owner.call('POST', '/api/admin/tele/proxies', { link: 'socks5://127.0.0.1:1', name: 'p0', priority: 0 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const id = r.proxy.id;
  assert.equal(r.proxy.priority, 0, 'priority 0 on create');
  r = await owner.call('PATCH', `/api/admin/tele/proxies/${id}`, { priority: 5 });
  assert.equal(r.proxy.priority, 5);
  r = await owner.call('PATCH', `/api/admin/tele/proxies/${id}`, { priority: 0 });
  assert.equal(r.proxy.priority, 0, 'priority 0 on update');
  r = await owner.call('PATCH', `/api/admin/tele/proxies/${id}`, { priority: 'abc' });
  assert.equal(r.status, 400);
  r = await owner.call('POST', '/api/admin/tele/proxies', { link: 'socks5://127.0.0.1:2', name: 'pd' });
  assert.equal(r.proxy.priority, 100, 'left out = 100');
  await owner.call('DELETE', `/api/admin/tele/proxies/${r.proxy.id}`);
  await owner.call('DELETE', `/api/admin/tele/proxies/${id}`);
}

// ---- 5: role changes ----
{
  const users = async () => (await owner.call('GET', '/api/admin/users')).users;
  const role = async (id) => (await users()).find((u) => u.id === id);
  for (const body of [{ role: 'Admin', adminPerms: ['manage_users'] }, { role: 'owner' }, {}, { role: 7 }]) {
    const r = await owner.call('PATCH', `/api/admin/users/${mod.id}`, body);
    assert.equal(r.status, 400, `role ${JSON.stringify(body)} → ${r.status}`);
    assert.equal((await role(mod.id)).role, 'admin', `admin demoted by ${JSON.stringify(body)}`);
  }
  let r = await owner.call('PATCH', `/api/admin/users/${mod.id}`, { adminPerms: ['manage_users', 'manage_chats', 'handle_reports'] });
  assert.equal(r.status, 200);
  const m = await role(mod.id);
  assert.equal(m.role, 'admin', 'adminPerms without role keeps the role');
  assert.deepEqual(m.adminPerms.sort(), ['handle_reports', 'manage_chats', 'manage_users']);
  r = await owner.call('PATCH', `/api/admin/users/${alice.id}`, { adminPerms: ['manage_users'] });
  assert.equal(r.status, 400, 'permissions alone do not make a user an admin');
  assert.equal((await role(alice.id)).role, 'user');
}

// ---- 6: per-user limits ----
{
  for (const body of [{ can_call: '0x' }, { can_call: 'no' }, { upload_mb: 'abc' }, { upload_mb: 0 }, { stream_quality: 999 }, { stream_fps: 45 }, { quota_mb: [5] }, { can_stream: [] }]) {
    const r = await owner.call('PATCH', `/api/admin/users/${alice.id}/limits`, body);
    assert.equal(r.status, 400, `limits ${JSON.stringify(body)} → ${r.status}`);
  }
  let r = await owner.call('PATCH', `/api/admin/users/${alice.id}/limits`, { can_call: '0', can_stream: 'false', upload_mb: '20', stream_quality: '480' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.overrides, { can_call: false, can_stream: false, upload_mb: 20, stream_quality: 480 });
  assert.equal(r.limits.canCall, false, '"0" means no call');
  r = await owner.call('PATCH', `/api/admin/users/${alice.id}/limits`, {});
  assert.deepEqual(r.overrides, {});
}

// ---- 7: ban ----
{
  for (const banned of ['false', 0, 'true', null]) {
    const r = await mod.call('POST', `/api/admin/users/${carol.id}/ban`, { banned });
    assert.equal(r.status, 400, `ban ${JSON.stringify(banned)} → ${r.status}`);
  }
  assert.equal((await carol.call('GET', '/api/auth/me')).status, 200, 'carol banned by a non-boolean');
}

// ---- 8: restrict ----
{
  let r = await mod.call('POST', `/api/admin/users/${bob.id}/restrict`, { send: 5 });
  assert.equal(r.status, 200);
  for (const body of [{ send: 'abc' }, { send: '' }, { send: -1 }, { send: [1] }, { send: true }]) {
    r = await mod.call('POST', `/api/admin/users/${bob.id}/restrict`, body);
    assert.equal(r.status, 400, `restrict ${JSON.stringify(body)} → ${r.status}`);
  }
  const o = await mod.call('GET', `/api/admin/users/${bob.id}/overview`);
  assert.ok(o.restrictions.send, 'a bad value lifted the restriction');
  r = await mod.call('POST', `/api/admin/users/${bob.id}/restrict`, { send: 0 });
  assert.equal(r.status, 200);
  assert.ok(!(await mod.call('GET', `/api/admin/users/${bob.id}/overview`)).restrictions.send, '0 lifts it');
}

// ---- 11: invites ----
{
  for (const body of [{ maxUses: '1.5' }, { maxUses: 1e300 }, { maxUses: -1 }, { expiresInHours: 1e300 }, { expiresInHours: -3 }, { note: { a: 1 } }, { maxUses: 'abc' }]) {
    const r = await owner.call('POST', '/api/admin/invites', body);
    assert.equal(r.status, 400, `invite ${JSON.stringify(body)} → ${r.status}`);
  }
  let r = await owner.call('POST', '/api/admin/invites', { maxUses: '3', expiresInHours: '72', note: ' x ' });
  assert.equal(r.status, 200);
  assert.equal(r.invite.max_uses, 3);
  assert.equal(r.invite.note, 'x');
  r = await owner.call('POST', '/api/admin/invites', { maxUses: '0', expiresInHours: '' });
  assert.equal(r.invite.max_uses, null);
  assert.equal(r.invite.expires_at, null);
  const { r: d, audited: a } = await audited(() => owner.call('DELETE', '/api/admin/invites/999999'));
  assert.equal(d.status, 404);
  assert.equal(a, false, 'deleting a missing invite audited');
  assert.equal((await owner.call('DELETE', `/api/admin/invites/${r.invite.id}`)).status, 200);
}

// ---- 12: reports ----
{
  let r = await alice.call('POST', '/api/chats', { type: 'group', title: 'G', memberIds: [bob.id, carol.id] });
  assert.equal(r.status, 200, JSON.stringify(r));
  const gid = r.chat.id;
  const m = (await bob.call('POST', `/api/chats/${gid}/messages`, { text: 'bad', clientId: 'c1' })).message;
  assert.equal((await carol.call('POST', `/api/messages/${m.id}/report`, { reason: 'spam' })).status, 200);
  const rep = (await owner.call('GET', '/api/admin/reports')).reports[0];
  r = await owner.call('POST', `/api/admin/reports/${rep.id}`, { action: 'bogus' });
  assert.equal(r.status, 400, 'unknown action');
  assert.equal((await owner.call('GET', '/api/admin/reports')).reports.length, 1, 'unknown action closed the report');
  assert.equal((await owner.call('POST', `/api/admin/reports/${rep.id}`, { action: 'dismiss' })).status, 200);
  const { r: again, audited: a } = await audited(() => owner.call('POST', `/api/admin/reports/${rep.id}`, { action: 'delete' }));
  assert.equal(again.status, 409, 'acting on a closed report');
  assert.equal(a, false);
}

// ---- 14: no-op actions ----
{
  for (const body of [{}, { chatId: 'abc' }, { chatId: 999999 }, { callId: 'nope' }, { callId: 5 }]) {
    const { r, audited: a } = await audited(() => mod.call('POST', '/api/admin/live/end', body));
    assert.ok([400, 404].includes(r.status), `live/end ${JSON.stringify(body)} → ${r.status}`);
    assert.equal(a, false, `live/end ${JSON.stringify(body)} audited`);
  }
  const { r, audited: a } = await audited(() => mod.call('DELETE', '/api/admin/security/bans/198.51.100.9'));
  assert.equal(r.status, 404, 'unban of an IP that is not banned');
  assert.equal(a, false);
  assert.equal((await mod.call('POST', '/api/admin/security/bans', { ip: '198.51.100.9' })).status, 200);
  assert.equal((await mod.call('DELETE', '/api/admin/security/bans/198.51.100.9')).status, 200);
}

// ---- 13: two backups in the same second ----
{
  const fakes = [];
  if (DATA) {
    // Old backups (left from before) with SQLite sidecars: rotation must take those too.
    const dir = path.join(DATA, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 16; i++) {
      const f = path.join(dir, `amorechat-2000010100${String(i).padStart(2, '0')}.db`);
      for (const x of [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) fs.writeFileSync(x, '');
      fakes.push(f);
    }
  }
  const [a, b] = await Promise.all([owner.call('POST', '/api/admin/backups', {}), owner.call('POST', '/api/admin/backups', {})]);
  assert.equal(a.status, 200, JSON.stringify(a));
  assert.equal(b.status, 200, JSON.stringify(b));
  const names = (await owner.call('GET', '/api/admin/backups')).files.map((f) => f.name).filter((n) => !n.startsWith('amorechat-20000101'));
  assert.equal(names.length, 2, `two backups at once: ${names.join(', ')}`);
  for (const n of names) assert.match(n, /^amorechat-\d{14,16}\.db$/);
  if (DATA) {
    // 16 old + 2 new, 14 kept: the 4 oldest go, with their -wal/-shm/-journal.
    for (const f of fakes.slice(0, 4)) for (const x of [f, `${f}-wal`, `${f}-shm`, `${f}-journal`]) assert.ok(!fs.existsSync(x), `left after rotation: ${x}`);
    assert.ok(fs.existsSync(fakes[4]));
  }
}

// ---- 2: Telegram account and mirror (rows made directly in the database) ----
if (DATA) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(DATA, 'amorechat.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const ch = await owner.call('POST', '/api/chats', { type: 'channel', title: 'MirrorCh' });
  db.prepare("INSERT INTO tele_accounts (user_id, status, created_at, updated_at) VALUES (?, 'connected', 1, 1)").run(owner.id);
  const acc = db.prepare('SELECT * FROM tele_accounts WHERE user_id = ?').get(owner.id);
  let { r, audited: a } = await audited(() => owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { allowMedia: !acc.allow_media, allowFiles: !acc.allow_files, quotaMb: -5 }));
  assert.equal(r.status, 400);
  assert.equal(a, false);
  const acc2 = db.prepare('SELECT * FROM tele_accounts WHERE id = ?').get(acc.id);
  assert.deepEqual([acc2.allow_media, acc2.allow_files], [acc.allow_media, acc.allow_files], 'tele account half-saved');
  r = await owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { allowMedia: 'yes' });
  assert.equal(r.status, 400);

  db.prepare("INSERT INTO tele_mirrors (account_id, tg_chat_id, title, chat_id, enabled, created_at) VALUES (?, '-100123', 't', ?, 0, 1)").run(acc.id, ch.chat.id);
  const mir = db.prepare('SELECT * FROM tele_mirrors WHERE account_id = ?').get(acc.id);
  ({ r, audited: a } = await audited(() => owner.call('PATCH', `/api/admin/tele/mirrors/${mir.id}`, { withPhotos: !mir.with_photos, enabled: true, visibility: 'bogus' })));
  assert.equal(r.status, 400);
  assert.equal(a, false);
  const mir2 = db.prepare('SELECT * FROM tele_mirrors WHERE id = ?').get(mir.id);
  assert.deepEqual([mir2.enabled, mir2.with_photos], [mir.enabled, mir.with_photos], 'mirror half-saved');
  ({ r, audited: a } = await audited(() => owner.call('PATCH', `/api/admin/tele/mirrors/${mir.id}`, { enabled: true })));
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(a, true, 'mirror switch not audited');
  db.prepare('DELETE FROM tele_mirrors WHERE id = ?').run(mir.id);
  db.prepare('DELETE FROM tele_accounts WHERE id = ?').run(acc.id);
  db.close();
}

console.log(`bugs-admin: all checks passed${DATA ? '' : ' (without dataDir: DB / file checks skipped)'}`);
