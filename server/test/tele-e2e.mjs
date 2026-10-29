// Tele end-to-end test on Telegram's test servers (separate from real Telegram: numbers 99966XYYYY,
// login code X repeated five times). A local SOCKS5 proxy stands in for the admin's VPN server, the
// app runs sing-box through it, and a helper Telegram account ("Charlie", its own TDLib client)
// plays the other side: private chat, group, replies, photos, search, restart, fail-closed.
// Usage: TELEGRAM_API_ID=… TELEGRAM_API_HASH=… node server/test/tele-e2e.mjs   (sing-box installed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-'));
const PORT = Number(process.env.PORT || 3110);
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'Str0ng-Pass-77';
const LOG = path.resolve(process.env.TELE_LOG || 'tele-server.log');
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const API_ID = Number(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
assert.ok(API_ID && API_HASH, 'TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');

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

// ---------- A SOCKS5 proxy (no auth) that counts what goes through it ----------
const socksStats = { connections: 0 };
const sockets = new Set();
function socksServer() {
  return net.createServer((c) => {
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
        const port = req.readUInt16BE(i);
        const up = net.connect(port, host, () => {
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
  });
}
const socks = socksServer();
await new Promise((ok) => socks.listen(0, '127.0.0.1', ok));
const SOCKS_PORT = socks.address().port;
async function stopSocks() {
  await new Promise((ok) => socks.close(ok));
  for (const s of sockets) s.destroy();
}

// ---------- The app server (restartable, same data) ----------
let server = null;
async function startServer() {
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, [path.join(ROOT, 'server/src/index.js')], {
    env: { ...process.env, DATA_DIR, PORT: String(PORT), TELE_TEST_DC: '1' },
    stdio: ['ignore', out, out],
  });
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
    if (/^image\//.test(res.headers.get('content-type') || '')) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  }
  return { call };
}
const ok = (r, what) => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.error || JSON.stringify(r).slice(0, 300)}`);
  return r;
};

// ---------- A PNG photo, made here ----------
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w;
      raw[o + 1] = (y * 255) / h;
      raw[o + 2] = seed;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
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

// ---------- Charlie: a helper Telegram account with its own TDLib client ----------
const tdl = await import('tdl');
const { getTdjson } = await import('prebuilt-tdlib');
tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
const rand4 = () => String(Math.floor(1000 + Math.random() * 9000));
const DC = 2;
const CODE = String(DC).repeat(5);
const phone = () => `99966${DC}${rand4()}`;
const charliePhone = phone();
const alicePhone = phone();
const bobPhone = phone();

const charlieDir = path.join(DATA_DIR, 'charlie');
const charlie = tdl.createClient({ apiId: API_ID, apiHash: API_HASH, databaseDirectory: path.join(charlieDir, 'db'), filesDirectory: path.join(charlieDir, 'files'), useTestDc: true });
charlie.on('error', (e) => console.warn('[charlie]', e?.message || e));
const charlieMsgs = [];
charlie.on('update', (u) => {
  if (u._ === 'updateNewMessage') charlieMsgs.push(u.message);
  if (u._ === 'updateAuthorizationState') console.log('  [charlie]', u.authorization_state._);
  if (u._ === 'updateConnectionState') console.log('  [charlie]', u.state._);
});
// Nothing may hang the job: give up with the step it was on.
setTimeout(() => {
  console.error(`
FAILED (stuck) at: ${step}`);
  try {
    console.error(fs.readFileSync(LOG, 'utf8').slice(-4000));
  } catch {}
  process.exit(1);
}, Number(process.env.TELE_E2E_TIMEOUT_MS || 13 * 60000)).unref();
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);
const textOf = (m) => m.content?.text?.text || m.content?.caption?.text || '';

let fail = null;
try {
  fs.writeFileSync(LOG, '');

  log('Charlie logs in to the Telegram test servers');
  await within(
    charlie.login(() => ({
      getPhoneNumber: async (retry) => {
        if (retry) throw new Error('phone number refused');
        return charliePhone;
      },
      getAuthCode: async (retry) => {
        if (retry) throw new Error('code refused');
        return CODE;
      },
      getName: async () => ({ firstName: 'Charlie', lastName: 'Helper' }),
      getEmailAddress: async () => {
        throw new Error('the test server asks for an email address');
      },
      confirmOnAnotherDevice: () => {
        throw new Error('the test server asks for a QR login');
      },
    })),
    120000,
    'Charlie login',
  );
  const charlieMe = await charlie.invoke({ _: 'getMe' });

  log('Server starts; owner, Alice and Bob register');
  await startServer();
  const setup = await until('setup code', () => fs.readFileSync(LOG, 'utf8').match(/SETUP CODE: (\S+)/)?.[1], 15000);
  const owner = client();
  ok(await owner.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: setup }), 'owner register');
  ok(await owner.call('PATCH', '/api/admin/settings', { registration_mode: 'open' }), 'open registration');
  const alice = client();
  ok(await alice.call('POST', '/api/auth/register', { username: 'alice', password: PASS, displayName: 'Alice' }), 'alice register');
  const bob = client();
  ok(await bob.call('POST', '/api/auth/register', { username: 'bob', password: PASS, displayName: 'Bob' }), 'bob register');

  log('Fail closed: no proxy → no login (and nothing sent directly)');
  let r = await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone });
  assert.equal(r.status, 503, JSON.stringify(r));
  assert.match(r.error, /تونل/);
  r = await alice.call('GET', '/api/tele/status');
  assert.equal(r.account?.status ?? 'disconnected', 'disconnected', 'a failed login must not leave the code step');

  log('A non-admin cannot manage proxies');
  r = await alice.call('GET', '/api/admin/tele/proxies');
  assert.equal(r.status, 403);

  log('Admin adds a dead proxy (priority 1) and the working one (priority 5), tests them');
  r = ok(await owner.call('POST', '/api/admin/tele/proxies', { links: `socks5://127.0.0.1:1`, name: 'dead', priority: 1 }), 'add dead proxy');
  const deadId = r.proxy.id;
  r = ok(await owner.call('POST', '/api/admin/tele/proxies', { form: { type: 'socks5', server: '127.0.0.1', port: SOCKS_PORT }, name: 'local', priority: 5 }), 'add proxy by form');
  const goodId = r.proxy.id;
  assert.ok(!JSON.stringify(r).includes('"config"'), 'proxy config must not be returned');
  ok(await owner.call('PATCH', '/api/admin/tele/policy', { enabled: true, mode: 'priority' }), 'enable');
  r = ok(await owner.call('POST', '/api/admin/tele/proxies/probe-all', {}), 'probe all');
  const byId = Object.fromEntries(r.proxies.map((p) => [p.id, p]));
  assert.equal(byId[goodId].lastStatus, 'healthy', `working proxy: ${byId[goodId].lastError}`);
  assert.equal(byId[deadId].lastStatus, 'unhealthy');
  r = await until('tunnel on the working proxy', async () => {
    const x = await owner.call('GET', '/api/admin/tele/proxies');
    return x.egress?.running && x.egress.proxyId === goodId && x;
  });

  log('Users do not see the proxy server or its errors');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.ok(r.runtime.egress.running);
  assert.equal(Object.keys(r.runtime.egress).sort().join(), 'lastError,running');

  log('Alice logs in: wrong code, then the right one');
  const viaProxyBefore = socksStats.connections;
  r = ok(await alice.call('POST', '/api/tele/login/phone', { phone: alicePhone }), 'alice phone');
  assert.equal(r.status, 'code_required', JSON.stringify(r));
  assert.ok(socksStats.connections > viaProxyBefore, 'TDLib must reach Telegram through the proxy');
  r = await alice.call('POST', '/api/tele/login/code', { code: '00000' });
  assert.equal(r.status, 400, JSON.stringify(r));
  r = ok(await alice.call('POST', '/api/tele/login/code', { code: CODE }), 'alice code');
  assert.equal(r.status, 'ready', JSON.stringify(r));
  r = ok(await alice.call('GET', '/api/tele/status'), 'alice status');
  assert.equal(r.account.status, 'connected');
  assert.ok(!r.account.phone.includes(alicePhone.slice(4, 8)), 'phone must be masked');
  const aliceTg = r.account.tgUserId;

  log('Bob logs in');
  ok(await bob.call('POST', '/api/tele/login/phone', { phone: bobPhone }), 'bob phone');
  r = ok(await bob.call('POST', '/api/tele/login/code', { code: CODE }), 'bob code');
  assert.equal(r.status, 'ready');
  const bobTg = (await bob.call('GET', '/api/tele/status')).account.tgUserId;

  log('Charlie writes to Alice and makes a group with Alice and Bob');
  await charlie.invoke({ _: 'importContacts', contacts: [{ _: 'importedContact', phone_number: alicePhone, first_name: 'Alice', last_name: '' }, { _: 'importedContact', phone_number: bobPhone, first_name: 'Bob', last_name: '' }] });
  const pchat = await charlie.invoke({ _: 'createPrivateChat', user_id: aliceTg, force: false });
  const hello = await charlie.invoke({ _: 'sendMessage', chat_id: pchat.id, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: 'hello alice zebra-42' } } });
  const group = await charlie.invoke({ _: 'createNewBasicGroupChat', user_ids: [aliceTg, bobTg], title: 'Tele E2E group', message_auto_delete_time: 0 });
  const groupChatId = group.chat_id ?? group.id;
  await charlie.invoke({ _: 'sendMessage', chat_id: groupChatId, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: 'group hello from charlie' } } });

  log('Alice: "add a chat" shows the whole list; nothing is selected on its own');
  const findDialogs = async () => {
    const x = ok(await alice.call('POST', '/api/tele/dialogs/refresh', { all: true }), 'refresh all');
    const p = x.dialogs.find((d) => d.kind === 'private' && /Charlie/.test(d.title));
    const g = x.dialogs.find((d) => d.title === 'Tele E2E group');
    return p && g && { p, g, all: x.dialogs };
  };
  const { p: pd, g: gd } = await until('chats from Charlie', findDialogs, 90000);
  assert.equal(pd.selected, false);
  assert.equal(gd.selected, false);
  ok(await alice.call('PATCH', `/api/tele/dialogs/${pd.id}`, { selected: true }), 'select private');
  ok(await alice.call('PATCH', `/api/tele/dialogs/${gd.id}`, { selected: true }), 'select group');

  log('Alice reads the private chat (sender names) and the group');
  r = await until('charlie message', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages');
    return x.messages.find((m) => m.text === 'hello alice zebra-42') && x;
  });
  const helloMsg = r.messages.find((m) => m.text === 'hello alice zebra-42');
  assert.equal(helloMsg.direction, 'in');
  assert.match(helloMsg.senderName, /Charlie/);
  r = await until('group message', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${gd.id}/messages`), 'group messages');
    return x.messages.find((m) => m.text === 'group hello from charlie') && x;
  });
  assert.match(r.messages.find((m) => m.text === 'group hello from charlie').senderName, /Charlie/);

  log('Alice replies to Charlie: sent once, under its final id, with the quote');
  r = ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: 'reply from alice 7731', replyTo: helloMsg.tgMsgId }), 'send reply');
  assert.equal(r.message.replyTo?.tgMsgId, helloMsg.tgMsgId);
  const got = await until('charlie receives the reply', () => charlieMsgs.find((m) => !m.is_outgoing && textOf(m) === 'reply from alice 7731'), 30000);
  assert.equal(got.reply_to?.message_id, hello.id ?? got.reply_to?.message_id, 'reply points to the quoted message');
  r = await until('final id stored', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages?local=1`), 'local messages');
    const mine = x.messages.filter((m) => m.text === 'reply from alice 7731');
    return mine.length === 1 && mine[0].tgMsgId % 1048576 === 0 && x;
  }, 30000);
  const reply = r.messages.find((m) => m.text === 'reply from alice 7731');
  assert.equal(reply.replyTo?.text, 'hello alice zebra-42');
  // Another full sync must not add a second copy.
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages again');
  assert.equal(r.messages.filter((m) => m.text === 'reply from alice 7731').length, 1, 'message stored twice');
  assert.equal(charlieMsgs.filter((m) => textOf(m) === 'reply from alice 7731').length, 1, 'message sent twice');

  log('Bob writes in the group; Alice sees his name');
  const bobDialogs = await until('bob sees the group', async () => {
    const x = ok(await bob.call('POST', '/api/tele/dialogs/refresh', { all: true }), 'bob refresh');
    return x.dialogs.find((d) => d.title === 'Tele E2E group');
  }, 60000);
  ok(await bob.call('PATCH', `/api/tele/dialogs/${bobDialogs.id}`, { selected: true }), 'bob select');
  ok(await bob.call('POST', `/api/tele/dialogs/${bobDialogs.id}/messages`, { text: 'bob says hi in group' }), 'bob send');
  r = await until('bob message at alice', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${gd.id}/messages`), 'group');
    return x.messages.find((m) => m.text === 'bob says hi in group') && x;
  });
  assert.match(r.messages.find((m) => m.text === 'bob says hi in group').senderName, /Bob/);

  log('Search the whole history');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/search?q=zebra-42`), 'search');
  assert.equal(r.messages.length, 1);
  r = await alice.call('GET', `/api/tele/dialogs/${pd.id}/search?q=z`);
  assert.equal(r.status, 400);

  log('Users cannot reach each other\'s chats');
  r = await bob.call('GET', `/api/tele/dialogs/${pd.id}/messages`);
  assert.equal(r.status, 404);
  r = await bob.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: 'x' });
  assert.equal(r.status, 404);

  log('A removed chat stays removed after refreshing');
  ok(await alice.call('PATCH', `/api/tele/dialogs/${gd.id}`, { selected: false }), 'deselect');
  await charlie.invoke({ _: 'sendMessage', chat_id: groupChatId, input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: 'new message in removed chat' } } });
  await sleep(3000);
  r = ok(await alice.call('POST', '/api/tele/dialogs/refresh', {}), 'refresh selected');
  assert.equal(r.dialogs.find((d) => d.id === gd.id).selected, false);
  r = ok(await alice.call('POST', '/api/tele/dialogs/refresh', { all: true }), 'refresh all');
  assert.equal(r.dialogs.find((d) => d.id === gd.id).selected, false);
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.equal(r.dialogs.find((d) => d.id === gd.id).selected, false);

  log('Photos: off by default, on for Alice only');
  const pngFile = path.join(DATA_DIR, 'charlie.png');
  fs.writeFileSync(pngFile, png(320, 240, 90));
  await charlie.invoke({ _: 'sendMessage', chat_id: pchat.id, input_message_content: { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: pngFile } }, caption: { _: 'formattedText', text: 'photo caption 55' } } });
  r = await until('photo message at alice', async () => {
    const x = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages');
    return x.messages.find((m) => m.photo && /photo caption 55/.test(m.text)) && x;
  }, 60000);
  const photoMsg = r.messages.find((m) => m.photo && /photo caption 55/.test(m.text));
  assert.ok(photoMsg.photo.w > 0);
  r = await alice.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.equal(r.status, 403, 'photo allowed before the admin allowed it');
  const accounts = ok(await owner.call('GET', '/api/admin/tele/accounts'), 'accounts').accounts;
  const aliceAcc = accounts.find((a) => a.username === 'alice');
  ok(await owner.call('PATCH', `/api/admin/tele/accounts/${aliceAcc.id}`, { allowMedia: true }), 'allow media');
  r = await alice.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.equal(r.status, 200, JSON.stringify(r).slice(0, 300));
  assert.ok(r.bytes.length > 1000 && /^image\//.test(r.type));
  r = await bob.call('GET', `/api/tele/messages/${photoMsg.id}/photo`);
  assert.ok([403, 404].includes(r.status));

  log('Alice sends a photo; Bob may not');
  const form = new FormData();
  form.append('file', new Blob([png(200, 200, 200)], { type: 'image/png' }), 'a.png');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo?caption=${encodeURIComponent('from alice 909')}`, null, { form });
  assert.equal(r.status, 201, JSON.stringify(r));
  await until('charlie receives the photo', () => charlieMsgs.find((m) => m.content?._ === 'messagePhoto' && textOf(m) === 'from alice 909'), 60000);
  const form2 = new FormData();
  form2.append('file', new Blob([png(50, 50, 1)], { type: 'image/png' }), 'b.png');
  r = await bob.call('POST', `/api/tele/dialogs/${bobDialogs.id}/photo`, null, { form: form2 });
  assert.equal(r.status, 403);
  const form3 = new FormData();
  form3.append('file', new Blob(['not an image'], { type: 'text/plain' }), 'c.txt');
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/photo`, null, { form: form3 });
  assert.equal(r.status, 400);

  log('Server restart: the account reconnects from its saved session');
  await stopServer();
  await startServer();
  r = await until('tunnel back after restart', async () => (await alice.call('GET', '/api/tele/status')).runtime?.egress?.running && true, 30000);
  r = ok(await alice.call('GET', '/api/tele/status'), 'status after restart');
  assert.equal(r.account.status, 'connected');
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'messages after restart');
  assert.ok(!r.notice, `notice after restart: ${r.notice}`);
  ok(await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: 'after restart 314' }), 'send after restart');
  await until('charlie receives after restart', () => charlieMsgs.find((m) => textOf(m) === 'after restart 314'), 30000);

  log('A login left at the code step is dropped after a restart');
  const dave = client();
  ok(await dave.call('POST', '/api/auth/register', { username: 'dave', password: PASS, displayName: 'Dave' }), 'dave register');
  ok(await dave.call('POST', '/api/tele/login/phone', { phone: phone() }), 'dave phone');
  await stopServer();
  await startServer();
  r = ok(await dave.call('GET', '/api/tele/status'), 'dave status');
  assert.equal(r.account.status, 'disconnected');
  r = await dave.call('POST', '/api/tele/login/code', { code: CODE });
  assert.equal(r.status, 409);

  log('Proxy turned off: Telegram waits; nothing goes out directly');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: false }), 'disable proxy');
  r = await until('tunnel stopped', async () => {
    const x = await owner.call('GET', '/api/admin/tele/proxies');
    return !x.egress.running && x;
  }, 20000);
  r = await alice.call('POST', `/api/tele/dialogs/${pd.id}/messages`, { text: 'must not be sent 000' });
  assert.ok(r.status >= 400, `sent without a proxy: ${JSON.stringify(r)}`);
  r = ok(await alice.call('GET', `/api/tele/dialogs/${pd.id}/messages`), 'stored messages without proxy');
  assert.ok(r.messages.length > 0, 'stored messages are still shown');
  ok(await owner.call('PATCH', `/api/admin/tele/proxies/${goodId}`, { enabled: true }), 'enable proxy');
  ok(await owner.call('POST', `/api/admin/tele/proxies/${goodId}/probe`, {}), 'probe');
  await until('tunnel back', async () => (await owner.call('GET', '/api/admin/tele/proxies')).egress.running, 30000);
  await sleep(3000);
  assert.ok(!charlieMsgs.some((m) => textOf(m) === 'must not be sent 000'), 'a message went out without the proxy');

  log('Alice disconnects');
  ok(await alice.call('POST', '/api/tele/disconnect', {}), 'disconnect');
  r = ok(await alice.call('GET', '/api/tele/status'), 'status');
  assert.ok(!r.account || r.account.status === 'disconnected');
  assert.equal(r.dialogs.length, 0);
  ok(await bob.call('POST', '/api/tele/disconnect', {}), 'bob disconnect');

  console.log('\nTele e2e: all passed');
} catch (e) {
  fail = e;
  console.error(`\nFAILED at: ${step}\n`, e);
} finally {
  await charlie.invoke({ _: 'logOut' }).catch(() => {});
  await charlie.close().catch(() => {});
  await stopServer();
  await stopSocks();
}
process.exit(fail ? 1 : 0);
