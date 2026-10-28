// Crowd test: six people in real (headless) Chromes with fake microphones/cameras, all at the
// same time, against one server with a real LiveKit: sign up through the page, chat in a group,
// private chats and a channel, react / reply / edit / delete, send a picture, go offline and
// back, then a voice channel with several screen streams. Problems are collected (not fatal
// one by one) and listed at the end, together with page errors and server 5xx responses.
// Usage: node test/crowd-e2e.mjs <baseUrl> <setupCode> [serverLogFile]   (needs `puppeteer`)
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const SERVER_LOG = process.argv[4];
const N = 6;
const PASS = 'Crowd-Pass-2026!';
const NAMES = ['امیر', 'سارا', 'علی', 'مریم', 'رضا', 'نگار'];
const USERS = ['amir', 'sara', 'ali', 'maryam', 'reza', 'negar'];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);

const problems = [];
const passed = [];
const pageErrors = [];
const serverErrors = [];
const notes = []; // not failures, but worth knowing (e.g. a tap that needed a second try)
let expectOffline = false;

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    passed.push(name);
    log(`✓ ${name} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  } catch (e) {
    problems.push(`${name}: ${e.message.split('\n')[0]}`);
    log(`✗ ${name}: ${e.message.split('\n')[0]}`);
    await Promise.all(P.map((p, i) => p.screenshot({ path: `crowd-fail-${problems.length}-${USERS[i]}.png` }).catch(() => {})));
  }
}
const waitFor = (p, fn, arg, what, timeout = 20000) =>
  p.waitForFunction(fn, { timeout, polling: 200 }, arg).catch(() => {
    throw new Error(`timed out: ${what}`);
  });
const all = (fn) => Promise.all(P.map((p, i) => fn(p, i)));
async function clickText(p, selector, text) {
  await waitFor(p, ([s, t]) => [...document.querySelectorAll(s)].some((b) => b.textContent.includes(t)), [selector, text], `${selector} "${text}"`);
  await p.$$eval(selector, (els, t) => els.find((b) => b.textContent.includes(t)).click(), text);
}
async function typeSend(p, text) {
  await p.waitForSelector('.composer textarea');
  await p.click('.composer textarea');
  await p.keyboard.type(text, { delay: 5 });
  await p.click('.composer .send-btn[aria-label="ارسال"]');
}
async function openChat(p, id) {
  await p.evaluate((h) => (location.hash = h), `#/chat/${id}`);
  await waitFor(p, (cid) => location.hash === `#/chat/${cid}` && !!document.querySelector('.chat-head'), id, `chat ${id} open`);
}
async function msgMenu(p, selector, label) {
  const b = await p.$(selector);
  if (!b) throw new Error(`no message ${selector}`);
  await b.click({ button: 'right' });
  await waitFor(p, () => !!document.querySelector('.menu.floating'), null, 'message menu');
  await sleep(500);
  if (label) await clickText(p, '.menu.floating > button', label);
}
function apiClient(cookie) {
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'x-requested-with': 'amorechat', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}
const cookieOf = async (p) => (await p.cookies(BASE)).find((c) => c.name === 'ac_session')?.value;

