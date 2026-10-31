// Long test with simulated users (.github/workflows/soak.yml): half on desktop size, half phone
// size, using everything for hours: messages, photos, videos, voice, files, music, calls, voice
// rooms, streams, dropped connections, the admin panel. Nothing here stops at the first problem:
// every problem goes in soak-out/report.md (rewritten every minute) with a screenshot.
// Telegram is left out: it would risk the test account, and tele-e2e.mjs covers it.
// Usage: HOURS=1 USERS=10 node test/soak.mjs <baseUrl> <setupCode>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const HOURS = Number(process.env.HOURS || 1);
const USERS = Number(process.env.USERS || 10);
const OUT = path.resolve(process.env.OUT || 'soak-out');
const SERVER_LOG = process.env.SERVER_LOG || '';
const PASS = 'Str0ng-Pass-77';
const END = Date.now() + HOURS * 3600e3;
const started = Date.now();
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const others = (u) => users.filter((x) => x !== u);
const log = (...a) => console.log(`[${((Date.now() - started) / 60000).toFixed(1)}m]`, ...a);

// ---------- Findings ----------
const issues = new Map();
const stats = { actions: {}, failed: {}, api: [], samples: [] };
let shots = 0;
const normal = (s) => String(s).replace(/https?:\/\/\S+/g, (u) => u.replace(/\/\d+/g, '/N').replace(/\?.*/, '')).replace(/\d{2,}/g, 'N').slice(0, 300);
async function issue(severity, area, text, page) {
  const key = `${area}|${normal(text)}`;
  const i = issues.get(key);
  if (i) {
    i.count++;
    i.last = Date.now();
    return;
  }
  const entry = { severity, area, text: String(text).slice(0, 1500), count: 1, first: Date.now(), last: Date.now(), shot: null };
  issues.set(key, entry);
  log(`!! [${severity}] ${area}: ${String(text).slice(0, 200)}`);
  if (page && shots < 300) {
    const file = `issue-${++shots}.png`;
    await page.screenshot({ path: path.join(OUT, file) }).then(() => (entry.shot = file), () => {});
  }
}
function report() {
  const order = { high: 0, medium: 1, low: 2 };
  const list = [...issues.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const p = (a, n) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length * n)] : 0);
  const rows = Object.entries(stats.actions).sort().map(([k, n]) => `| ${k} | ${n} | ${stats.failed[k] || 0} |`);
  const md = [
    `# Soak report: ${USERS} users, ${((Date.now() - started) / 3600e3).toFixed(2)} of ${HOURS} hours`,
    '',
    `API latency: median ${p(stats.api, 0.5)} ms, p95 ${p(stats.api, 0.95)} ms, worst ${Math.max(0, ...stats.api)} ms`,
    '',
    '## Problems',
    ...list.map((i) => `- **${i.severity}** \`${i.area}\` ×${i.count}: ${i.text}${i.shot ? ` (${i.shot})` : ''}`),
    list.length ? '' : 'None.',
    '## Actions',
    '| action | done | failed |',
    '|---|---|---|',
    ...rows,
    '',
    '## Server over time',
    '| min | server MB | chrome MB | disk MB | errors in log |',
    '|---|---|---|---|---|',
    ...stats.samples.filter((_, i) => i % 5 === 0).map((s) => `| ${s.min} | ${s.rss} | ${s.chrome} | ${s.disk} | ${s.errors} |`),
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ issues: list, stats: { ...stats, api: undefined } }, null, 1));
}

