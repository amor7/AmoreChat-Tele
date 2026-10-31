// Tele end-to-end test. A local SOCKS5 proxy stands in for the admin's VPN server; the app runs
// sing-box through it and TDLib reaches Telegram only that way.
//  Part 1, Telegram's test servers: tunnel, proxy choice, fail-closed, login up to the code step
//   (the test servers no longer accept logins with generated numbers, so it stops there).
//  Part 2, real Telegram (only with TELE_SESSION_DIR, the spare account's saved session from the
//   tele-login workflow, and TG_TEST_BOT_TOKEN): the bot plays the other side of a private chat
//   and a group — sender names, replies, no double sends, search, removed chats, photos,
//   restart, fail-closed. The spare account is never logged out.
// Usage: TELEGRAM_API_ID=… TELEGRAM_API_HASH=… [TELE_SESSION_DIR=… TG_TEST_PHONE=… TG_TEST_BOT_TOKEN=…]
//        node server/test/tele-e2e.mjs   (sing-box installed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 3110);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'Str0ng-Pass-77';
const LOG = path.resolve(process.env.TELE_LOG || 'tele-server.log');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
assert.ok(API_ID && API_HASH, 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');
const SESSION_DIR = process.env.TELE_SESSION_DIR || '';
const BOT_TOKEN = process.env.TG_TEST_BOT_TOKEN || '';
const FULL = !!(SESSION_DIR && fs.existsSync(path.join(SESSION_DIR, 'meta.json')) && BOT_TOKEN && process.env.TG_TEST_PHONE);
// Unique per run: the real account keeps the messages of earlier runs.
const RUN = Date.now().toString(36);

let step = '';
const t0 = Date.now();
function log(msg) {
  step = msg;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
}
async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ''}`);
    await sleep(1000);
  }
}
// Nothing may hang the job: give up with the step it was on.
setTimeout(() => {
  console.error(`\nFAILED (stuck) at: ${step}`);
  process.exit(1);
}, Number(process.env.TELE_E2E_TIMEOUT_MS || 13 * 60000)).unref();

// ---------- A SOCKS5 proxy (no auth) that counts what goes through it ----------
const socksStats = { connections: 0 };
const sockets = new Set();
const socksHandler = (c) => {
  sockets.add(c);
  c.on('close', () => sockets.delete(c));
  c.on('error', () => {});
  c.once('data', (hello) => {
    if (hello[0] !== 5) return c.destroy();
    c.write(Buffer.from([5, 0]));
    c.once('data', (req) => {
      if (req[1] !== 1) return c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
      let host;
      let i;
      if (req[3] === 1) {
        host = [...req.subarray(4, 8)].join('.');
        i = 8;
      } else if (req[3] === 3) {
        host = req.subarray(5, 5 + req[4]).toString();
        i = 5 + req[4];
      } else if (req[3] === 4) {
        host = req.subarray(4, 20).toString('hex').match(/.{4}/g).join(':');
        i = 20;
      } else return c.destroy();
      const up = net.connect(req.readUInt16BE(i), host, () => {
        socksStats.connections++;
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        up.pipe(c);
        c.pipe(up);
      });
      sockets.add(up);
      up.on('close', () => sockets.delete(up));
      up.on('error', () => c.destroy());
    });
  });
};
const socks = net.createServer(socksHandler);
await new Promise((ok) => socks.listen(0, '127.0.0.1', ok));
const SOCKS_PORT = socks.address().port;

// ---------- The app server (restartable, same data) ----------
let server = null;
let serverEnv = {};
async function startServer(env = serverEnv) {
  serverEnv = env;
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], { env: { ...process.env, PORT: String(PORT), TELE_ALERT_CHECK_MS: '1000', TELE_SWEEP_MS: '2000', TELE_QUEUE_MS: '2000', ...env }, stdio: ['ignore', out, out] });
  await until('server up', async () => (await fetch(`${BASE}/healthz`)).ok, 30000);
}
async function stopServer() {
  const p = server;
  server = null;
  if (!p || p.exitCode != null) return;
  p.kill('SIGTERM');
  await Promise.race([new Promise((ok) => p.once('exit', ok)), sleep(10000).then(() => p.kill('SIGKILL'))]);
}

let ipN = 10;
function client() {
  let cookie = '';
  const ip = `10.0.0.${ipN++}`;
  async function call(method, url, body, { form } = {}) {
    const h = { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip };
    if (cookie) h.cookie = cookie;
    if (body && !form) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: form || (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (/^(image|audio)\//.test(res.headers.get('content-type') || '')) return { http: res.status, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    return { ...(await res.json().catch(() => ({}))), http: res.status };
  }
  return { call, cookie: () => cookie };
}
/** A download as the browser gets it (headers and bytes). */
async function download(who, url) {
  const res = await fetch(BASE + url, { headers: { cookie: who.cookie(), 'x-forwarded-for': '10.9.9.9' } });
  return { http: res.status, type: res.headers.get('content-type') || '', disposition: res.headers.get('content-disposition') || '', nosniff: res.headers.get('x-content-type-options'), bytes: Buffer.from(await res.arrayBuffer()) };
}
const ok = (r, what) => {
  assert.ok(r.http >= 200 && r.http < 300, `${what}: ${r.http} ${r.error || JSON.stringify(r).slice(0, 300)}`);
  return r;
};

/** Fresh app data: owner, Alice and Bob, and the two proxies (dead one first) tested. */
async function setupApp(env) {
  const before = (fs.readFileSync(LOG, 'utf8').match(/SETUP CODE: (\S+)/g) || []).length;
  await startServer(env);
  const setup = await until('setup code', () => {
    const all = fs.readFileSync(LOG, 'utf8').match(/SETUP CODE: (\S+)/g) || [];
    return all.length > before && all.at(-1).split(' ').at(-1);
  }, 15000);
  const owner = client();
  ok(await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: setup }), 'owner register');
  ok(await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' }), 'open registration');
  const alice = client();
  ok(await alice.call('POST', '/api/auth/register', { username: 'alice', password: PASS, displayName: 'Alice' }), 'alice register');
  const bob = client();
  ok(await bob.call('POST', '/api/auth/register', { username: 'bob', password: PASS, displayName: 'Bob' }), 'bob register');
  return { owner, alice, bob };
}
async function addProxies(owner) {
  let r = ok(await owner.call('POST', '/api/admin/tele/proxies', { links: 'socks5://127.0.0.1:1', name: 'dead', priority: 1 }), 'add dead proxy');
  const deadId = r.proxy.id;
  r = ok(await owner.call('POST', '/api/admin/tele/proxies', { form: { type: 'socks5', server: '127.0.0.1', port: SOCKS_PORT }, name: 'local', priority: 5 }), 'add proxy by form');
  const goodId = r.proxy.id;
  assert.ok(!JSON.stringify(r).includes('"config"'), 'proxy config must not be returned');
  ok(await owner.call('PATCH', '/api/admin/tele/policy', { enabled: true, mode: 'priority' }), 'enable');
  r = ok(await owner.call('POST', '/api/admin/tele/proxies/probe-all', {}), 'probe all');
  const byId = Object.fromEntries(r.proxies.map((p) => [p.id, p]));
  assert.equal(byId[goodId].lastStatus, 'healthy', `working proxy: ${byId[goodId].lastError}`);
  assert.equal(byId[deadId].lastStatus, 'unhealthy');
  await until('tunnel on the working proxy', async () => {
    const x = await owner.call('GET', '/api/admin/tele/proxies');
    return x.egress?.running && x.egress.proxyId === goodId;
  });
  return goodId;
}
/** Texts in a user's Saved Messages (where alerts arrive). */
async function savedTexts(who) {
  const saved = ok(await who.call('GET', '/api/chats'), 'chats').chats.find((c) => c.type === 'saved');
  if (!saved) return [];
  return ok(await who.call('GET', `/api/chats/${saved.id}/messages?limit=100`), 'saved').messages.map((m) => m.text || '');
}
const alertsOf = async (who) => (await savedTexts(who)).filter((t) => t.startsWith('⚠️ تلگرام'));
const tunnelRunning = async (owner) => (await owner.call('GET', '/api/admin/tele/proxies')).egress?.running;

// ---------- A PNG photo, made here ----------
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = (seed + x * y) & 255;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const fileForm = (buf, type, name) => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), name);
  return form;
};
const photoForm = (buf, type = 'image/png') => {
  const form = new FormData();
  form.append('file', new Blob([buf], { type }), 'p.png');
  return form;
};

// ===================== Part 1: Telegram's test servers =====================
async function part1() {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-'));
  // Test numbers: 99966 + DC digit + 4 digits. The login itself is refused now, but the steps
  // before it (number accepted, wrong code refused) still run against real Telegram servers.
  const alicePhone = `999662${Math.floor(1000 + Math.random() * 9000)}`;
  log('Part 1 (test servers): server starts; owner, Alice and Bob register');
  const { owner, alice, bob } = await setupApp({ DATA_DIR, TELE_TEST_DC: '1' });

  log('Fail closed: no proxy → no login (and nothing sent directly)');
  let r = await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone });
  assert.equal(r.http, 503, JSON.stringify(r));
  assert.match(r.error, /تونل/);
  r = await alice.call('GET', '/api/tele/status');
  assert.equal(r.account?.status ?? 'disconnected', 'disconnected', 'a failed login must not leave the code step');

  log('A non-admin cannot manage proxies');
  r = await alice.call('GET', '/api/admin/tele/proxies');
  assert.equal(r.http, 403);
  r = await alice.call('POST', '/api/admin/tele/proxies', { links: 'socks5://1.2.3.4:1080' });
  assert.equal(r.http, 403);

  log('Admin adds a dead proxy (priority 1) and a working one (priority 5): the working one is used');
  const goodId = await addProxies(owner);

  log('Users do not see the proxy server or its errors');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.ok(r.runtime.egress.running);
  assert.equal(Object.keys(r.runtime.egress).sort().join(), 'lastError,running');

  log('Alice logs in through the tunnel; a wrong code is refused');
  const before = socksStats.connections;
  r = ok(await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone }), 'alice phone');
  assert.equal(r.status, 'code_required', JSON.stringify(r));
  assert.ok(socksStats.connections > before, 'TDLib must reach Telegram through the proxy');
  r = await alice.call('POST', '/api/tele/login/code', { code: '00000' });
  assert.equal(r.http, 400, JSON.stringify(r));
  r = ok(await alice.call('GET', '/api/tele/status'), 'alice status');
  assert.equal(r.account.status, 'awaiting_code', 'a wrong code keeps the code step');
  assert.ok(!r.account.phone.includes(alicePhone.slice(4, 8)), 'phone must be masked');

  log('The page says how the code was sent; asking for it another way gives a clear answer');
  assert.ok(r.codeInfo?.via, `no code info: ${JSON.stringify(r.codeInfo)}`);
  console.log(`  (code sent: ${r.codeInfo.via}, next: ${r.codeInfo.next}, timeout: ${r.codeInfo.timeout}s)`);
  r = await alice.call('POST', '/api/tele/login/resend', {});
  assert.ok(r.http === 200 || r.http === 400, `resend → ${r.http} ${JSON.stringify(r)}`);
  if (r.http === 200) assert.ok(r.codeInfo?.via, JSON.stringify(r));
  else assert.ok(r.error && !/Internal/i.test(r.error), JSON.stringify(r));
  console.log(`  (resend: ${r.http} ${r.codeInfo?.via || r.error})`);
  r = ok(await alice.call('GET', '/api/tele/status'), 'alice status');
  assert.equal(r.account.status, 'awaiting_code', 'resend left the code step');
  r = await bob.call('POST', '/api/tele/login/resend', {});
  assert.equal(r.http, 400, 'Bob (no login started) asked for a code');

  log('The Telegram session on disk is encrypted');
  // Before login TDLib keeps only its binlog, which holds the phone number in plain text unless encrypted.
  const binlog = path.join(DATA_DIR, 'tele-sessions', '1', 'db', 'td_test.binlog'); // td.binlog on real Telegram
  await until('session binlog', () => fs.existsSync(binlog) && fs.statSync(binlog).size > 0, 15000);
  assert.ok(!fs.readFileSync(binlog).includes(Buffer.from(alicePhone)), 'the Telegram session is stored unencrypted (phone number readable)');

  log('Server restart: a login left at the code step starts over; the tunnel comes back');
  await stopServer();
  await startServer();
  r = ok(await alice.call('GET', '/api/tele/status'), 'status after restart');
  assert.equal(r.account.status, 'disconnected');
  r = await alice.call('POST', '/api/tele/login/code', { code: '11111' });
  assert.equal(r.http, 409, JSON.stringify(r));
  await until('tunnel back after restart', () => tunnelRunning(owner), 30000);

  log('Proxy turned off: the tunnel stops and login is refused (nothing goes out directly)');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  await until('tunnel stopped', async () => !(await tunnelRunning(owner)), 20000);
  r = await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone });
  assert.equal(r.http, 503, JSON.stringify(r));
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.account.status, 'disconnected');
  assert.equal(r.runtime.egress.running, false);

  log('Proxy back: the tunnel and login work again');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('tunnel back', () => tunnelRunning(owner), 30000);
  r = ok(await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone }), 'alice phone again');
  assert.equal(r.status, 'code_required');

  log('Disconnect clears the half-done login');
  ok(await alice.call('POST', '/api/tele/disconnect', {}), 'disconnect');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.ok(!r.account || r.account.status === 'disconnected');

  log('Alerts: only admins see and change them; bad values are refused');
  r = await alice.call('GET', '/api/admin/tele/alerts');
  assert.equal(r.http, 403);
  r = await alice.call('PATCH', '/api/admin/tele/alerts', { enabled: false });
  assert.equal(r.http, 403);
  r = await alice.call('POST', '/api/admin/tele/alerts/test', {});
  assert.equal(r.http, 403);
  for (const bad of [{ events: ['nope'] }, { events: 'down' }, { delayMin: -1 }, { repeatMin: 1.5 }, { delayMin: 99999 }, { to: 'everyone' }]) {
    r = await owner.call('PATCH', '/api/admin/tele/alerts', bad);
    assert.equal(r.http, 400, `accepted ${JSON.stringify(bad)}`);
  }
  r = ok(await owner.call('GET', '/api/admin/tele/alerts'), 'alerts');
  assert.equal(r.alerts.enabled, true, 'alerts are on by default');
  ok(await owner.call('PATCH', '/api/admin/tele/alerts', { delayMin: 0, repeatMin: 0, events: ['down', 'up', 'proxy', 'quota'], to: 'admins' }), 'alert settings');
  r = ok(await owner.call('POST', '/api/admin/tele/alerts/test', {}), 'test alert');
  assert.equal(r.recipients, 1, 'only the owner is an admin here');
  await until('test alert arrives', async () => (await alertsOf(owner)).some((t) => t.includes('🔔')), 10000);

  log('Alerts: a proxy breaks; Telegram goes down and comes back');
  const socks2 = net.createServer(socksHandler);
  await new Promise((done) => socks2.listen(0, '127.0.0.1', done));
  const port2 = socks2.address().port;
  r = ok(await owner.call('POST', '/api/admin/tele/proxies', { form: { type: 'socks5', server: '127.0.0.1', port: port2 }, name: 'second', priority: 50 }), 'add second proxy');
  const secondId = r.proxy.id;
  r = ok(await owner.call('POST', `/api/admin/tele/proxies/${secondId}/probe`, {}), 'probe second');
  assert.equal(r.proxy.lastStatus, 'healthy', r.proxy.lastError);
  socks2.close();
  for (const sk of sockets) if (sk.localPort === port2) sk.destroy();
  r = ok(await owner.call('POST', `/api/admin/tele/proxies/${secondId}/probe`, {}), 'probe second again');
  assert.equal(r.proxy.lastStatus, 'unhealthy');
  await until('proxy alert', async () => (await alertsOf(owner)).some((t) => t.includes('🟠') && t.includes('second')), 10000);
  assert.ok(await tunnelRunning(owner), 'the working proxy still carries Telegram');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  await until('down alert', async () => (await alertsOf(owner)).some((t) => t.includes('🔴')), 20000);
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('back alert', async () => (await alertsOf(owner)).some((t) => t.includes('✅')), 20000);
  assert.equal((await alertsOf(owner)).filter((t) => t.includes('🔴')).length, 1, 'the outage was announced more than once (reminders are off)');
  assert.equal((await alertsOf(alice)).length, 0, 'a user who is not an admin got an alert');

  log('Alerts off: nothing is sent, and no "back" message later');
  ok(await owner.call('PATCH', '/api/admin/tele/alerts', { enabled: false }), 'alerts off');
  const count = (await alertsOf(owner)).length;
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  await until('tunnel stopped', async () => !(await tunnelRunning(owner)), 20000);
  await sleep(4000);
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('tunnel back', () => tunnelRunning(owner), 30000);
  ok(await owner.call('PATCH', '/api/admin/tele/alerts', { enabled: true }), 'alerts on');
  await sleep(4000);
  const after = await alertsOf(owner);
  assert.ok(after.length <= count + 1 && !after.slice(count).some((t) => t.includes('✅')), `alerts while off: ${JSON.stringify(after.slice(count))}`);

  log('Usage caps and permissions: admin only, values checked, partial changes');
  r = await alice.call('GET', '/api/admin/tele/accounts');
  assert.equal(r.http, 403);
  r = await alice.call('PATCH', '/api/admin/tele/quota', { defaultMb: 0 });
  assert.equal(r.http, 403);
  for (const bad of [-1, 1.5, 'x']) {
    r = await owner.call('PATCH', '/api/admin/tele/quota', { defaultMb: bad });
    assert.equal(r.http, 400, `accepted default cap ${bad}`);
  }
  r = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts');
  const acc = r.accounts.find((a) => a.username === 'alice');
  assert.ok(acc && typeof acc.used === 'number', 'alice is listed with her usage');
  r = await alice.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { allowVoice: true });
  assert.equal(r.http, 403);
  for (const bad of [-1, 2.5, 'abc']) {
    r = await owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { quotaMb: bad });
    assert.equal(r.http, 400, `accepted cap ${bad}`);
  }
  r = await owner.call('PATCH', '/api/admin/tele/accounts/99999', { allowVoice: true });
  assert.equal(r.http, 404);
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { allowMedia: true }), 'allow media');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { allowVoice: true, quotaMb: 50 }), 'allow voice + cap');
  r = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.id === acc.id);
  assert.deepEqual([r.allowMedia, r.allowVoice, r.quotaMb, r.effectiveQuotaMb], [true, true, 50, 50], 'one change undid another');
  ok(await owner.call('PATCH', '/api/admin/tele/quota', { defaultMb: 30 }), 'default cap');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${acc.id}`, { quotaMb: null }), 'back to default');
  r = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.id === acc.id);
  assert.deepEqual([r.quotaMb, r.effectiveQuotaMb], [null, 30]);
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  ok(await owner.call('PATCH', '/api/admin/tele/quota', { defaultMb: 0 }), 'no default cap');
  await stopServer();
}

