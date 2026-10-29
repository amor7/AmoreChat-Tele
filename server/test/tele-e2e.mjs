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
  server = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], { env: { ...process.env, PORT: String(PORT), TELE_ALERT_CHECK_MS: '1000', TELE_SWEEP_MS: '2000', ...env }, stdio: ['ignore', out, out] });
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
// An unencrypted SQLite file starts with this; TDLib's encrypted database does not.
const PLAIN_SQLITE = 'SQLite format 3\0';
const sqliteHeader = (file) => fs.readFileSync(file).subarray(0, 16).toString('latin1');
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
  const { owner, alice } = await setupApp({ DATA_DIR, TELE_TEST_DC: '1' });

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

  log('The Telegram session on disk is encrypted');
  const sess1 = path.join(DATA_DIR, 'tele-sessions', '1', 'db', 'db.sqlite');
  await until('session database', () => fs.existsSync(sess1), 15000);
  assert.notEqual(sqliteHeader(sess1), PLAIN_SQLITE, 'the Telegram session is stored unencrypted');

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
  const botDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-bot-'));
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
  assert.equal(sqliteHeader(path.join(SESSION_DIR, 'db', 'db.sqlite')), PLAIN_SQLITE, 'the test session should start unencrypted');
  await until('encrypted', () => sqliteHeader(path.join(DATA_DIR, 'tele-sessions', '1', 'db', 'db.sqlite')) !== PLAIN_SQLITE, 15000);

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

  log('Proxy turned off: nothing goes out; stored messages still show');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  await until('tunnel stopped', async () => !(await tunnelRunning(owner)), 20000);
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `must not be sent ${RUN}` });
  assert.ok(r.http >= 400, `sent without a proxy: ${JSON.stringify(r)}`);
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'stored messages');
  assert.ok(r.messages.some((m) => m.text === helloText), 'stored messages are still shown');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('tunnel back', () => tunnelRunning(owner), 30000);
  ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: `back online ${RUN}` }), 'send after proxy back');
  await until('the bot receives it', () => botMsgs.find((m) => textOf(m) === `back online ${RUN}`), 60000);
  assert.ok(!botMsgs.some((m) => textOf(m) === `must not be sent ${RUN}`), 'a message went out without the proxy');
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
    await shot('voice');

    log('UI: a message of the app → Telegram, from its menu');
    const menuText = `from the menu ${RUN}`;
    ok(await alice.call('POST', `/api/chats/${savedChat.id}/messages`, { text: menuText }), 'app message');
    await page.goto(`${BASE}/#/chat/${savedChat.id}`, { waitUntil: 'networkidle0' });
    await waitText('.bubble', menuText);
    const bubble = await page.evaluateHandle((t) => [...document.querySelectorAll('.bubble')].reverse().find((b) => b.textContent.includes(t)), menuText);
    await bubble.click({ button: 'right' });
    await clickText('.menu.floating button', 'ارسال به تلگرام');
    await page.waitForSelector('.modal .user-list input[type=checkbox]');
    await page.evaluate((title) => {
      const row = [...document.querySelectorAll('.modal .user-list label')].find((l) => l.textContent.includes(title));
      row.querySelector('input').click();
    }, pd.title);
    await clickText('.modal button.btn.primary', 'ارسال');
    await until('the bot gets the message from the menu', () => botMsgs.find((m) => textOf(m) === menuText), 30000);

    log('UI: admin panel → Tele / VPN shows alerts and the users');
    await open(owner, '#/', { width: 1280, height: 900 });
    await page.click('.menu-btn');
    await clickText('.sidebar .menu > button', 'پنل مدیریت');
    await clickText('.modal .tabs button', 'Tele / VPN');
    await waitText('.modal h4', 'هشدارها');
    await waitText('.modal .tele-users', 'Alice');
    await shot('admin');
    // Turning voice off for Alice from the panel works.
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.tele-users li')].find((l) => l.textContent.includes('Alice'));
      [...row.querySelectorAll('label.check')].find((l) => l.textContent.includes('صوت')).querySelector('input').click();
    });
    await until('voice turned off from the panel', async () => !ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'alice').allowVoice, 10000);
    const aliceId = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts.find((a) => a.username === 'alice').id;
    ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceId}`, { allowVoice: true }), 'voice back on');

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

let fail = null;
try {
  fs.writeFileSync(LOG, '');
  await part1();
  if (FULL) await part2();
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