// ---------- API users ----------
let ipN = 1;
function apiClient(name) {
  let cookie = '';
  const ip = `10.7.0.${ipN++}`;
  const call = async (method, url, body, form) => {
    const t = Date.now();
    let res;
    try {
      res = await fetch(BASE + url, {
        method,
        signal: AbortSignal.timeout(120000),
        headers: { 'x-requested-with': 'amorechat', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: form || (body && JSON.stringify(body)),
      });
    } catch (e) {
      await issue('high', 'api', `${method} ${url} did not answer: ${e.message}`);
      throw e;
    }
    if (!form) stats.api.push(Date.now() - t);
    if (stats.api.length > 200000) stats.api.splice(0, 100000);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (res.status >= 500) await issue('high', 'api', `${method} ${url} → ${res.status}`);
    return { http: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return { name, call, session: () => cookie.split('=')[1] };
}
const ok = (r, what) => {
  if (r.http < 200 || r.http >= 300) throw new Error(`${what}: ${r.http} ${r.error || ''}`);
  return r;
};

// ---------- Test files, made once ----------
const FX = path.join(OUT, 'fixtures');
fs.mkdirSync(FX, { recursive: true });
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const fx = {
  png: path.join(FX, 'photo.png'),
  jpg: path.join(FX, 'big.jpg'),
  mp4: path.join(FX, 'clip.mp4'),
  voice: path.join(FX, 'voice.ogg'),
  songs: [1, 2, 3, 4].map((n) => path.join(FX, `Artist ${n} - Song ${n}.mp3`)),
  doc: path.join(FX, 'report نهایی.pdf'),
};
ff('-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', fx.png);
ff('-f', 'lavfi', '-i', 'mandelbrot=size=3000x2000', '-frames:v', '1', fx.jpg);
ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=440', '-t', '8', '-pix_fmt', 'yuv420p', fx.mp4);
ff('-f', 'lavfi', '-i', 'sine=300', '-t', '5', '-c:a', 'libopus', fx.voice);
fx.songs.forEach((s, i) => ff('-f', 'lavfi', '-i', `sine=frequency=${300 + i * 110}`, '-t', '20', s));
fs.writeFileSync(fx.doc, crypto.randomBytes(3 * 1048576));
const blobOf = (file, type) => new Blob([fs.readFileSync(file)], { type });
async function upload(u, file, type) {
  const form = new FormData();
  form.append('file', blobOf(file, type), path.basename(file));
  const r = ok(await u.api.call('POST', '/api/upload', null, form), 'upload');
  return r.id ?? r.file?.id;
}

// ---------- Browser users ----------
const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen', '--js-flags=--max-old-space-size=512'],
  protocolTimeout: 180000,
});
const owner = { name: 'owner', api: apiClient('owner'), phone: false };
const users = [owner];
ok(await owner.api.call('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP }), 'owner');
ok(await owner.api.call('PATCH', '/api/admin/settings', { registration_mode: 'open', max_upload_mb: '200' }), 'settings');
for (let i = 1; i < USERS; i++) {
  const u = { name: `user${i}`, api: apiClient(`user${i}`), phone: i % 2 === 1 };
  u.id = ok(await u.api.call('POST', '/api/auth/register', { username: u.name, password: PASS, displayName: `کاربر ${i}` }), 'register').user.id;
  users.push(u);
}
const ids = users.slice(1).map((u) => u.id);
const group = ok(await owner.api.call('POST', '/api/chats', { type: 'group', title: 'گروه همه', memberIds: ids }), 'group').chat.id;
const channel = ok(await owner.api.call('POST', '/api/chats', { type: 'channel', title: 'کانال موزیک', memberIds: ids }), 'channel').chat.id;
const lobby = ok(await owner.api.call('POST', '/api/chats', { type: 'voice', title: 'Lobby', isPublic: true }), 'lobby').chat.id;
for (const u of users) {
  if (u !== owner) ok(await u.api.call('POST', `/api/chats/${lobby}/join`, {}), 'join lobby').http;
}
const dms = new Map();
async function dmOf(a, b) {
  const key = [a.name, b.name].sort().join('-');
  if (!dms.has(key)) dms.set(key, ok(await a.api.call('POST', '/api/chats/dm', { userId: b.id ?? (await b.api.call('GET', '/api/auth/me')).user.id }), 'dm').chat.id);
  return dms.get(key);
}

const NOISE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_ABORTED|net::ERR_FAILED|DataChannel|data channel|navigator\.vibrate|favicon|Failed to load resource: the server responded with a status of 4\d\d/;
async function openUser(u) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  u.page = page;
  u.ctx = ctx;
  page.setDefaultTimeout(30000);
  await page.setViewport(u.phone ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1280, height: 800 });
  if (u.phone) await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text()) && !u.offline) issue('medium', 'console', `${u.phone ? 'phone' : 'desktop'}: ${m.text()}`, page);
  });
  page.on('pageerror', (e) => issue('high', 'page-crash', `${u.phone ? 'phone' : 'desktop'}: ${e.message}`, page));
  page.on('response', (r) => r.status() >= 500 && issue('high', 'http', `${r.request().method()} ${r.url()} → ${r.status()}`, page));
  page.on('error', (e) => issue('high', 'tab-crash', `${u.name}: ${e.message}`));
  await page.setCookie({ name: 'ac_session', value: u.api.session(), url: BASE });
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
}
for (const u of users) await openUser(u);
log(`${users.length} users open`);