// ===================== Part 2: real Telegram, spare account + bot =====================
let bot = null;
async function part2() {
  const meta = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'meta.json'), 'utf8'));
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-real-'));
  const textOf = (m) => m.content?.text?.text || m.content?.caption?.text || '';

  log('Part 2 (real Telegram): the bot logs in');
  const tdl = await import('tdl');
  const { getTdjson } = await import('prebuilt-tdlib');
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
  // The bot's session is kept with the account's (saved by the workflow): Telegram limits how often
  // a bot may log in, and a fresh login on every run soon has to wait a quarter of an hour.
  const botDir = path.join(path.dirname(SESSION_DIR), 'tele-bot');
  fs.mkdirSync(botDir, { recursive: true, mode: 0o700 });
  bot = tdl.createClient({ apiId: API_ID, apiHash: API_HASH, databaseDirectory: path.join(botDir, 'db'), filesDirectory: path.join(botDir, 'files') });
  bot.on('error', (e) => console.warn('[bot]', e?.message || e));
  const botMsgs = [];
  const sentIds = new Map();
  bot.on('update', (u) => {
    if (u._ === 'updateNewMessage') botMsgs.push(u.message);
    if (u._ === 'updateMessageSendSucceeded') sentIds.set(u.old_message_id, u.message.id);
  });
  await bot.loginAsBot(BOT_TOKEN);
  const botMe = await bot.invoke({ _: 'getMe' });
  const botName = [botMe.first_name, botMe.last_name].filter(Boolean).join(' ');
  const botSend = (chatId, text) => bot.invoke({ _: 'sendMessage', chat_id: chatId, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text } } });
  // Sends and waits for the final id (the first one is temporary).
  const botSendFinal = async (chatId, text) => {
    const m = await botSend(chatId, text);
    return until('bot message confirmed', () => sentIds.get(m.id), 30000);
  };

  log('App with fresh data; proxies');
  const { owner, alice, bob } = await setupApp({ DATA_DIR });
  const goodId = await addProxies(owner);

  log('Alice connects the spare account (its saved session: no code needed)');
  // Account 1's session directory is data/tele-sessions/1: put the saved session there first.
  fs.cpSync(SESSION_DIR, path.join(DATA_DIR, 'tele-sessions', '1'), { recursive: true });
  let r = ok(await alice.call('POST', '/api/tele/login/phone', { phone: process.env.TG_TEST_PHONE }), 'alice connect');
  assert.equal(r.status, 'ready', JSON.stringify(r));
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.account.status, 'connected');
  assert.equal(Number(r.account.tgUserId), meta.userId, 'Telegram user id of the account');
  assert.ok(r.live);

  log('The saved session (from before encryption) is now stored encrypted');
  // An unencrypted binlog has the account's phone number in plain text; once encrypted it is gone.
  const phoneBytes = Buffer.from(String(process.env.TG_TEST_PHONE).replace(/D/g, ''));
  const oldBin = fs.readFileSync(path.join(SESSION_DIR, 'db', 'td.binlog'));
  console.log(`  (the saved, unencrypted session shows the phone number: ${oldBin.includes(phoneBytes)})`);
  const newBinFile = path.join(DATA_DIR, 'tele-sessions', '1', 'db', 'td.binlog');
  await until('session re-encrypted', () => {
    const b = fs.readFileSync(newBinFile);
    return !b.includes(phoneBytes) && !b.equals(oldBin);
  }, 20000);
  {
    const db = new DatabaseSync(path.join(DATA_DIR, 'amorechat.db'), { readOnly: true });
    assert.equal(db.prepare('SELECT db_encrypted FROM tele_accounts WHERE id = 1').get().db_encrypted, 1, 'session not marked encrypted');
    db.close();
  }

  log("Telegram sessions: this app is listed; it can't end itself from here");
  r = ok(await alice.call('GET', '/api/tele/sessions'), 'sessions');
  const curSession = r.sessions.find((x) => x.current);
  assert.ok(curSession, 'this app is not in the session list');
  assert.equal(typeof curSession.ip, 'string');
  r = await alice.call('DELETE', `/api/tele/sessions/${curSession.id}`);
  assert.equal(r.http, 400, 'ended its own session from the list');
  r = await alice.call('DELETE', '/api/tele/sessions/123');
  assert.equal(r.http, 404);
  r = await alice.call('DELETE', '/api/tele/sessions/abc');
  assert.equal(r.http, 400);
  r = await bob.call('GET', '/api/tele/sessions');
  assert.equal(r.http, 400, 'someone without Telegram reads sessions');
  // "End all others" is never run here: the spare account's other devices belong to its owner.

  log('"Add a chat" lists the bot chat and the group; nothing is selected on its own');
  const { pd, gd } = await until('bot chat and group in the list', async () => {
    const x = ok(await alice.call('POST', '/api/tele/dialogs/refresh', { all: true }), 'refresh all');
    const p = x.dialogs.find((d) => Number(d.tgChatId) === meta.botChatId);
    const g = x.dialogs.find((d) => Number(d.tgChatId) === meta.groupChatId);
    return p && g && { pd: p, gd: g };
  });
  assert.equal(pd.kind, 'private');
  assert.equal(gd.kind, 'group');
  assert.equal(pd.selected, false);
  assert.equal(gd.selected, false);
  ok(await alice.call('PATCH', `/api/tele/dialogs/${pd.id}`, { selected: true }), 'select bot chat');
  ok(await alice.call('PATCH', `/api/tele/dialogs/${gd.id}`, { selected: true }), 'select group');

  log('Alice writes first (a bot only knows people who wrote to it); the bot receives both');
  const botUser = botMe.usernames?.active_usernames?.[0] || '';
  ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `ping ${RUN}` }), 'ping bot');
  // In groups a bot only sees commands addressed to it (privacy mode).
  ok(await alice.call('POST', `/api/tele/dialogs/${gd.id}/messages`, { text: `/ping@${botUser} ${RUN}` }), 'ping group');
  await until('the bot receives the pings', () => botMsgs.some((m) => textOf(m) === `ping ${RUN}`) && botMsgs.some((m) => textOf(m).startsWith('/ping@') && textOf(m).endsWith(RUN)), 30000);

  log('The bot writes to Alice and in the group; Alice sees the text and the sender');
  const helloText = `hello alice ${RUN}`;
  await botSend(meta.userId, helloText);
  await botSend(meta.groupChatId, `group hello ${RUN}`);
  const findMsg = async (dialog, text, local = false) => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${dialog.id}/messages${local ? '?local=1' : ''}`), 'messages');
    return x.messages.find((m) => m.text === text);
  };
  const hello = await until('bot message at Alice', () => findMsg(pd, helloText));
  assert.equal(hello.direction, 'in');
  assert.equal(hello.senderName, botName);
  const ghello = await until('group message at Alice', () => findMsg(gd, `group hello ${RUN}`));
  assert.equal(ghello.senderName, botName);
  // The open chat's quick check (local=1) sees new messages without going to the network.
  await botSend(meta.userId, `second ${RUN}`);
  await until('new message via the local check', () => findMsg(pd, `second ${RUN}`, true), 30000);

  log('Alice replies: sent once, stored once under its final id, with the quote');
  const replyText = `reply from alice ${RUN}`;
  r = ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: replyText, replyTo: hello.tgMsgId }), 'send reply');
  assert.equal(r.message.replyTo?.tgMsgId, hello.tgMsgId);
  const got = await until('the bot receives the reply', () => botMsgs.find((m) => !m.is_outgoing && textOf(m) === replyText), 30000);
  assert.ok(got.reply_to?._ === 'messageReplyToMessage', 'the bot sees it as a reply');
  const mine = await until('final id stored', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages?local=1`), 'local messages');
    const m = x.messages.filter((y) => y.text === replyText);
    return m.length === 1 && m[0].tgMsgId % 1048576 === 0 && m[0];
  }, 30000);
  assert.equal(mine.replyTo?.text, helloText);
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages again');
  assert.equal(r.messages.filter((m) => m.text === replyText).length, 1, 'message stored twice');
  await sleep(2000);
  assert.equal(botMsgs.filter((m) => textOf(m) === replyText).length, 1, 'message sent twice');
  // Several quick sends: each arrives once, in order.
  for (let i = 1; i <= 3; i++) ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `burst ${i} ${RUN}` }), `burst ${i}`);
  await until('burst arrives', () => [1, 2, 3].every((i) => botMsgs.some((m) => textOf(m) === `burst ${i} ${RUN}`)), 30000);
  r = await until('burst stored once each', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages?local=1`), 'local');
    const b = x.messages.filter((m) => m.text.startsWith('burst ') && m.text.endsWith(RUN));
    return b.length === 3 && b.every((m) => m.tgMsgId % 1048576 === 0) && b;
  }, 30000);
  assert.deepEqual(r.map((m) => m.text), [1, 2, 3].map((i) => `burst ${i} ${RUN}`));
  assert.equal(botMsgs.filter((m) => textOf(m).startsWith('burst ') && textOf(m).endsWith(RUN)).length, 3, 'a burst message was sent twice');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.dialogs.find((d) => d.id === pd.id).lastText, `burst 3 ${RUN}`);

  log('Alice writes in the group');
  ok(await alice.call('POST', `/api/tele/dialogs/${gd.id}/messages`, { text: `alice in group ${RUN}` }), 'group send');
  await until('stored in group', () => findMsg(gd, `alice in group ${RUN}`, true), 30000);

  log('Search the whole history');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/search?q=${encodeURIComponent(`hello alice ${RUN}`)}`), 'search');
  assert.equal(r.messages.length, 1, JSON.stringify(r.messages.map((m) => m.text)));
  r = await alice.call('GET', `/api/tele/dialogs/${pd.id}/search?q=z`);
  assert.equal(r.http, 400);

  log("Others can't reach Alice's chats");
  r = await bob.call('GET', `/api/tele/dialogs/${pd.id}/messages`);
  assert.ok([400, 404].includes(r.http), JSON.stringify(r));
  r = await bob.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: 'x' });
  assert.ok([400, 404].includes(r.http));
  r = await owner.call('GET', `/api/tele/dialogs/${pd.id}/messages`);
  assert.ok([400, 404].includes(r.http), 'even the admin must not read a user\'s Telegram chats');

  log('A removed chat stays removed');
  ok(await alice.call('PATCH', `/api/tele/dialogs/${gd.id}`, { selected: false }), 'deselect group');
  await botSend(meta.groupChatId, `in removed chat ${RUN}`);
  await sleep(3000);
  for (const all of [false, true]) {
    r = ok(await alice.call('POST', '/api/tele/dialogs/refresh', { all }), 'refresh');
    assert.equal(r.dialogs.find((d) => d.id === gd.id).selected, false, `group came back (all=${all})`);
  }

  log('Photos: off by default, then on for Alice only');
  const pngFile = path.join(botDir, 'bot.png');
  fs.writeFileSync(pngFile, png(320, 240, 90));
  await bot.invoke({ _: 'sendMessage', chat_id: meta.userId, input_message_content: { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: pngFile }, width: 320, height: 240 }, caption: { _: 'formattedText', text: `photo ${RUN}` } } });
  const photoMsg = await until('photo at Alice', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages');
    return x.messages.find((m) => m.photo && m.text.includes(`photo ${RUN}`));
  }, 60000);
  assert.ok(photoMsg.photo.w > 0);
  r = await alice.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.equal(r.http, 403, 'photo loaded before the admin allowed it');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo`, null, { form: photoForm(png(64, 64, 3)) });
  assert.equal(r.http, 403, 'photo sent before the admin allowed it');
  const accounts = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts;
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${accounts.find((a) => a.username === 'alice').id}`, { allowMedia: true }), 'allow media');
  r = await alice.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.equal(r.http, 200, JSON.stringify(r).slice(0, 300));
  assert.ok(r.bytes.length > 1000 && /^image\//.test(r.type), `photo: ${r.bytes?.length} bytes, ${r.type}`);
  r = await bob.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.ok([403, 404].includes(r.http));

  log('Alice sends a photo; not-a-photo is refused');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo?caption=${encodeURIComponent(`from alice ${RUN}`)}`, null, { form: photoForm(png(200, 200, 200)) });
  assert.equal(r.http, 201, JSON.stringify(r));
  await until('the bot receives the photo', () => botMsgs.find((m) => m.content?._ === 'messagePhoto' && textOf(m) === `from alice ${RUN}`), 60000);
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo`, null, { form: photoForm(Buffer.from('not an image'), 'text/plain') });
  assert.equal(r.http, 400);

  log('Voice: off by default, then on for Alice only');
  const oggFile = path.join(botDir, 'voice.ogg');
  const webmFile = path.join(botDir, 'rec.webm');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libopus', '-b:a', '24k', oggFile]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'libopus', '-b:a', '24k', webmFile]);
  await bot.invoke({
    _: 'sendMessage', chat_id: meta.userId,
    input_message_content: { _: 'inputMessageVoiceNote', voice_note: { _: 'inputVoiceNote', voice_note: { _: 'inputFileLocal', path: oggFile }, duration: 2, waveform: '' }, caption: { _: 'formattedText', text: `voice ${RUN}` } },
  });
  const voiceMsg = await until('voice at Alice', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages');
    return x.messages.find((m) => m.voice && m.text.includes(`voice ${RUN}`));
  }, 60000);
  assert.equal(voiceMsg.kind, 'voice');
  assert.equal(voiceMsg.voice.duration, 2);
  r = await alice.call('GET', `/api/tele/messages/${voiceMsg.id}/voice`);
  assert.equal(r.http, 403, 'voice loaded before the admin allowed it');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/voice?duration=2`, null, { form: fileForm(fs.readFileSync(webmFile), 'audio/webm', 'rec.webm') });
  assert.equal(r.http, 403, 'voice sent before the admin allowed it');
  const aliceAcc = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'alice');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { allowVoice: true }), 'allow voice');
  r = await alice.call('GET', `/api/tele/messages/${voiceMsg.id}/voice`);
  assert.equal(r.http, 200, JSON.stringify(r).slice(0, 300));
  assert.equal(r.type, 'audio/mp4', 'voice is converted for iPhones');
  assert.ok(r.bytes.length > 500);
  r = await bob.call('GET', `/api/tele/messages/${voiceMsg.id}/voice`);
  assert.ok([403, 404].includes(r.http));
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/voice?duration=2&caption=${encodeURIComponent(`my voice ${RUN}`)}`, null, { form: fileForm(fs.readFileSync(webmFile), 'audio/webm', 'rec.webm') });
  assert.equal(r.http, 201, JSON.stringify(r));
  assert.equal(r.message.kind, 'voice');
  const gotVoice = await until('the bot receives the voice', () => botMsgs.find((m) => m.content?._ === 'messageVoiceNote' && textOf(m) === `my voice ${RUN}`), 60000);
  assert.ok(gotVoice.content.voice_note.duration >= 1, 'voice without a length');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/voice`, null, { form: fileForm(Buffer.from('not audio'), 'text/plain', 'x.txt') });
  assert.equal(r.http, 400);

  log('Forward Telegram messages into the app: text, photo, voice');
  const savedChat = ok(await alice.call('GET', '/api/chats'), 'chats').chats.find((c) => c.type === 'saved');
  const savedMsgs = async () => ok(await alice.call('GET', `/api/chats/${savedChat.id}/messages?limit=100`), 'saved').messages;
  r = ok(await alice.call('POST', `/api/tele/messages/${hello.id}/forward`, { chatIds: [savedChat.id] }), 'forward text');
  assert.deepEqual(r.sent, [savedChat.id]);
  let fm = (await savedMsgs()).find((m) => m.text === helloText);
  assert.ok(fm, 'forwarded text not in the chat');
  assert.match(fm.forwardedFrom || '', /^تلگرام · /);
  ok(await alice.call('POST', `/api/tele/messages/${photoMsg.id}/forward`, { chatIds: [savedChat.id] }), 'forward photo');
  fm = (await savedMsgs()).find((m) => m.text === `photo ${RUN}`);
  assert.equal(fm?.type, 'image', 'the photo did not come along');
  ok(await alice.call('POST', `/api/tele/messages/${voiceMsg.id}/forward`, { chatIds: [savedChat.id] }), 'forward voice');
  fm = (await savedMsgs()).find((m) => m.text === `voice ${RUN}`);
  assert.equal(fm?.type, 'voice', 'the voice did not come along');
  r = await alice.call('POST', `/api/tele/messages/${hello.id}/forward`, { chatIds: [999999] });
  assert.equal(r.http, 400, 'forwarded into a chat Alice is not in');
  r = await alice.call('POST', `/api/tele/messages/${hello.id}/forward`, { chatIds: [] });
  assert.equal(r.http, 400);
  const bobSaved = ok(await bob.call('GET', '/api/chats'), 'chats').chats.find((c) => c.type === 'saved');
  r = await bob.call('POST', `/api/tele/messages/${hello.id}/forward`, { chatIds: [bobSaved.id] });
  assert.equal(r.http, 404, "Bob forwarded Alice's Telegram message");

  log('Send messages of the app to Telegram: text and photo');
  const appText = `from the app ${RUN}`;
  const appMsg = ok(await alice.call('POST', `/api/chats/${savedChat.id}/messages`, { text: appText }), 'app message').message;
  r = ok(await alice.call('POST', '/api/tele/forward', { messageId: appMsg.id, dialogIds: [pd.id] }), 'to telegram');
  assert.deepEqual(r.sent, [pd.id]);
  await until('the bot gets the app text', () => botMsgs.find((m) => textOf(m) === appText), 30000);
  const up = await alice.call('POST', '/api/upload', null, { form: fileForm(png(120, 90, 7), 'image/png', 'a.png') });
  assert.equal(up.http, 201, JSON.stringify(up));
  const appPhoto = ok(await alice.call('POST', `/api/chats/${savedChat.id}/messages`, { fileId: up.file.id, type: 'image', text: `app photo ${RUN}` }), 'app photo').message;
  ok(await alice.call('POST', '/api/tele/forward', { messageId: appPhoto.id, dialogIds: [pd.id] }), 'photo to telegram');
  await until('the bot gets the photo', () => botMsgs.find((m) => m.content?._ === 'messagePhoto' && textOf(m) === `app photo ${RUN}`), 60000);
  r = await bob.call('POST', '/api/tele/forward', { messageId: appMsg.id, dialogIds: [pd.id] });
  assert.ok([400, 403, 404].includes(r.http), "Bob sent Alice's message");
  r = await alice.call('POST', '/api/tele/forward', { messageId: appMsg.id, dialogIds: [99999] });
  assert.equal(r.http, 400);

  log('Usage: counted per month; the heaviest users come first');
  r = await until('usage counted', async () => {
    const x = ok(await alice.call('GET', '/api/tele/status'), 'status');
    return x.usage?.used > 0 && x;
  }, 20000);
  r = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts');
  assert.equal(r.accounts[0].username, 'alice');
  assert.ok(r.accounts[0].used > 0);

  log('Monthly cap reached: stored messages only, nothing sent, the admin is told');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { quotaMb: 1 }), 'cap 1 MB');
  // A test moves far less than any real cap: add the rest of a heavy month directly.
  const db = new DatabaseSync(path.join(DATA_DIR, 'amorechat.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  const month = new Date().toISOString().slice(0, 7);
  db.prepare('INSERT INTO tele_usage (account_id, month, sent, received) VALUES (?, ?, 0, ?) ON CONFLICT(account_id, month) DO UPDATE SET received = received + excluded.received').run(aliceAcc.id, month, 5 * 1048576);
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `over cap ${RUN}` });
  assert.equal(r.http, 429, JSON.stringify(r));
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'stored messages');
  assert.match(r.notice || '', /سقف/);
  assert.ok(r.messages.some((m) => m.text === helloText));
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/search?q=${encodeURIComponent(helloText)}`), 'search over cap');
  assert.equal(r.messages.length, 1, 'search of stored messages over the cap');
  r = ok(await alice.call('POST', '/api/tele/dialogs/refresh', {}), 'refresh over cap');
  assert.match(r.notice || '', /سقف/);
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo`, null, { form: photoForm(png(64, 64, 9)) });
  assert.equal(r.http, 429);
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.ok(r.usage.used >= r.usage.quotaMb * 1048576);
  await until('cap alert to the admin', async () => (await alertsOf(owner)).some((t) => t.includes('📊') && t.includes('Alice')), 20000);
  await until('connection closed over the cap', async () => !(await alice.call('GET', '/api/tele/status')).live, 20000);
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { quotaMb: 0 }), 'no cap for Alice');
  ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `cap lifted ${RUN}` }), 'send after the cap is lifted');
  await until('the bot receives it', () => botMsgs.find((m) => textOf(m) === `cap lifted ${RUN}`), 30000);
  assert.ok(!botMsgs.some((m) => textOf(m) === `over cap ${RUN}`), 'a message went out over the cap');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { quotaMb: null }), 'default cap');
  db.close();

  log('Files and videos: off by default, then on for Alice; downloads are attachments, never run in the page');
  const docFile = path.join(botDir, 'notes.txt');
  fs.writeFileSync(docFile, `file content ${RUN}`);
  const mp4 = path.join(botDir, 'clip.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', mp4]);
  await bot.invoke({ _: 'sendMessage', chat_id: meta.userId, input_message_content: { _: 'inputMessageDocument', document: { _: 'inputDocument', document: { _: 'inputFileLocal', path: docFile } }, caption: { _: 'formattedText', text: `doc ${RUN}` } } });
  await bot.invoke({ _: 'sendMessage', chat_id: meta.userId, input_message_content: { _: 'inputMessageVideo', video: { _: 'inputVideo', video: { _: 'inputFileLocal', path: mp4 }, duration: 2, width: 160, height: 120, supports_streaming: true }, caption: { _: 'formattedText', text: `video ${RUN}` } } });
  const findFile = async (cap) => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages');
    return x.messages.find((m) => m.file && m.text.includes(cap));
  };
  const docMsg = await until('document at Alice', () => findFile(`doc ${RUN}`), 60000);
  const vidMsg = await until('video at Alice', () => findFile(`video ${RUN}`), 60000);
  assert.equal(docMsg.file.name, 'notes.txt');
  assert.ok(vidMsg.file.video, 'video not marked as video');
  r = await download(alice, `/api/tele/messages/${docMsg.id}/file`);
  assert.equal(r.http, 403, 'file loaded before the admin allowed it');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/file`, null, { form: fileForm(Buffer.from('x'), 'text/plain', 'x.txt') });
  assert.equal(r.http, 403, 'file sent before the admin allowed it');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { allowFiles: true }), 'allow files');
  r = await download(alice, `/api/tele/messages/${docMsg.id}/file`);
  assert.equal(r.http, 200);
  assert.match(r.disposition, /^attachment/, 'a file is shown in the page instead of downloaded');
  assert.equal(r.type, 'application/octet-stream');
  assert.equal(r.nosniff, 'nosniff');
  assert.equal(r.bytes.toString(), `file content ${RUN}`);
  r = await download(alice, `/api/tele/messages/${vidMsg.id}/file?inline=1`);
  assert.equal(r.http, 200);
  assert.match(r.type, /^video\/mp4/, 'video not playable in the page');
  assert.ok(r.bytes.length > 1000);
  r = await download(bob, `/api/tele/messages/${docMsg.id}/file`);
  assert.ok([403, 404].includes(r.http), "Bob got Alice's file");
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/file?caption=${encodeURIComponent(`my file ${RUN}`)}`, null, { form: fileForm(Buffer.from(`from alice ${RUN}`), 'text/plain', `alice-${RUN}.txt`) });
  assert.equal(r.http, 201, JSON.stringify(r));
  const gotDoc = await until('the bot receives the file', () => botMsgs.find((m) => m.content?._ === 'messageDocument' && textOf(m) === `my file ${RUN}`), 60000);
  assert.equal(gotDoc.content.document.file_name, `alice-${RUN}.txt`, 'the file lost its name');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/file?caption=${encodeURIComponent(`my video ${RUN}`)}`, null, { form: fileForm(fs.readFileSync(mp4), 'video/mp4', 'clip.mp4') });
  assert.equal(r.http, 201, JSON.stringify(r));
  await until('the bot receives the video', () => botMsgs.find((m) => m.content?._ === 'messageVideo' && textOf(m) === `my video ${RUN}`), 60000);
  ok(await owner.call('PATCH', '/api/admin/tele/media', { fileMaxMb: 1 }), 'file cap 1 MB');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/file`, null, { form: fileForm(Buffer.alloc(2 * 1048576, 1), 'application/octet-stream', 'big.bin') });
  assert.equal(r.http, 413, 'a file over the cap was sent');
  ok(await owner.call('PATCH', '/api/admin/tele/media', { fileMaxMb: 20 }), 'file cap back');
  ok(await alice.call('POST', `/api/tele/messages/${docMsg.id}/forward`, { chatIds: [savedChat.id] }), 'forward file into the app');
  fm = (await savedMsgs()).find((m) => m.type === 'file' && m.file?.name === 'notes.txt');
  assert.ok(fm, 'the forwarded file is not in the chat');
  const upDoc = await alice.call('POST', '/api/upload', null, { form: fileForm(Buffer.from('app doc'), 'text/plain', `app-${RUN}.txt`) });
  const appDoc = ok(await alice.call('POST', `/api/chats/${savedChat.id}/messages`, { fileId: upDoc.file.id, type: 'file', text: `app doc ${RUN}` }), 'app doc').message;
  ok(await alice.call('POST', '/api/tele/forward', { messageId: appDoc.id, dialogIds: [pd.id] }), 'app file to Telegram');
  const gotAppDoc = await until('the bot gets the app file', () => botMsgs.find((m) => m.content?._ === 'messageDocument' && textOf(m) === `app doc ${RUN}`), 60000);
  assert.equal(gotAppDoc.content.document.file_name, `app-${RUN}.txt`);

  log('Edited and deleted in Telegram: the same here');
  const editId = await botSendFinal(meta.userId, `to edit ${RUN}`);
  const delId = await botSendFinal(meta.userId, `to delete ${RUN}`);
  await until('both arrive', async () => (await findMsg(pd, `to edit ${RUN}`, true)) && findMsg(pd, `to delete ${RUN}`, true), 30000);
  await bot.invoke({ _: 'editMessageText', chat_id: meta.userId, message_id: editId, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: `edited ${RUN}` } } });
  await bot.invoke({ _: 'deleteMessages', chat_id: meta.userId, message_ids: [delId], revoke: true });
  await until('edit shows', () => findMsg(pd, `edited ${RUN}`, true), 30000);
  await until('deleted message is gone', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages?local=1`), 'local');
    return !x.messages.some((m) => m.text === `to delete ${RUN}` || m.text === `to edit ${RUN}`);
  }, 30000);

  await uiChecks({ owner, alice, bob, pd, gd, meta, photoMsg, voiceMsg, savedChat, helloText, botSend, botMsgs, textOf });

  log('Server restart: the account reconnects from its saved session');
  await stopServer();
  await startServer();
  await until('tunnel back after restart', () => tunnelRunning(owner), 30000);
  r = ok(await alice.call('GET', '/api/tele/status'), 'status after restart');
  assert.equal(r.account.status, 'connected');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages after restart');
  assert.ok(!r.notice, `notice after restart: ${r.notice}`);
  ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `after restart ${RUN}` }), 'send after restart');
  await until('the bot receives it', () => botMsgs.find((m) => textOf(m) === `after restart ${RUN}`), 30000);

  log('Tunnel down: messages wait in a queue (nothing goes out) and go in order once it is back');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  await until('tunnel stopped', async () => !(await tunnelRunning(owner)), 20000);
  const queued = [];
  for (const t of [`queued one ${RUN}`, `queued two ${RUN}`, `queued cancel ${RUN}`]) {
    r = ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: t }), 'send while down');
    assert.equal(r.message.kind, 'queued', `not queued: ${JSON.stringify(r.message)}`);
    assert.equal(r.message.tgMsgId, null);
    queued.push(r.message);
  }
  ok(await alice.call('DELETE', `/api/tele/messages/${queued[2].id}`), 'take back a queued message');
  r = await alice.call('DELETE', `/api/tele/messages/${hello.id}`);
  assert.equal(r.http, 400, 'a sent message was taken back');
  r = await bob.call('DELETE', `/api/tele/messages/${queued[0].id}`);
  assert.equal(r.http, 404, "Bob took back Alice's message");
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'stored messages while down');
  assert.ok(r.messages.some((m) => m.text === helloText), 'stored messages are still shown');
  assert.deepEqual(r.messages.slice(-2).map((m) => [m.text, m.kind]), [[`queued one ${RUN}`, 'queued'], [`queued two ${RUN}`, 'queued']], 'queued messages are not last, in order');
  assert.ok(!r.messages.some((m) => m.text === `queued cancel ${RUN}`), 'a taken-back message is still shown');
  await sleep(5000);
  assert.ok(!botMsgs.some((m) => textOf(m).startsWith('queued ') && textOf(m).endsWith(RUN)), 'a queued message went out without the proxy');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('tunnel back', () => tunnelRunning(owner), 30000);
  await until('the queue is sent', () => botMsgs.some((m) => textOf(m) === `queued two ${RUN}`), 60000);
  const order = botMsgs.filter((m) => textOf(m).startsWith('queued ') && textOf(m).endsWith(RUN)).map(textOf);
  assert.deepEqual(order, [`queued one ${RUN}`, `queued two ${RUN}`], 'queue sent twice, out of order or with the taken-back one');
  await until('queued messages got their Telegram ids', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages?local=1`), 'local');
    const q = x.messages.filter((m) => m.text.startsWith('queued ') && m.text.endsWith(RUN));
    return q.length === 2 && q.every((m) => m.kind === 'text' && m.tgMsgId % 1048576 === 0);
  }, 30000);

  log('Messaging anyone and joining chats needs the admin permission');
  const findQ = (q) => alice.call('GET', `/api/tele/find?q=${encodeURIComponent(q)}`);
  r = await findQ(`@${botUser}`);
  assert.equal(r.http, 403, JSON.stringify(r));
  r = await bob.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { allowExplore: true });
  assert.equal(r.http, 403, 'a non-admin gave the permission');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { allowExplore: true }), 'allow explore');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.account.allowExplore, true);

  log('The bot by @username: found, and opening it gives the chat Alice already has');
  r = ok(await findQ(`@${botUser}`), 'find bot');
  const foundBot = r.results.find((c) => Number(c.tgChatId) === meta.botChatId);
  assert.ok(foundBot && foundBot.bot && foundBot.kind === 'private', JSON.stringify(r.results));
  r = ok(await alice.call('POST', '/api/tele/open', { tgChatId: foundBot.tgChatId }), 'open bot');
  assert.equal(r.dialogId, pd.id);

  log('A public channel by t.me link: join it, then leave it (in Telegram too)');
  r = ok(await findQ('https://t.me/telegram'), 'find channel');
  const pub = r.results.find((c) => c.username.toLowerCase() === 'telegram');
  assert.ok(pub && pub.kind === 'channel' && pub.memberCount > 1000, JSON.stringify(r.results));
  const wasMember = pub.joined;
  r = ok(await alice.call('POST', '/api/tele/join', { tgChatId: pub.tgChatId }), 'join');
  const pubDialog = r.dialogs.find((d) => d.id === r.dialogId);
  assert.ok(pubDialog?.selected && pubDialog.kind === 'channel', JSON.stringify(pubDialog));
  r = ok(await findQ('@telegram'), 'find again');
  assert.ok(r.results.find((c) => c.tgChatId === pub.tgChatId)?.joined, 'not a member after joining');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pubDialog.id}/messages`), 'read the channel');
  assert.ok(r.messages.length > 0, 'no posts in the joined channel');
  if (!wasMember) {
    r = ok(await alice.call('POST', `/api/tele/dialogs/${pubDialog.id}/leave`, {}), 'leave');
    assert.ok(!r.dialogs.find((d) => d.id === pubDialog.id)?.selected, 'still in the list after leaving');
    r = ok(await findQ('@telegram'), 'find after leaving');
    assert.equal(r.results.find((c) => c.tgChatId === pub.tgChatId)?.joined, false, 'still a member after leaving');
  } else console.log('  (the spare account already follows @telegram: it is not left)');

  log('Search and join refuse bad input with clear errors');
  for (const [q, code] of [['x', 400], ['https://t.me/+AAAAAAAAAAAAAAAAAAAA', 404]]) {
    r = await findQ(q);
    assert.equal(r.http, code, `${q}: ${JSON.stringify(r)}`);
  }
  for (const body of [{ tgChatId: 'abc' }, { tgChatId: '1' }, { invite: 'nope' }]) {
    r = await alice.call('POST', body.invite ? '/api/tele/join' : '/api/tele/open', body);
    assert.ok(r.http >= 400 && r.http < 500, `${JSON.stringify(body)} → ${r.http}`);
  }
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/leave`, {});
  assert.equal(r.http, 400, 'left a private chat');
  r = await bob.call('GET', '/api/tele/find?q=@telegram');
  assert.equal(r.http, 400, 'Bob (no Telegram) searched');

  log('The admin closes Telegram for Alice: her connection closes; reopened, it works with no new login');
  ok(await owner.call('PATCH', '/api/admin/tele/access', { mode: 'deny', add: [aliceAcc.userId] }), 'close for alice');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.access, false);
  r = await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`);
  assert.equal(r.http, 403);
  r = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts');
  assert.equal(r.accounts.find((a) => a.username === 'alice').live, false, 'still connected to Telegram');
  ok(await owner.call('PATCH', '/api/admin/tele/access', { mode: 'all', remove: [aliceAcc.userId] }), 'open again');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages after reopening');
  assert.ok(r.messages.some((m) => m.text === helloText) && !r.notice, JSON.stringify(r.notice));
  assert.equal(ok(await alice.call('GET', '/api/tele/status'), 'status').account.status, 'connected');

  // Never log out here: the spare account's session is shared with later runs.
  await stopServer();
}