async function startShare(p, i) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    // What happens to a tap that doesn't open the dialog: what was under the finger, and did the
    // dialog flash open and close again?
    const probe = await p.evaluate(() => {
      window.__modalEvents = [];
      const mo = new MutationObserver(() => window.__modalEvents.push(document.querySelector('.modal') ? 'open' : 'closed'));
      mo.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 5000);
      const b = document.querySelector('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
      const r = b.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { onButton: b.contains(at), at: at ? `${at.tagName}.${at.className}`.slice(0, 80) : null };
    });
    await p.click('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
    const opened = await p.waitForFunction(() => !!document.querySelector('.modal .btn.primary'), { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    if (opened) {
      // A tap that does nothing is a bug (it was a notification banner covering the button).
      if (attempt > 1) problems.push(`${USERS[i]}: the share button needed ${attempt} taps to open the stream dialog`);
      await p.click('.modal .btn.primary');
      return;
    }
    const events = await p.evaluate(() => [...new Set(window.__modalEvents)].join('→'));
    notes.push(`${USERS[i]} tap ${attempt} missed: under the finger ${probe.onButton ? 'the button' : probe.at}; dialog ${events || 'never appeared'}`);
    await p.screenshot({ path: `crowd-share-miss-${USERS[i]}-${attempt}.png` }).catch(() => {});
  }
  throw new Error(`${USERS[i]}: the stream dialog never opened`);
}

// ---------- Browser and the six people ----------
const browser = await puppeteer.launch({
  protocolTimeout: 120000,
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const P = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport(i % 2 ? { width: 390, height: 844, isMobile: true } : { width: 1200, height: 800 });
  p.on('pageerror', (e) => pageErrors.push(`${USERS[i]}: ${e.message.split('\n')[0]}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (expectOffline && /ERR_INTERNET_DISCONNECTED|Failed to fetch|socket\.io|WebSocket/.test(t)) return;
    if (/favicon|Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return;
    // LiveKit's own log lines when someone is removed from a room on purpose
    if (/DataChannel error|data channel '.*' closed unexpectedly/.test(t)) return;
    pageErrors.push(`${USERS[i]} console: ${t.slice(0, 200)}`);
  });
  p.on('response', (r) => r.status() >= 500 && serverErrors.push(`${USERS[i]}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
  p.on('dialog', (d) => d.accept());
  P.push(p);
}
const apis = [];
const ids = [];

try {
  // ---------- Sign up through the page ----------
  await check('owner signs up with the setup code (through the page)', async () => {
    const p = P[0];
    await p.goto(BASE, { waitUntil: 'networkidle2' });
    await waitFor(p, () => !!document.querySelector('.auth-card'), null, 'sign-up page');
    const fill = async (label, value) => {
      const handles = await p.$$('.auth-card label');
      for (const h of handles) if ((await h.evaluate((e) => e.textContent)).includes(label)) return (await h.$('input')).type(value);
      throw new Error(`no field ${label}`);
    };
    await fill('نام نمایشی', NAMES[0]);
    await fill('نام کاربری', USERS[0]);
    await fill('رمز عبور', PASS);
    await fill('کد', SETUP);
    await p.click('.auth-card .btn.primary');
    await waitFor(p, () => !!document.querySelector('.sidebar'), null, 'owner signed in');
    apis[0] = apiClient(`ac_session=${await cookieOf(p)}`);
    ids[0] = (await apis[0]('GET', '/api/auth/me')).user.id;
  });

  const invites = [];
  for (let i = 1; i < N; i++) invites.push((await apis[0]('POST', '/api/admin/invites', { maxUses: 1 })).invite.code);

  await check('five people sign up at the same time with invite codes', async () => {
    await Promise.all(
      P.slice(1).map(async (p, k) => {
        const i = k + 1;
        await p.goto(BASE, { waitUntil: 'networkidle2' });
        await waitFor(p, () => !!document.querySelector('.auth-card'), null, `${USERS[i]} auth page`);
        const tabs = await p.$$('.auth-card .tabs button');
        for (const t of tabs) if ((await t.evaluate((e) => e.textContent)).includes('ثبت‌نام')) await t.click();
        await waitFor(p, () => [...document.querySelectorAll('.auth-card label')].some((l) => l.textContent.includes('کد دعوت')), null, 'register form');
        const fill = async (label, value) => {
          for (const h of await p.$$('.auth-card label')) if ((await h.evaluate((e) => e.textContent)).includes(label)) return (await h.$('input')).type(value);
        };
        await fill('نام نمایشی', NAMES[i]);
        await fill('نام کاربری', USERS[i]);
        await fill('رمز عبور', PASS);
        await fill('کد دعوت', invites[k]);
        await p.click('.auth-card .btn.primary');
        await waitFor(p, () => !!document.querySelector('.sidebar'), null, `${USERS[i]} signed in`, 30000);
        apis[i] = apiClient(`ac_session=${await cookieOf(p)}`);
        ids[i] = (await apis[i]('GET', '/api/auth/me')).user.id;
      }),
    );
  });
  if (apis.filter(Boolean).length < N) throw new Error('not everyone could sign up; stopping');

  // ---------- Group chat, everyone at once ----------
  const group = (await apis[0]('POST', '/api/chats', { type: 'group', title: 'تیم', memberIds: ids.slice(1) })).chat.id;
  await check('group: everyone sees the new group in the list', () => all((p) => waitFor(p, (g) => !!document.querySelector(`.sidebar a[href="#/chat/${g}"]`), group, 'group in list')));
  await all((p) => openChat(p, group));

  await check('group: 6 people × 5 messages at the same time arrive everywhere, in the same order', async () => {
    await all(async (p, i) => {
      for (let k = 1; k <= 5; k++) {
        await typeSend(p, `${USERS[i]}-${k}`);
        await sleep(Math.random() * 300);
      }
    });
    await all((p) => waitFor(p, () => [...document.querySelectorAll('.msg-row .bubble')].filter((b) => /-\d$/.test(b.innerText.split('\n').find((l) => /-\d$/.test(l)) || '')).length >= 30, null, '30 messages', 45000));
    const orders = await all((p) => p.$$eval('.msg-row', (rows) => rows.map((r) => r.id).filter(Boolean)));
    const ref = JSON.stringify(orders[0]);
    orders.forEach((o, i) => {
      if (JSON.stringify(o) !== ref) throw new Error(`${USERS[i]} sees a different order`);
    });
    const nums = orders[0].map((x) => Number(x.replace('msg-', '')));
    if (nums.some((n, k) => k && n < nums[k - 1])) throw new Error('messages not in id order');
    // Each person's own 5 messages in the order they were sent
    const texts = await P[0].$$eval('.msg-row .bubble', (bs) => bs.map((b) => b.innerText));
    for (const u of USERS) {
      const mine = texts.map((t) => (t.match(new RegExp(`${u}-(\\d)`)) || [])[1]).filter(Boolean).map(Number);
      if (JSON.stringify(mine) !== '[1,2,3,4,5]') throw new Error(`${u}'s messages out of order: ${mine}`);
    }
  });

  await check('group: "typing…" shows for the others', async () => {
    await P[2].click('.composer textarea');
    await P[2].keyboard.type('دارم می‌نویسم', { delay: 60 });
    await waitFor(P[3], () => document.querySelector('.chat-head')?.innerText.includes('در حال نوشتن'), null, 'typing indicator');
    await P[2].click('.composer .send-btn[aria-label="ارسال"]');
  });

  await check('group: everyone reacts 👍 to the same message at once → count 6 everywhere', async () => {
    const first = await P[0].$eval('.msg-row[id]', (r) => r.id);
    await all(async (p) => {
      await msgMenu(p, `#${first} .bubble`);
      await p.click('.menu.floating .quick-reactions button');
    });
    await all((p) => waitFor(p, (f) => /۶|6/.test(document.querySelector(`#${f} .reaction`)?.textContent || ''), first, 'six reactions', 20000));
  });

  await check('group: reply, edit and delete show up for everyone', async () => {
    const target = await P[1].$$eval('.msg-row[id]', (rows) => rows.find((r) => r.innerText.includes('ali-1'))?.id);
    await msgMenu(P[4], `#${target} .bubble`, 'پاسخ');
    await typeSend(P[4], 'جواب به علی');
    await all((p) => waitFor(p, () => [...document.querySelectorAll('.msg-row')].some((r) => r.innerText.includes('جواب به علی') && !!r.querySelector('.reply-quote')), null, 'reply with quote'));
    // edit (sara's own last message)
    const mine = await P[1].$$eval('.msg-row[id]', (rows) => rows.filter((r) => r.innerText.includes('sara-5')).map((r) => r.id).pop());
    await msgMenu(P[1], `#${mine} .bubble`, 'ویرایش');
    await P[1].click('.composer textarea');
    await P[1].keyboard.down('Control');
    await P[1].keyboard.press('a');
    await P[1].keyboard.up('Control');
    await P[1].keyboard.type('sara-5 (ویرایش شد)');
    await P[1].click('.composer .send-btn[aria-label="ارسال"]');
    await all((p) => waitFor(p, (id) => document.getElementById(id)?.innerText.includes('ویرایش‌شده'), mine, 'edited label'));
    // delete (maryam's own message)
    const del = await P[3].$$eval('.msg-row[id]', (rows) => rows.filter((r) => r.innerText.includes('maryam-2')).map((r) => r.id).pop());
    await msgMenu(P[3], `#${del} .bubble`, 'حذف');
    await all((p) => waitFor(p, (id) => !document.getElementById(id)?.innerText.includes('maryam-2'), del, 'deleted for everyone'));
  });

  await check('group: a picture sent by one arrives for everyone', async () => {
    const input = await P[5].$('.composer input[type=file]');
    await input.uploadFile(new URL('../../web/public/icon-192.png', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    await waitFor(P[5], () => !!document.querySelector('.modal'), null, 'send dialog');
    await P[5].$$eval('.modal .btn.primary', (els) => els.find((b) => b.textContent.includes('ارسال')).click());
    await all(async (p) => {
      await waitFor(p, () => !!document.querySelector('.msg-row .bubble.has-media'), null, 'picture message arrived', 30000);
      await p.evaluate(() => [...document.querySelectorAll('.msg-row .bubble.has-media')].pop().scrollIntoView());
      await waitFor(p, () => [...document.querySelectorAll('.msg-row .bubble.has-media img')].some((im) => im.naturalWidth > 0), null, 'picture loaded', 30000);
    });
  });

  // ---------- Private chats: a ring of DMs at once ----------
  await check('private chats: six DMs at once, each lands with its receiver (unread badge, then text)', async () => {
    const dms = [];
    for (let i = 0; i < N; i++) dms[i] = (await apis[i]('POST', '/api/chats/dm', { userId: ids[(i + 1) % N] })).chat.id;
    await all(async (p, i) => {
      await openChat(p, dms[i]);
      await typeSend(p, `سلام از ${USERS[i]}`);
    });
    await all(async (p, i) => {
      const from = (i + N - 1) % N;
      await p.evaluate(() => (location.hash = '#/'));
      await waitFor(p, (d) => !!document.querySelector(`.sidebar a[href="#/chat/${d}"] .badge`), dms[from], 'unread badge');
      await openChat(p, dms[from]);
      await waitFor(p, (t) => [...document.querySelectorAll('.msg-row')].some((r) => r.innerText.includes(t)), `سلام از ${USERS[from]}`, 'DM text');
    });
  });

  // ---------- Channel ----------
  const chan = (await apis[0]('POST', '/api/chats', { type: 'channel', title: 'اخبار', isPublic: true })).chat.id;
  await check('channel: five people join from "explore", owner posts, they read it; they can only mute', async () => {
    await Promise.all(
      P.slice(1).map(async (p) => {
        await p.evaluate(() => (location.hash = '#/'));
        await p.click('.menu-btn');
        await clickText(p, '.sidebar .menu > button', 'کاوش');
        await waitFor(p, () => !!document.querySelector('.modal .row-item'), null, 'explore list');
        await p.$$eval('.modal .row-item', (rows) => rows.find((r) => r.innerText.includes('اخبار')).querySelector('.btn').click());
        await waitFor(p, (c) => location.hash === `#/chat/${c}`, chan, 'opened the channel after joining');
      }),
    );
    await openChat(P[0], chan);
    await typeSend(P[0], 'اطلاعیه مهم: جلسه فردا');
    await Promise.all(P.slice(1).map((p) => waitFor(p, () => [...document.querySelectorAll('.msg-row')].some((r) => r.innerText.includes('اطلاعیه مهم')), null, 'post seen')));
    await Promise.all(P.slice(1).map((p) => waitFor(p, () => !!document.querySelector('.channel-mute-bar') && !document.querySelector('.composer textarea'), null, 'mute bar, no message box')));
    const r = await apis[2]('POST', `/api/chats/${chan}/messages`, { text: 'hack' });
    if (r.status !== 403) throw new Error(`subscriber could post (${r.status})`);
    const m = await apis[2]('GET', `/api/chats/${chan}`);
    if (m.members.length !== 1) throw new Error(`subscriber sees ${m.members.length} subscribers`);
  });

  // ---------- Offline and back ----------
  await check('offline: a message written without connection is sent when back online', async () => {
    await openChat(P[2], group);
    expectOffline = true;
    await P[2].setOfflineMode(true);
    await sleep(1500);
    await typeSend(P[2], 'نوشته‌شده در حالت آفلاین');
    await sleep(1500);
    await P[2].setOfflineMode(false);
    await openChat(P[0], group);
    await waitFor(P[0], () => [...document.querySelectorAll('.msg-row')].some((r) => r.innerText.includes('نوشته‌شده در حالت آفلاین')), null, 'queued message delivered', 40000);
    expectOffline = false;
  });

  // ---------- Voice channel with everyone, several streams ----------
  const lobby = (await apis[0]('POST', '/api/chats', { type: 'voice', title: 'اتاق صوتی', isPublic: true })).chat.id;
  await check('voice channel: all six join and see each other', async () => {
    await openChat(P[0], lobby);
    await clickText(P[0], '.voice-banner button', 'شروع');
    await waitFor(P[0], () => !!document.querySelector('.voice-bar .dot.connected'), null, 'owner connected', 30000);
    await Promise.all(
      P.slice(1).map(async (p, k) => {
        await sleep(k * 400);
        await openChat(p, lobby);
        await clickText(p, '.voice-banner button', 'پیوستن');
        await waitFor(p, () => !!document.querySelector('.voice-bar .dot.connected'), null, 'connected', 30000);
      }),
    );
    await all((p) => waitFor(p, () => document.querySelectorAll('.vc-user').length === 6, null, 'six names under the room', 30000));
    await all(async (p) => {
      await p.click('.vbar-info');
      await waitFor(p, () => document.querySelectorAll('.room-view .mtile.person').length === 6, null, 'six tiles', 30000);
    });
  });

  await check('voice channel: three people stream their screens at once, others watch', async () => {
    await Promise.all(
      [1, 2, 3].map(async (i) => {
        const p = P[i];
        await startShare(p, i);
        await waitFor(p, () => !!document.querySelector('.room-view .ctl.on[title="اشتراک صفحه (استریم)"]'), null, 'sharing', 30000);
      }),
    );
    await all((p, i) => (i >= 1 && i <= 3 ? null : waitFor(p, () => document.querySelectorAll('.mtile.screen').length >= 3, null, 'three streams listed', 30000)));
    // two watchers pick a stream
    for (const i of [0, 4]) {
      await waitFor(P[i], () => !!document.querySelector('.watch-btn'), null, 'watch button');
      await P[i].click('.watch-btn');
      await waitFor(P[i], () => [...document.querySelectorAll('.mtile.screen video')].some((v) => v.videoWidth > 0), null, 'stream frames', 30000);
    }
  });

  await check('voice channel: a 4th stream is refused (limit 3 per room) with a message', async () => {
    const p = P[5];
    await startShare(p, 5);
    await waitFor(p, () => (document.querySelector('.toast')?.textContent || '').includes('حداکثر'), null, 'limit message', 30000);
  });

  await check('voice channel: the owner removes one person; everyone sees five', async () => {
    const r = await apis[0]('POST', `/api/rtc/${lobby}/moderate`, { userId: ids[4], action: 'kick' });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
    await waitFor(P[4], () => !document.querySelector('.voice-bar'), null, 'kicked person out');
    await Promise.all([0, 1, 2, 3, 5].map((i) => waitFor(P[i], () => document.querySelectorAll('.room-view .mtile.person').length === 5, null, 'five tiles', 30000)));
  });

  await check('voice channel: everyone leaves; the room is empty for all', async () => {
    await Promise.all(
      [0, 1, 2, 3, 5].map(async (i) => {
        if (await P[i].$('.room-view .ctl.hangup')) await P[i].click('.room-view .ctl.hangup');
      }),
    );
    await all((p) => waitFor(p, () => !document.querySelector('.voice-bar') && document.querySelectorAll('.vc-user').length === 0, null, 'empty room', 30000));
  });

  await check('search: a message is found by its text', async () => {
    const r = await apis[3]('GET', `/api/search?q=${encodeURIComponent('اطلاعیه')}`);
    const found = JSON.stringify(r).includes('اطلاعیه مهم');
    if (!found) throw new Error(`not found (${r.status})`);
  });
} catch (e) {
  problems.push(`stopped: ${e.message}`);
} finally {
  await browser.close().catch(() => {});
}

// ---------- Report ----------
let serverLogErrors = [];
if (SERVER_LOG && fs.existsSync(SERVER_LOG)) {
  serverLogErrors = fs
    .readFileSync(SERVER_LOG, 'utf8')
    .split('\n')
    .filter((l) => /"level":(50|60)/.test(l))
    .map((l) => {
      try {
        const o = JSON.parse(l);
        return `${o.msg || ''} ${o.err?.message || ''} ${o.req?.url || ''}`.trim();
      } catch {
        return l.slice(0, 200);
      }
    });
}
console.log('\n================ CROWD TEST REPORT ================');
console.log(`passed: ${passed.length}   problems: ${problems.length}   time: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const p of problems) console.log(`  ✗ ${p}`);
const uniq = (a) => [...new Set(a)];
console.log(`notes: ${notes.length}`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`page errors: ${pageErrors.length}`);
for (const e of uniq(pageErrors).slice(0, 30)) console.log(`  ! ${e}`);
console.log(`server 5xx responses: ${serverErrors.length}`);
for (const e of uniq(serverErrors).slice(0, 30)) console.log(`  ! ${e}`);
console.log(`server log errors: ${serverLogErrors.length}`);
for (const e of uniq(serverLogErrors).slice(0, 30)) console.log(`  ! ${e}`);
process.exit(problems.length || pageErrors.length || serverErrors.length || serverLogErrors.length ? 1 : 0);