const wait = (page, fn, arg, what, timeout = 30000) =>
  page.waitForFunction(fn, { timeout, polling: 300 }, arg).catch(() => {
    throw new Error(`timed out: ${what}`);
  });
const go = async (u, chat) => {
  await u.page.evaluate((h) => (location.hash = h), `#/chat/${chat}`);
  await wait(u.page, () => document.querySelector('.chat-head'), null, 'chat open');
  await sleep(500);
  const at = await u.page.evaluate(() => location.hash);
  if (at !== `#/chat/${chat}`) throw new Error(`opening a chat ended at ${at.replace(/\d+/g, 'N')}`);
};
const has = (page, sel, text, what, t) => wait(page, ([s, x]) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(x)), [sel, text], what, t);
const click = async (page, sel, text) => {
  await wait(page, ([s, x]) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(x)), [sel, text], `button ${text}`);
  await page.$$eval(sel, (els, x) => els.find((e) => e.textContent.includes(x)).click(), text);
};
const word = () => `w${crypto.randomBytes(4).toString('hex')}`;

// ---------- What users do ----------
const light = {
  async typeMessage(u) {
    const to = pick(others(u));
    const chat = pick([group, await dmOf(u, to)]);
    const text = `${word()} سلام`;
    await go(u, chat);
    await u.page.click('.composer textarea');
    await u.page.type('.composer textarea', text, { delay: 5 });
    await u.page.keyboard.press('Enter');
    await has(u.page, '.bubble', text, 'own message shown');
    const seen = await waitApi(to, chat, text);
    if (seen > 1) throw new Error(`message delivered ${seen} times`);
  },
  async burst(u) {
    const tag = word();
    for (let i = 0; i < 20; i++) ok(await u.api.call('POST', `/api/chats/${group}/messages`, { text: `${tag} ${i}` }), 'burst');
    const m = (await others(u)[0].api.call('GET', `/api/chats/${group}/messages?limit=100`)).messages.filter((x) => x.text?.startsWith(tag));
    const nums = m.map((x) => Number(x.text.split(' ')[1]));
    if (nums.length !== 20 || nums.some((n, i) => n !== i)) throw new Error(`burst of 20 came back as ${nums.join(',')}`);
  },
  async replyEditReact(u) {
    const other = pick(others(u));
    const a = ok(await u.api.call('POST', `/api/chats/${group}/messages`, { text: `q ${word()}` }), 'msg').message;
    const r = ok(await other.api.call('POST', `/api/chats/${group}/messages`, { text: 'reply', replyTo: a.id }), 'reply').message;
    ok(await other.api.call('POST', `/api/messages/${a.id}/react`, { emoji: '👍' }), 'react');
    const edited = `edited ${word()}`;
    ok(await u.api.call('PATCH', `/api/messages/${a.id}`, { text: edited }), 'edit');
    await go(other, group);
    await has(other.page, '.bubble', edited, 'the edit shows');
    ok(await owner.api.call('POST', `/api/messages/${a.id}/pin`, {}), 'pin');
    ok(await owner.api.call('POST', `/api/messages/${a.id}/pin`, {}), 'unpin');
    ok(await other.api.call('DELETE', `/api/messages/${r.id}`, {}), 'delete');
  },
  async deleteIsGone(u) {
    const other = pick(others(u).filter((x) => x !== owner));
    const text = `gone ${word()}`;
    const m = ok(await u.api.call('POST', `/api/chats/${group}/messages`, { text }), 'msg').message;
    await go(other, group);
    await has(other.page, '.bubble', text, 'message arrives');
    ok(await u.api.call('DELETE', `/api/messages/${m.id}`, {}), 'delete');
    await wait(other.page, (t) => ![...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes(t)), text, 'deleted message disappears');
  },
  async forwardSearch(u) {
    const name = word();
    const m = ok(await u.api.call('POST', `/api/chats/${group}/messages`, { text: `find ${name}` }), 'msg').message;
    ok(await u.api.call('POST', `/api/messages/${m.id}/forward`, { chatIds: [channel].slice(0, 0).concat(await dmOf(u, pick(others(u)))) }), 'forward');
    await sleep(500);
    const r = ok(await pick(others(u)).api.call('GET', `/api/search?q=${name}`), 'search');
    if (!r.messages.some((x) => x.id === m.id)) throw new Error('search did not find a message');
  },
  async photoUi(u) {
    const other = pick(others(u));
    await go(u, group);
    const input = await u.page.waitForSelector('.composer input[type=file]');
    await input.uploadFile(pick([fx.png, fx.jpg]));
    await wait(u.page, () => document.querySelector('.modal .btn.primary'), null, 'send dialog');
    await click(u.page, '.modal .btn.primary', 'ارسال');
    await wait(u.page, () => !document.querySelector('.modal'), null, 'photo sent', 60000);
    await go(other, group);
    await wait(other.page, () => [...document.querySelectorAll('.bubble img')].some((i) => i.complete && i.naturalWidth > 0), null, 'photo visible to the other user', 60000);
  },
  async video(u) {
    const other = pick(others(u));
    const fileId = await upload(u, fx.mp4, 'video/mp4');
    const m = ok(await u.api.call('POST', `/api/chats/${group}/messages`, { fileId, type: 'video' }), 'video').message;
    for (let i = 0; i < 40; i++) {
      const got = (await other.api.call('GET', `/api/chats/${group}/messages?around=${m.id}&limit=3`)).messages?.find((x) => x.id === m.id);
      if (got?.file?.status === 'ready') {
        await go(other, group);
        await other.page.evaluate((id) => document.querySelector(`[data-mid="${id}"] video`)?.play?.().catch(() => {}), m.id);
        return;
      }
      await sleep(3000);
    }
    throw new Error('video never finished processing');
  },
  async voice(u) {
    const other = pick(others(u));
    const form = new FormData();
    form.append('file', blobOf(fx.voice, 'audio/ogg'), 'voice.ogg');
    const r = ok(await u.api.call('POST', '/api/upload?voice=1&dur=5', null, form), 'voice upload');
    ok(await u.api.call('POST', `/api/chats/${group}/messages`, { fileId: r.id ?? r.file?.id, type: 'voice' }), 'voice');
    await go(other, group);
    await wait(other.page, () => document.querySelector('.voice-player .play-btn'), null, 'voice message shown');
    await other.page.$$eval('.voice-player .play-btn', (b) => b.at(-1).click());
    await wait(other.page, () => [...document.querySelectorAll('.voice-player audio')].some((a) => a.currentTime > 0), null, 'voice plays');
    await other.page.$$eval('.voice-player audio', (a) => a.forEach((x) => x.pause()));
  },
  async fileIntact(u) {
    const other = pick(others(u));
    const body = crypto.randomBytes(1048576 + rnd(8 * 1048576));
    const form = new FormData();
    const name = `${word()}.bin`;
    form.append('file', new Blob([body]), name);
    const r = ok(await u.api.call('POST', '/api/upload', null, form), 'upload');
    const id = r.id ?? r.file?.id;
    ok(await u.api.call('POST', `/api/chats/${group}/messages`, { fileId: id, type: 'file' }), 'file');
    const res = await fetch(`${BASE}/api/files/${id}`, { headers: { cookie: `ac_session=${other.api.session()}` } });
    const got = Buffer.from(await res.arrayBuffer());
    if (!got.equals(body)) throw new Error(`a downloaded file differs (${body.length} sent, ${got.length} got, HTTP ${res.status})`);
    const found = ok(await other.api.call('GET', `/api/search?q=${name.slice(0, 9)}`), 'search');
    if (!found.messages.length) throw new Error('search did not find a file by name');
  },
  async music(u) {
    const song = pick(fx.songs);
    const fileId = await upload(owner, song, 'audio/mpeg');
    ok(await owner.api.call('POST', `/api/chats/${channel}/messages`, { fileId, type: 'file' }), 'song');
    await go(u, channel);
    await wait(u.page, () => document.querySelector('.music-msg .music-play'), null, 'song in the channel');
    await u.page.$$eval('.music-msg .music-play', (b) => b.at(-1).click());
    await wait(u.page, () => document.querySelector('.music-bar'), null, 'player bar');
    const pos = () => u.page.$eval('.music-bar-seek', (e) => Number(e.value));
    await wait(u.page, () => Number(document.querySelector('.music-bar-seek')?.value) > 0.5, null, 'the song moves');
    if ((await pos()) > 30) throw new Error('timeline far from the start');
    await u.page.$eval('.music-bar button[aria-label="بعدی"]', (b) => b.click());
    await u.page.$eval('.music-bar-text', (b) => b.click());
    await wait(u.page, () => document.querySelector('.music-sheet'), null, 'player panel');
    await u.page.$eval('.music-sheet button[aria-label^="شافل"]', (b) => b.click());
    await u.page.evaluate(() => document.querySelector('.music-sheet-close')?.click() ?? document.querySelector('.music-sheet-back').click());
    await go(u, group);
    if (!(await u.page.$('.music-bar'))) throw new Error('the player disappeared in another chat');
    await u.page.$eval('.music-bar button[aria-label="بستن پلیر"]', (b) => b.click());
  },
  async offline(u) {
    if (u.offline) return;
    const text = `off ${word()}`;
    await go(u, group);
    u.offline = true;
    await u.page.setOfflineMode(true);
    try {
      await sleep(3000 + rnd(10000));
      await u.page.click('.composer textarea');
      await u.page.type('.composer textarea', text);
      await u.page.keyboard.press('Enter');
      await sleep(2000);
    } finally {
      await u.page.setOfflineMode(false);
      u.offline = false;
    }
    const seen = await waitApi(pick(others(u)), group, text, 60000);
    if (seen !== 1) throw new Error(`queued message delivered ${seen} times`);
  },
  async wander(u) {
    await u.page.reload({ waitUntil: 'domcontentloaded' });
    await wait(u.page, () => document.querySelector('.sidebar, .chat-pane'), null, 'app after reload');
    await go(u, pick([group, channel]));
    await u.page.evaluate(() => document.querySelector('.chat-head .chat-head-info')?.click());
    await sleep(800);
    for (const tab of await u.page.$$('.modal .tabs button').catch(() => [])) {
      await tab.evaluate((b) => b.click());
      await sleep(300);
    }
    await u.page.keyboard.press('Escape');
    await u.page.evaluate(() => document.querySelector('.modal .close, .modal [aria-label="بستن"]')?.click());
  },
};
const admin = {
  async adminPanel() {
    const p = owner.page;
    await p.evaluate(() => (location.hash = '#/'));
    await sleep(500);
    await p.evaluate(() => document.querySelector('.menu-btn')?.click());
    await click(p, '.sidebar .menu > button', 'پنل مدیریت');
    await wait(p, () => document.querySelector('.modal .tabs button'), null, 'admin panel');
    const n = await p.$$eval('.modal .tabs button', (b) => b.length);
    for (let i = 0; i < n; i++) {
      await p.$$eval('.modal .tabs button', (b, x) => b[x].click(), i);
      await sleep(900);
    }
    await p.evaluate(() => document.querySelector('.modal [aria-label="بستن"], .modal .close')?.click());
    const b = ok(await owner.api.call('POST', '/api/admin/backups', {}), 'backup');
    const c = ok(await owner.api.call('POST', `/api/admin/backups/${b.name}/check`, {}), 'backup check');
    if (!c.check.ok) throw new Error(`backup not healthy: ${c.check.error}`);
  },
  async banUnban() {
    const v = users.at(-1);
    ok(await owner.api.call('POST', `/api/admin/users/${v.id}/ban`, { banned: true }), 'ban');
    await sleep(1000);
    ok(await owner.api.call('POST', `/api/admin/users/${v.id}/ban`, { banned: false }), 'unban');
    ok(await v.api.call('POST', '/api/auth/login', { username: v.name, password: PASS }), 'login after unban');
    await v.page.setCookie({ name: 'ac_session', value: v.api.session(), url: BASE });
    await v.page.reload({ waitUntil: 'domcontentloaded' });
  },
};
async function waitApi(u, chat, text, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const r = await u.api.call('GET', `/api/chats/${chat}/messages?limit=100`);
    const n = (r.messages || []).filter((m) => m.text === text).length;
    if (n) return n;
    if (Date.now() > end) throw new Error(`message not delivered within ${timeout / 1000}s`);
    await sleep(700);
  }
}