// ---------- The Telegram page in a real browser (desktop, then phone) ----------
async function uiChecks({ owner, alice, bob, pd, gd, meta, photoMsg, voiceMsg, savedChat, helloText, botSend, botMsgs, textOf }) {
  const { default: puppeteer } = await import('puppeteer');
  // A fake microphone, allowed without asking (for recording a voice message).
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const shots = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.warn('  [page error]', e.message));
    const open = async (who, hash, viewport) => {
      await page.setViewport(viewport);
      await page.deleteCookie(...(await page.cookies(BASE)));
      const c = who.cookie();
      const [name, value] = [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)];
      await page.setCookie({ name, value, url: BASE });
      await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle0' });
      // Only the hash may have changed: load the page again as this user.
      await page.reload({ waitUntil: 'networkidle0' });
    };
    // Numbers shown as words of an error ("ناعدد" is NaN in Persian) or missing values.
    const noBrokenText = async (where) => {
      const bad = await page.evaluate(() => (document.body.innerText.match(/ناعدد|\bNaN\b|\bundefined\b|\[object Object\]/) || [])[0]);
      assert.ok(!bad, `${where}: the page shows "${bad}"`);
    };
    const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent));
    const waitText = (sel, text, ms = 20000) => page.waitForFunction((sel, text) => [...document.querySelectorAll(sel)].some((e) => e.textContent.includes(text)), { timeout: ms }, sel, text);
    const countText = (text) => page.$$eval('.tele-chat .msg-row .text', (els, t) => els.filter((e) => e.textContent.trim() === t).length, text);
    const shot = async (name) => {
      const file = `tele-ui-${name}.png`;
      await page.screenshot({ path: file });
      shots.push(file);
    };

    log('UI (desktop): the list shows only the chats Alice added');
    ok(await alice.call('PATCH', `/api/tele/dialogs/${gd.id}`, { selected: true }), 'select group again');
    await open(alice, '#/tele', { width: 1280, height: 800 });
    await waitText('.tele-side .chat-item .title', pd.title);
    await waitText('.tele-side .chat-item .title', gd.title);
    await shot('list');

    log('UI: open the bot chat; messages and sender show');
    await page.click(`a.chat-item[href="#/tele/${pd.id}"]`);
    await waitText('.tele-chat .msg-row .text', helloText);
    assert.equal(await countText(helloText), 1, 'a message shows twice');

    log('UI: send with Enter — arrives once, shows once');
    await page.type('.tele-chat textarea', `ui text ${RUN}`);
    await page.keyboard.press('Enter');
    await until('the bot receives the UI message', () => botMsgs.find((m) => textOf(m) === `ui text ${RUN}`), 30000);
    await sleep(7000); // two rounds of the open chat's check
    assert.equal(await countText(`ui text ${RUN}`), 1, 'the sent message shows twice');
    assert.equal(botMsgs.filter((m) => textOf(m) === `ui text ${RUN}`).length, 1, 'sent twice from the UI');
    assert.equal(await page.$eval('.tele-chat textarea', (t) => t.value), '', 'the text box is not cleared');

    log('UI: reply with the reply button');
    await page.evaluate((t) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.querySelector('.text')?.textContent.trim() === t);
      row.querySelector('.msg-more').click();
    }, helloText);
    await page.waitForSelector('.composer-bar');
    await page.type('.tele-chat textarea', `ui reply ${RUN}`);
    await page.keyboard.press('Enter');
    const rep = await until('the bot receives the UI reply', () => botMsgs.find((m) => textOf(m) === `ui reply ${RUN}`), 30000);
    assert.ok(rep.reply_to, 'the UI reply is not a reply');
    await page.waitForFunction(() => !document.querySelector('.composer-bar'), { timeout: 5000 });
    await waitText('.tele-chat .reply-quote', helloText);

    log('UI: a new message from the bot shows in the open chat by itself');
    await botSend(meta.userId, `live ${RUN}`);
    await waitText('.tele-chat .msg-row .text', `live ${RUN}`, 30000);

    log('UI: the photo loads on tap');
    await page.waitForSelector(`.tele-chat .tele-photo`);
    await page.evaluate((cap) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.textContent.includes(cap) && r.querySelector('.tele-photo'));
      row.querySelector('.tele-photo').click();
    }, `photo ${RUN}`);
    await page.waitForFunction((cap) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.textContent.includes(cap) && r.querySelector('.tele-photo'));
      const img = row?.querySelector('.tele-photo img:not(.blur)');
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 60000 }, `photo ${RUN}`);
    await shot('chat');

    log('UI: search in the chat');
    await page.click('button[aria-label="جستجو در این گفتگو"]');
    await page.type('.tele-search input', `hello alice ${RUN}`);
    await page.keyboard.press('Enter');
    await waitText('.tele-chat .day-sep', 'نتیجه');
    assert.deepEqual(await texts('.tele-chat .msg-row .text'), [helloText]);
    await page.click('button[aria-label="بستن جستجو"]');
    await page.waitForSelector('.tele-chat textarea');

    const clickText = async (sel, text) => {
      await waitText(sel, text);
      await page.evaluate((sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text)).click(), sel, text);
    };

    log('UI: forward a Telegram message into the app');
    const savedCount = async () => ok(await alice.call('GET', `/api/chats/${savedChat.id}/messages?limit=100`), 'saved').messages.filter((m) => m.text === helloText).length;
    const before = await savedCount();
    await page.evaluate((t) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.querySelector('.text')?.textContent.trim() === t);
      row.querySelector('.msg-fwd').click();
    }, helloText);
    await page.waitForSelector('.modal[aria-label="ارسال پیام تلگرام به…"] .user-list input[type=checkbox]');
    await page.click('.modal .user-list input[type=checkbox]');
    await clickText('.modal button.btn.primary', 'ارسال');
    await until('forwarded from the UI', async () => (await savedCount()) === before + 1, 20000);

    log('UI: the voice message plays on tap');
    await page.evaluate((cap) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.textContent.includes(cap) && r.querySelector('.tele-voice'));
      row.querySelector('.tele-voice').click();
    }, `voice ${voiceMsg.text.split('voice ')[1] || ''}`.trim());
    await page.waitForFunction(() => {
      const a = document.querySelector('.tele-chat audio.tele-voice-audio');
      return a && a.readyState >= 1 && a.duration > 1;
    }, { timeout: 60000 });

    log('UI: record and send a voice message');
    const voicesBefore = botMsgs.filter((m) => m.content?._ === 'messageVoiceNote').length;
    await page.click('.tele-chat button[aria-label="ضبط پیام صوتی"]');
    await page.waitForSelector('.tele-recorder');
    await sleep(2500);
    await page.click('.tele-recorder button[aria-label="ارسال پیام صوتی"]');
    const rec = await until('the bot receives the recording', () => botMsgs.filter((m) => m.content?._ === 'messageVoiceNote').length > voicesBefore && botMsgs.filter((m) => m.content?._ === 'messageVoiceNote').at(-1), 60000);
    assert.ok(rec.content.voice_note.duration >= 1, 'recording without a length');
    await page.waitForSelector('.tele-chat textarea');
    await noBrokenText('Telegram chat with voice messages');
    await shot('voice');

    log('UI: a message of the app → Telegram, from its menu');
    const menuText = `from the menu ${RUN}`;
    ok(await alice.call('POST', `/api/chats/${savedChat.id}/messages`, { text: menuText }), 'app message');
    await page.goto(`${BASE}/#/chat/${savedChat.id}`, { waitUntil: 'networkidle0' });
    await waitText('.bubble', menuText);
    // The menu opens on the bubble's contextmenu event (sent to the element itself: the list may
    // re-render between finding it and clicking it).
    await until('message menu open', async () => {
      await page.evaluate((t) => {
        const b = [...document.querySelectorAll('.bubble')].reverse().find((x) => x.textContent.includes(t));
        const r = b.getBoundingClientRect();
        b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
      }, menuText);
      await sleep(300);
      return page.evaluate(() => [...document.querySelectorAll('.menu.floating button')].some((x) => x.textContent.includes('ارسال به تلگرام')));
    }, 15000);
    await clickText('.menu.floating button', 'ارسال به تلگرام');
    await page.waitForSelector('.modal .user-list input[type=checkbox]');
    await page.evaluate((title) => {
      const row = [...document.querySelectorAll('.modal .user-list label')].find((l) => l.textContent.includes(title));
      row.querySelector('input').click();
    }, pd.title);
    await clickText('.modal button.btn.primary', 'ارسال');
    await until('the bot gets the message from the menu', () => botMsgs.find((m) => textOf(m) === menuText), 30000);

    log('UI: admin panel → VPN shows alerts, Telegram shows the users');
    await open(owner, '#/', { width: 1280, height: 900 });
    await page.click('.menu-btn');
    await clickText('.sidebar .menu > button', 'پنل مدیریت');
    await clickText('.modal .tabs button', 'VPN');
    await waitText('.modal h4', 'هشدارها');
    await noBrokenText('admin panel, VPN');
    await shot('admin');
    await page.evaluate(() => document.querySelector('.modal .tele-alerts').scrollIntoView());
    await shot('admin-alerts');
    await clickText('.modal .tabs button', 'تلگرام');
    await waitText('.modal .tele-users', 'Alice');
    await noBrokenText('admin panel, Telegram');
    await page.evaluate(() => document.querySelector('.modal .tele-users').scrollIntoView());
    await shot('admin-users');
    // Turning voice off for Alice from the panel works.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.tele-users li')].find((l) => l.textContent.includes('Alice'));
      [...row.querySelectorAll('label.check')].find((l) => l.textContent.includes('صوت')).querySelector('input').click();
    });
    await until('voice turned off from the panel', async () => !ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'alice').allowVoice, 10000);
    const aliceId = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'alice').id;
    ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceId}`, { allowVoice: true }), 'voice back on');

    log('UI: Telegram sessions open from the page');
    await open(alice, `#/tele/${pd.id}`, { width: 1280, height: 800 });
    await page.click('button[aria-label="نشست‌های فعال تلگرام"]');
    await waitText('.modal .tele-sessions', 'همین برنامه');
    await noBrokenText('Telegram sessions');
    await shot('sessions');
    await clickText('.modal button', 'بستن پنجره');

    log('UI: a video plays on tap, a file downloads');
    await waitText('.tele-chat .tele-file', 'notes.txt');
    await page.evaluate((cap) => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.textContent.includes(cap) && r.querySelector('.tele-file'));
      row.querySelector('.tele-file').click();
    }, `video ${RUN}`);
    await page.waitForFunction(() => {
      const v = document.querySelector('.tele-chat video.tele-video');
      return v && v.readyState >= 1;
    }, { timeout: 60000 });
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.tele-chat .msg-row')].find((r) => r.querySelector('.tele-file')?.textContent.includes('notes.txt'));
      row.querySelector('.tele-file').click();
    });
    await waitText('.tele-chat .tele-file', 'ذخیره شد', 30000);
    await noBrokenText('files');
    await shot('files');

    log('UI: admin panel → Security');
    await open(owner, '#/', { width: 1280, height: 900 });
    await page.click('.menu-btn');
    await clickText('.sidebar .menu > button', 'پنل مدیریت');
    await clickText('.modal .tabs button', 'امنیت');
    await waitText('.modal h4', 'تلاش‌های ناموفق ورود');
    await waitText('.modal h4', 'آی‌پی‌های بن‌شده');
    await noBrokenText('admin panel, Security');
    await shot('security');

    log('UI (phone): list, open chat, back');
    await open(alice, '#/tele', { width: 390, height: 844, isMobile: true, hasTouch: true });
    await waitText('.tele-side .chat-item .title', pd.title);
    await page.click(`a.chat-item[href="#/tele/${pd.id}"]`);
    await waitText('.tele-chat .msg-row .text', helloText);
    const vis = await page.$eval('.tele-chat textarea', (t) => {
      const r = t.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1;
    });
    assert.ok(vis, 'the text box is not on screen on a phone');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `the page scrolls sideways on a phone (${overflow}px)`);
    await shot('phone-chat');
    await page.click('.tele-chat a.back');
    await page.waitForFunction(() => location.hash === '#/tele');
    await waitText('.tele-side .chat-item .title', gd.title);

    log('UI (phone): someone without Telegram sees the login form');
    await open(bob, '#/tele', { width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.waitForSelector('input[inputmode="tel"]', { visible: true, timeout: 15000 });
    await shot('phone-login');
  } catch (e) {
    try {
      const pages = await browser.pages();
      await pages.at(-1)?.screenshot({ path: 'tele-ui-fail.png' });
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}

// ===================== Part 3: a Telegram channel mirrored into the app (owner) =====================
async function part3() {
  const meta = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, 'meta.json'), 'utf8'));
  if (!meta.channelChatId) {
    console.log('\nPart 3 skipped: the saved session has no test channel yet (run the tele-login workflow once more)');
    return;
  }
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-mirror-'));
  const textOf = (m) => m.content?.text?.text || m.content?.caption?.text || '';
  log('Part 3: the owner connects the spare account; the bot posts in its channel');
  const { owner, alice, bob } = await setupApp({ DATA_DIR });
  await addProxies(owner);
  fs.cpSync(SESSION_DIR, path.join(DATA_DIR, 'tele-sessions', '1'), { recursive: true });
  let r = ok(await owner.call('POST', '/api/tele/login/phone', { phone: process.env.TG_TEST_PHONE }), 'owner connect');
  assert.equal(r.status, 'ready');
  r = await until('the channel in the owner\'s list', async () => {
    const x = ok(await owner.call('POST', '/api/tele/dialogs/refresh', { all: true }), 'refresh all');
    return x.dialogs.find((d) => Number(d.tgChatId) === meta.channelChatId);
  });
  assert.equal(r.kind, 'channel');
  // The account made the channel, so it posts there itself (through the app, as a user would).
  const channelDialog = r;
  ok(await owner.call('PATCH', `/api/tele/dialogs/${channelDialog.id}`, { selected: true }), 'add the channel');
  const ownerAcc = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'owner');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${ownerAcc.id}`, { allowMedia: true }), 'photos for the owner');
  const postText = async (t) => ok(await owner.call('POST', `/api/tele/dialogs/${channelDialog.id}/messages`, { text: t }), 'post in the channel');
  const postPhoto = async (buf, caption) => {
    const x = await owner.call('POST', `/api/tele/dialogs/${channelDialog.id}/photo?caption=${encodeURIComponent(caption)}`, null, { form: photoForm(buf) });
    assert.equal(x.http, 201, JSON.stringify(x));
    // A photo gets its place in the channel once uploaded: wait, so the posts keep this order.
    await until('photo posted', async () => {
      const y = ok(await owner.call('GET', `/api/tele/dialogs/${channelDialog.id}/messages?local=1`), 'channel');
      return y.messages.some((m) => m.photo && m.text.includes(caption) && m.tgMsgId % 1048576 === 0);
    }, 60000);
  };

  log('Only the owner manages mirrors; bad requests are refused');
  r = await alice.call('GET', '/api/admin/tele/mirrors');
  assert.equal(r.http, 403);
  r = await alice.call('POST', '/api/admin/tele/mirrors', { tgChatId: String(meta.channelChatId) });
  assert.equal(r.http, 403);
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors'), 'mirrors');
  assert.ok(r.connected, 'not connected');
  r = await alice.call('GET', '/api/admin/tele/mirrors/channels');
  assert.equal(r.http, 403);
  log('The channel list comes live from Telegram (not only chats added in the Telegram page) and can be searched');
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors/channels'), 'channels');
  assert.ok(r.channels.some((c) => Number(c.tgChatId) === meta.channelChatId && c.joined), 'channel not offered');
  r = ok(await owner.call('GET', `/api/admin/tele/mirrors/channels?q=${encodeURIComponent(meta.channelTitle.slice(-6))}`), 'search channels');
  assert.ok(r.channels.some((c) => Number(c.tgChatId) === meta.channelChatId), 'search missed the channel');
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors/channels?q=zzzz-nothing-like-this'), 'search nothing');
  assert.equal(r.channels.length, 0);
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors/channels?q=@telegram'), 'public channel by @name');
  assert.ok(r.channels.some((c) => c.username.toLowerCase() === 'telegram'), JSON.stringify(r.channels.slice(0, 3)));
  for (const bad of [{ tgChatId: 'abc' }, { tgChatId: String(meta.botChatId) }, { tgChatId: String(meta.channelChatId), importLast: 99 }, { tgChatId: String(meta.channelChatId), visibility: 'everyone' }]) {
    r = await owner.call('POST', '/api/admin/tele/mirrors', bad);
    assert.ok(r.http >= 400 && r.http < 500, `mirror ${JSON.stringify(bad)} → ${r.http}`);
  }

  log('The channel is mirrored into a private app channel (invite link only); new posts appear once each');
  r = ok(await owner.call('POST', '/api/admin/tele/mirrors', { tgChatId: String(meta.channelChatId), importLast: 0, withPhotos: true, visibility: 'link' }), 'add mirror');
  const mirror = r.mirror;
  assert.equal(mirror.visibility, 'link');
  assert.match(mirror.inviteCode || '', /^\S{6,}$/, 'no invite link');
  r = await owner.call('POST', '/api/admin/tele/mirrors', { tgChatId: String(meta.channelChatId) });
  assert.equal(r.http, 400, 'the same channel added twice');
  await postText(`news one ${RUN}`);
  await postPhoto(png(200, 150, 33), `news photo ${RUN}`);
  await postText(`news two ${RUN}`);
  const appMsgs = async () => ok(await owner.call('GET', `/api/chats/${mirror.chatId}/messages?limit=100`), 'app channel').messages;
  await until('posts in the app channel', async () => {
    await owner.call('POST', '/api/admin/tele/mirrors/run', {});
    const m = await appMsgs();
    return m.some((x) => x.text === `news two ${RUN}`);
  }, 90000);
  let m = (await appMsgs()).filter((x) => x.type !== 'system');
  assert.deepEqual(m.map((x) => x.text), [`news one ${RUN}`, `news photo ${RUN}`, `news two ${RUN}`], 'posts missing, twice or out of order');
  assert.ok(m.every((x) => x.forwardedFrom === `تلگرام · ${meta.channelTitle}`), 'source not shown');
  ok(await owner.call('POST', '/api/admin/tele/mirrors/run', {}), 'run again');
  assert.equal((await appMsgs()).filter((x) => x.type !== 'system').length, 3, 'posts copied twice');

  log('The photo is not fetched until someone opens it');
  assert.equal(m[1].type, 'text');
  assert.ok(m[1].pendingPhoto && !m[1].file, `photo fetched already: ${JSON.stringify(m[1])}`);
  const usageNow = async () => ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'owner').used;

  log('Link only: not found in "explore", no joining without the link; with the link, anyone joins');
  const discover = async (who) => ok(await who.call('GET', `/api/chats/discover?q=${encodeURIComponent(mirror.chatTitle.slice(-8))}`), 'discover').chats.map((c) => c.id);
  assert.ok(!(await discover(alice)).includes(mirror.chatId), 'a link-only channel is listed');
  r = await alice.call('POST', `/api/chats/${mirror.chatId}/join`, {});
  assert.ok(r.http >= 400, 'joined a link-only channel without the link');
  r = await alice.call('GET', `/api/chats/${mirror.chatId}/messages`);
  assert.equal(r.http, 403, 'read a link-only channel without joining');
  r = await alice.call('POST', `/api/mirror-photos/${m[1].id}`, {});
  assert.equal(r.http, 403, 'a non-member fetched the photo');
  ok(await alice.call('POST', `/api/join/${mirror.inviteCode}`, {}), 'alice joins with the link');
  r = ok(await alice.call('GET', `/api/chats/${mirror.chatId}/messages`), 'alice reads');
  assert.ok(r.messages.some((x) => x.text === `news one ${RUN}`));
  r = await alice.call('POST', `/api/chats/${mirror.chatId}/messages`, { text: 'not allowed' });
  assert.ok(r.http >= 400, 'a member posted in the news channel');

  log('Alice opens the photo: fetched once from Telegram, then an ordinary photo for everyone');
  const [p1, p2] = await Promise.all([alice.call('POST', `/api/mirror-photos/${m[1].id}`, {}), owner.call('POST', `/api/mirror-photos/${m[1].id}`, {})]);
  assert.equal(p1.http, 200, JSON.stringify(p1));
  assert.equal(p2.http, 200, JSON.stringify(p2));
  assert.equal(p1.message.type, 'image');
  assert.equal(p1.message.file.id, p2.message.file.id, 'fetched twice');
  m = (await appMsgs()).filter((x) => x.type !== 'system');
  assert.equal(m[1].type, 'image');
  assert.equal(m[1].text, `news photo ${RUN}`);
  assert.ok(!m[1].pendingPhoto);
  const img = await download(alice, `/api/files/${m[1].file.id}`);
  assert.ok(img.http === 200 && /^image\//.test(img.type) && img.bytes.length > 100, `the photo file: ${img.http} ${img.type} ${img.bytes.length}`);
  r = ok(await alice.call('POST', `/api/mirror-photos/${m[1].id}`, {}), 'opened again');
  assert.equal(r.message.file.id, p1.message.file.id, 'fetched again');
  console.log(`  (owner's Telegram traffic so far this month: ${await usageNow()} bytes)`);

  log('A new invite link: the old one stops working; members stay');
  ok(await owner.call('POST', `/api/admin/tele/mirrors/${mirror.id}/invite`, {}), 'new link');
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors'), 'mirrors');
  const fresh = r.mirrors[0];
  assert.ok(fresh.inviteCode && fresh.inviteCode !== mirror.inviteCode, 'same link');
  r = await bob.call('POST', `/api/join/${mirror.inviteCode}`, {});
  assert.equal(r.http, 404, 'the old link still works');
  assert.equal(fresh.members, 2, 'owner and alice');

  log('"Everyone": every user is a member, and so is a user who registers later');
  r = await alice.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { visibility: 'all' });
  assert.equal(r.http, 403);
  r = await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { visibility: 'nobody' });
  assert.equal(r.http, 400);
  r = ok(await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { visibility: 'all' }), 'everyone');
  assert.equal(r.mirrors[0].visibility, 'all');
  r = ok(await bob.call('GET', '/api/chats'), 'bob chats');
  assert.ok(r.chats.some((c) => c.id === mirror.chatId), 'bob was not added');
  const carol = client();
  ok(await carol.call('POST', '/api/auth/register', { username: 'carol', password: PASS, displayName: 'Carol' }), 'carol register');
  r = ok(await carol.call('GET', '/api/chats'), 'carol chats');
  assert.ok(r.chats.some((c) => c.id === mirror.chatId), 'a new user was not added');
  r = ok(await carol.call('GET', `/api/chats/${mirror.chatId}/messages`), 'carol reads');
  assert.ok(r.messages.some((x) => x.type === 'image' && x.text === `news photo ${RUN}`), 'carol does not see the photo');

  log('"Public": listed in explore; no longer added to new users');
  ok(await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { visibility: 'public' }), 'public');
  const dave = client();
  ok(await dave.call('POST', '/api/auth/register', { username: 'dave', password: PASS, displayName: 'Dave' }), 'dave register');
  assert.ok(!ok(await dave.call('GET', '/api/chats'), 'dave chats').chats.some((c) => c.id === mirror.chatId), 'added while public');
  assert.ok((await discover(dave)).includes(mirror.chatId), 'not listed while public');
  ok(await dave.call('POST', `/api/chats/${mirror.chatId}/join`, {}), 'dave joins from explore');

  log('Videos and files: only noted; fetched only by users the admin allowed, then open to every member');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${ownerAcc.id}`, { allowFiles: true }), 'files for the owner');
  ok(await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { withFiles: true }), 'mirror files');
  r = await owner.call('POST', `/api/tele/dialogs/${channelDialog.id}/file?caption=${encodeURIComponent(`news file ${RUN}`)}`, null, { form: fileForm(Buffer.from(`file body ${RUN}`), 'text/plain', `news-${RUN}.txt`) });
  assert.equal(r.http, 201, JSON.stringify(r));
  const filePost = await until('the file post in the app channel', async () => {
    await owner.call('POST', '/api/admin/tele/mirrors/run', {});
    return (await appMsgs()).find((x) => x.text === `news file ${RUN}`);
  }, 90000);
  assert.ok(filePost.pendingFile && !filePost.file, `file fetched already: ${JSON.stringify(filePost)}`);
  assert.equal(filePost.pendingFile.name, `news-${RUN}.txt`);
  assert.equal(filePost.pendingFile.kind, 'file');
  assert.equal((await alice.call('GET', '/api/auth/me')).user.mirrorFiles, false);
  r = await alice.call('POST', `/api/mirror-media/${filePost.id}`, {});
  assert.equal(r.http, 403, 'fetched without permission');
  r = ok(await owner.call('GET', '/api/admin/access/mirror-files'), 'file access');
  ok(await owner.call('PATCH', '/api/admin/access/mirror-files', { add: [r.users.find((u) => u.username === 'alice').id] }), 'allow alice');
  r = ok(await alice.call('POST', `/api/mirror-media/${filePost.id}`, {}), 'alice fetches the file');
  assert.equal(r.message.type, 'file');
  assert.equal(r.message.file.name, `news-${RUN}.txt`);
  assert.ok(!r.message.pendingFile);
  const doc = await download(dave, `/api/files/${r.message.file.id}?download=1`);
  assert.equal(doc.http, 200, 'another member can not download it');
  assert.equal(doc.bytes.toString(), `file body ${RUN}`);

  log('A Telegram group: its messages appear in an app channel with the name of who wrote them');
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors/channels'), 'channels and groups');
  assert.ok(r.channels.some((c) => Number(c.tgChatId) === meta.groupChatId && c.kind === 'group'), 'group not offered');
  r = ok(await owner.call('POST', '/api/admin/tele/mirrors', { tgChatId: String(meta.groupChatId), importLast: 0, visibility: 'link' }), 'mirror the group');
  const gm = r.mirror;
  assert.equal(gm.kind, 'group');
  const botMe = await bot.invoke({ _: 'getMe' });
  const botName = [botMe.first_name, botMe.last_name].filter(Boolean).join(' ');
  await bot.invoke({ _: 'sendMessage', chat_id: meta.groupChatId, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: `group news ${RUN}` } } });
  const groupPost = await until('the group message in the app channel', async () => {
    await owner.call('POST', '/api/admin/tele/mirrors/run', {});
    const x = ok(await owner.call('GET', `/api/chats/${gm.chatId}/messages?limit=50`), 'group channel');
    return x.messages.find((y) => y.text === `group news ${RUN}`);
  }, 90000);
  assert.equal(groupPost.forwardedFrom, `تلگرام · ${gm.title} · ${botName}`.slice(0, 120), 'the writer is not shown');
  ok(await owner.call('DELETE', `/api/admin/tele/mirrors/${gm.id}`), 'remove the group mirror');

  log('Paused: nothing is copied; resumed: it catches up');
  ok(await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { enabled: false }), 'pause');
  await postText(`news three ${RUN}`);
  await sleep(3000);
  ok(await owner.call('POST', '/api/admin/tele/mirrors/run', {}), 'run while paused');
  assert.ok(!(await appMsgs()).some((x) => x.text === `news three ${RUN}`), 'copied while paused');
  ok(await owner.call('PATCH', `/api/admin/tele/mirrors/${mirror.id}`, { enabled: true }), 'resume');
  await until('caught up', async () => {
    await owner.call('POST', '/api/admin/tele/mirrors/run', {});
    return (await appMsgs()).some((x) => x.text === `news three ${RUN}`);
  }, 60000);
  ok(await owner.call('DELETE', `/api/admin/tele/mirrors/${mirror.id}`), 'remove mirror');
  r = ok(await owner.call('GET', '/api/admin/tele/mirrors'), 'mirrors');
  assert.equal(r.mirrors.length, 0);
  assert.ok((await appMsgs()).length > 0, 'the app channel lost its posts');

  log('Traffic per day: the owner\'s Telegram use shows up for today');
  r = ok(await owner.call('GET', `/api/admin/tele/accounts/${ownerAcc.id}/usage`), 'usage history');
  assert.equal(r.days.length, 30);
  assert.equal(r.months.length, 6);
  assert.ok(r.days.at(-1).bytes > 0, `nothing counted today: ${JSON.stringify(r.days.slice(-2))}`);
  await stopServer();
}

let fail = null;
try {
  fs.writeFileSync(LOG, '');
  await part1();
  if (FULL) {
    await part2();
    await part3();
  }
  else console.log('\nPart 2 (real Telegram) skipped: no saved session yet (run the tele-login workflow), or TG_TEST_* secrets missing');
  console.log(`\nTele e2e: passed${FULL ? ' (both parts)' : ' (part 1)'}`);
} catch (e) {
  fail = e;
  console.error(`\nFAILED at: ${step}\n`, e);
} finally {
  await bot?.close().catch(() => {});
  await stopServer();
  await new Promise((done) => socks.close(done));
  for (const s of sockets) s.destroy();
}
process.exit(fail ? 1 : 0);