// Calls take a lot of the machine: one at a time, with free users.
const hangup = (p) => p.evaluate(() => document.querySelector('.call-view .ctl.hangup, .room-view .ctl.hangup')?.click());
const callFree = () => users.filter((u) => !u.busy && !u.offline);
const heavy = {
  async callVideo(a, b, video = true) {
    await go(a, await dmOf(a, b));
    await go(b, await dmOf(a, b));
    await a.page.click(`button[aria-label="${video ? 'تماس تصویری' : 'تماس صوتی'}"]`);
    await wait(b.page, () => document.querySelector('.incoming-call'), null, 'incoming call', 20000);
    await b.page.click('button[aria-label="پاسخ"]');
    for (const u of [a, b]) await wait(u.page, () => document.querySelector('.call-view[data-remote="1"]'), null, 'call connected', 40000);
    if (video) await wait(b.page, () => document.querySelector('.call-main')?.videoWidth > 0, null, 'remote video', 30000);
    await sleep(15000 + rnd(30000));
    await hangup(a.page);
    await wait(b.page, () => !document.querySelector('.call-view'), null, 'call closed on the other side');
  },
  callAudio(a, b) {
    return heavy.callVideo(a, b, false);
  },
  async callDeclined(a, b) {
    await go(a, await dmOf(a, b));
    await a.page.click('button[aria-label="تماس صوتی"]');
    await wait(b.page, () => document.querySelector('.incoming-call'), null, 'incoming call', 20000);
    await b.page.click('button[aria-label="رد تماس"], .incoming-call .decline, .incoming-call .hangup');
    await wait(a.page, () => !document.querySelector('.call-view'), null, 'declined call closes');
  },
  async voiceRoom(a, b, c) {
    await go(a, lobby);
    await click(a.page, '.voice-banner button', 'ویس‌چت');
    await wait(a.page, () => document.querySelector('.voice-bar .dot.connected'), null, 'first in the room', 40000);
    for (const u of [b, c]) {
      await go(u, lobby);
      await click(u.page, '.voice-banner button', 'پیوستن');
      await wait(u.page, () => document.querySelector('.voice-bar .dot.connected'), null, 'joined the room', 40000);
    }
    await a.page.click('.vbar-info');
    await wait(a.page, () => document.querySelectorAll('.room-view .mtile.person').length === 3, null, 'three people in the room', 30000);
    await a.page.click('.room-view .ctl[title="دوربین"]');
    await sleep(10000);
    await a.page.click('.room-view .ctl[title="دوربین"]');
    await a.page.click('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
    await wait(a.page, () => !!document.querySelector('.modal .btn.primary'), null, 'stream dialog');
    await a.page.click('.modal .btn.primary');
    await wait(a.page, () => document.querySelector('.room-view .ctl.on[title="اشتراک صفحه (استریم)"]'), null, 'streaming', 30000);
    await b.page.click('.vbar-info');
    await wait(b.page, () => document.querySelector('.watch-btn'), null, 'watch button', 30000);
    await b.page.click('.watch-btn');
    await wait(b.page, () => document.querySelector('.spot-main .mtile.screen video')?.videoWidth > 0, null, 'stream visible', 40000);
    await sleep(30000 + rnd(60000));
    await a.page.click('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
    await hangup(a.page);
    await hangup(b.page);
    await c.page.evaluate(() => document.querySelector('.voice-bar .hangup, .voice-bar [aria-label*="خروج"]')?.click());
  },
};

async function run(name, fn, involved, recover = true) {
  stats.actions[name] = (stats.actions[name] || 0) + 1;
  try {
    await Promise.race([fn(), sleep(240000).then(() => Promise.reject(new Error('action took over 4 minutes')))]);
  } catch (e) {
    stats.failed[name] = (stats.failed[name] || 0) + 1;
    const u = involved[0];
    const at = await u?.page.evaluate(() => location.hash.replace(/\d+/g, 'N')).catch(() => '?');
    await issue(/did not answer|delivered|differs|crash/.test(e.message) ? 'high' : 'medium', name, `${e.message} [${u?.phone ? 'phone' : 'desktop'} ${at}]`, u?.page);
    if (recover) {
      for (const u of involved) {
        await u.page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await u.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }
  }
}

async function adminLoop() {
  await sleep(60000);
  while (Date.now() < END) {
    await sleep(240000 + rnd(240000));
    const name = pick(Object.keys(admin));
    const who = name === 'banUnban' ? users.at(-1) : owner;
    if (who.busy) continue;
    who.busy = true;
    await sleep(15000); // what they were doing ends
    await run(name, admin[name], [who]);
    who.busy = false;
  }
}

const weighted = Object.keys(light).flatMap((k) => Array((['typeMessage', 'replyEditReact', 'music', 'photoUi'].includes(k) && 3) || 1).fill(k));
async function userLoop(u) {
  await sleep(rnd(20000));
  while (Date.now() < END) {
    if (u.busy) {
      await sleep(1000);
      continue;
    }
    const name = pick(weighted);
    await run(name, () => light[name](u), [u]);
    await sleep(2000 + rnd(8000));
  }
}
async function callLoop() {
  await sleep(30000);
  while (Date.now() < END) {
    const name = pick(Object.keys(heavy));
    const need = name === 'voiceRoom' ? 3 : 2;
    const free = callFree().sort(() => Math.random() - 0.5).slice(0, need);
    if (free.length === need) {
      free.forEach((u) => (u.busy = true));
      await sleep(12000); // what they were doing ends
      await run(name, () => heavy[name](...free), free);
      for (const u of free) await hangup(u.page).catch(() => {});
      free.forEach((u) => (u.busy = false));
    }
    await sleep(30000 + rnd(60000));
  }
}

// ---------- Every minute: the server's health; every 10 minutes: do people see the same thing? ----------
const baseline = {};
async function sample() {
  const min = Math.round((Date.now() - started) / 60000);
  const sh = (c) => {
    try {
      return execFileSync('sh', ['-c', c], { encoding: 'utf8' }).trim();
    } catch {
      return '0';
    }
  };
  const rss = Math.round(Number(sh("ps -o rss= -p $(pgrep -f server/src/index.js | head -1)")) / 1024);
  const chrome = Math.round(Number(sh("ps -o rss= -C chrome | awk '{s+=$1} END {print s}'")) / 1024);
  const disk = Number(sh(`du -sm ${process.env.DATA_DIR || '/tmp/soak'} | cut -f1`));
  let errors = 0;
  if (SERVER_LOG && fs.existsSync(SERVER_LOG)) {
    const lines = fs.readFileSync(SERVER_LOG, 'utf8').split('\n').filter((l) => /"level":(50|60)/.test(l));
    errors = lines.length;
    for (const l of lines) {
      try {
        const j = JSON.parse(l);
        await issue('high', 'server-log', `${j.msg || ''} ${j.err?.message || ''} ${j.err?.stack?.split('\n')[1] || ''}`);
      } catch {
        /* a partial line */
      }
    }
  }
  stats.samples.push({ min, rss, chrome, disk, errors });
  baseline.rss ??= rss;
  if (min > 60 && rss > baseline.rss * 3 && rss > 500) await issue('medium', 'memory', `server memory grew from ${baseline.rss} to ${rss} MB`);
  const t = Date.now();
  const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) await issue('high', 'health', 'healthz did not answer in 10 s');
  else if (Date.now() - t > 2000) await issue('medium', 'health', `healthz took ${Date.now() - t} ms`);
  report();
}
async function consistency() {
  const a = pick(users);
  const b = pick(others(a));
  const [x, y] = await Promise.all([a, b].map((u) => u.api.call('GET', `/api/chats/${group}/messages?limit=100`)));
  const live = (r) => r.messages.filter((m) => m.type !== 'deleted').map((m) => m.id);
  const ids2 = new Set(live(y));
  const missing = live(x).filter((id) => !ids2.has(id)).filter((id) => id < Math.max(...live(x)) - 20);
  if (missing.length) await issue('high', 'consistency', `two users see different messages: ${missing.length} missing`);
  const seen = new Set();
  for (const id of x.messages.map((m) => m.id)) {
    if (seen.has(id)) await issue('high', 'consistency', 'a message twice in one page');
    seen.add(id);
  }
  for (const u of users) {
    const dom = await u.page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length, heap: performance.memory?.usedJSHeapSize || 0 })).catch(() => null);
    if (!dom) await issue('high', 'tab-crash', `${u.name}: the page does not answer`, u.page);
    else if (dom.heap > 400e6) await issue('medium', 'memory', `${u.phone ? 'phone' : 'desktop'} page uses ${Math.round(dom.heap / 1e6)} MB`, u.page);
  }
}

const timers = [setInterval(() => sample().catch(() => {}), 60000), setInterval(() => consistency().catch((e) => issue('medium', 'consistency', e.message)), 600000)];
await sample();
await Promise.all([...users.map(userLoop), callLoop(), adminLoop()]);
timers.forEach(clearInterval);
await sample();
await consistency().catch(() => {});
report();
await browser.close().catch(() => {});
log(`done: ${issues.size} different problems. See ${path.join(OUT, 'report.md')}`);
process.exit(0);
