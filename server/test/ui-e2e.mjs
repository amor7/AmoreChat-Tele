// UI test in a real (headless) Chrome: every menu item does what it says, dialogs stay open,
// and Back closes things step by step. Run against a server on an EMPTY data dir.
// Usage: node test/ui-e2e.mjs <baseUrl> <setupCode>   (needs `puppeteer` installed)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const step = (s) => console.log(`\n▶ ${s}`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function apiClient() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'x-requested-with': 'amorechat', 'x-forwarded-for': `10.9.0.${Math.floor(Math.random() * 200)}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return { call, cookie: () => cookie.split('=')[1] };
}

const owner = apiClient();
const bob = apiClient();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
r = await owner.call('POST', '/api/admin/invites', { maxUses: 1 });
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob', invite: r.invite.code });
const bobId = r.user.id;
const dm = (await owner.call('POST', '/api/chats/dm', { userId: bobId })).chat.id;
const group = (await owner.call('POST', '/api/chats', { type: 'group', title: 'Team', memberIds: [bobId] })).chat.id;
await bob.call('POST', `/api/chats/${dm}/messages`, { text: 'menu me' });
await owner.call('POST', `/api/chats/${group}/messages`, { text: 'group hello' });

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const errors = [];
const page = await browser.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.dismiss());
await page.setCookie({ name: 'ac_session', value: owner.cookie(), url: BASE });

const waitFor = (fn, arg, what, timeout = 10000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }, arg).catch(async (e) => {
    await page.screenshot({ path: `ui-fail-${Date.now()}.png` }).catch(() => {});
    throw new Error(`timed out waiting for: ${what} (${e.message})`);
  });
const modalTitle = () => page.evaluate(() => document.querySelector('.modal')?.querySelector('h2,h3')?.textContent || null);
// A real mouse click (user activation, like a finger) on the element with this text.
async function clickText(selector, text) {
  await waitFor(([s, t]) => [...document.querySelectorAll(s)].some((b) => b.textContent.trim().includes(t)), [selector, text], `${selector} "${text}"`);
  const handles = await page.$$(selector);
  for (const h of handles) if ((await h.evaluate((e) => e.textContent.trim())).includes(text)) return h.click();
}
// The dialog must still be open a moment later (not closed again by a late history step).
async function expectModalStays(what) {
  await waitFor(() => !!document.querySelector('.modal'), null, `${what}: dialog opens`);
  await sleep(1200);
  assert.ok(await modalTitle(), `${what}: dialog stays open`);
}
async function backCloses(what) {
  const hash = await page.evaluate(() => location.hash);
  await page.goBack().catch(() => {}); // same-document: resolves null or times out harmlessly
  await waitFor(() => !document.querySelector('.modal') && !document.querySelector('.menu.floating, .sidebar .menu'), null, `${what}: Back closes it`);
  await sleep(300);
  assert.equal(await page.evaluate(() => location.hash), hash, `${what}: Back stays on the same page`);
}

for (const [label, viewport] of [
  ['desktop', { width: 1200, height: 800 }],
  ['phone', { width: 390, height: 844, isMobile: true, hasTouch: false }],
]) {
  await page.setViewport(viewport);
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
  await waitFor(() => document.querySelectorAll('.sidebar .chat-item').length >= 2, null, 'chat list');

  step(`${label}: every item of the main (hamburger) menu works`);
  const items = await (async () => {
    await page.click('.menu-btn');
    await waitFor(() => !!document.querySelector('.sidebar .menu'), null, 'main menu');
    const list = await page.$$eval('.sidebar .menu > button', (b) => b.map((x) => x.textContent.trim()));
    await page.click('.menu-btn');
    return list;
  })();
  console.log('   items:', items.join(' | '));
  assert.ok(items.length >= 4, 'menu has items');
  for (const item of items) {
    if (/خروج/.test(item)) continue;
    await page.click('.menu-btn');
    await clickText('.sidebar .menu > button', item);
    await expectModalStays(item);
    console.log(`   ${item} → ${await modalTitle()}`);
    await backCloses(item);
  }
  // The menu itself: Back closes it.
  await page.click('.menu-btn');
  await waitFor(() => !!document.querySelector('.sidebar .menu'), null, 'main menu');
  await backCloses('main menu');

  step(`${label}: chat list menu (right-click / long-press)`);
  const item = await page.$(`.sidebar a.chat-item[href="#/chat/${group}"]`);
  await item.click({ button: 'right' });
  await waitFor(() => !!document.querySelector('.menu.floating'), null, 'chat menu');
  await sleep(500);
  await clickText('.menu.floating button', 'پوشه جدید');
  await expectModalStays('new folder from chat menu');
  await backCloses('new folder dialog');

  step(`${label}: open a chat from the list; message menu items`);
  await page.click(`.sidebar a.chat-item[href="#/chat/${dm}"]`);
  await waitFor((id) => location.hash === `#/chat/${id}` && !!document.querySelector('.msg-row .bubble'), dm, 'chat with a message');
  for (const action of ['فوروارد', 'پاسخ']) {
    const bubble = await page.$('.msg-row .bubble');
    await bubble.click({ button: 'right' });
    await waitFor(() => !!document.querySelector('.menu.floating'), null, 'message menu');
    await sleep(500);
    await clickText('.menu.floating > button', action);
    if (action === 'فوروارد') {
      await expectModalStays('forward');
      await backCloses('forward dialog');
    } else {
      await waitFor(() => !document.querySelector('.menu.floating'), null, 'menu closed after reply');
      assert.ok(await page.evaluate(() => document.querySelector('.composer-wrap')?.textContent.includes('menu me')), 'replying to the message');
    }
  }

  step(`${label}: chat profile, then Back steps: profile → chat → list`);
  if (label === 'phone') {
    const back = await page.$eval('.chat-head .back', (e) => {
      const r = e.getBoundingClientRect();
      return { w: r.width, right: r.right };
    });
    assert.ok(back.w > 0 && back.right < viewport.width / 2, 'back arrow is on the left');
  }
  await page.click('.chat-head .chat-head-info');
  await expectModalStays('chat profile');
  await backCloses('chat profile');
  await page.goBack().catch(() => {});
  await waitFor(() => !location.hash.startsWith('#/chat/'), null, 'Back from the chat returns to the list');
}

step('phone: sending keeps the keyboard (focus) and jumps to the latest message, in order');
for (let i = 1; i <= 40; i++) await owner.call('POST', `/api/chats/${group}/messages`, { text: `old ${i}` });
await page.goto(`${BASE}/#/chat/${group}`, { waitUntil: 'networkidle2' });
await waitFor(() => document.querySelectorAll('.msg-row').length > 30, null, 'long chat');
await page.evaluate(() => {
  document.querySelector('.messages').scrollTop = 0;
  window.__blurs = 0;
  document.querySelector('.composer textarea').addEventListener('blur', () => window.__blurs++);
});
await sleep(800); // older pages may load; still far from the end
await page.click('.composer textarea');
for (const t of ['first', 'second', 'third']) {
  await page.keyboard.type(t);
  await page.click('.composer .send-btn[aria-label="ارسال"]');
}
await waitFor(() => [...document.querySelectorAll('.msg-row')].at(-1)?.innerText.includes('third'), null, 'last message shown');
await sleep(500);
const after = await page.evaluate(() => {
  const l = document.querySelector('.messages');
  return {
    blurs: window.__blurs,
    focused: document.activeElement?.tagName,
    box: document.querySelector('.composer textarea').value,
    fromBottom: l.scrollHeight - l.scrollTop - l.clientHeight,
    last3: [...document.querySelectorAll('.msg-row')].slice(-3).map((r) => r.innerText.split('\n')[0]),
  };
});
console.log('  ', JSON.stringify(after));
assert.equal(after.blurs, 0, 'the text box never lost focus (keyboard stays open)');
assert.equal(after.focused, 'TEXTAREA');
assert.equal(after.box, '', 'box emptied');
assert.ok(after.fromBottom < 5, 'scrolled to the latest message');
assert.deepEqual(after.last3, ['first', 'second', 'third'], 'sent in order');

step('channel subscriber: Mute / Unmute button where the message box would be (like Telegram)');
const news = (await bob.call('POST', '/api/chats', { type: 'channel', title: 'News', isPublic: true })).chat.id;
await bob.call('POST', `/api/chats/${news}/messages`, { text: 'first post' });
await owner.call('POST', `/api/chats/${news}/join`);
await page.goto(`${BASE}/#/chat/${news}`, { waitUntil: 'networkidle2' });
await waitFor(() => document.querySelector('.channel-mute-bar')?.textContent.includes('بی‌صدا کردن'), null, 'mute button');
assert.equal(await page.evaluate(() => !!document.querySelector('.composer textarea')), false, 'no message box for subscribers');
await page.click('.channel-mute-bar');
await waitFor(() => document.querySelector('.channel-mute-bar')?.textContent.includes('صدادار کردن'), null, 'muted');
const mutedOnServer = Object.values((await owner.call('GET', '/api/chats')).chats).find((c) => c.id === news)?.notifyMutedUntil;
assert.ok(mutedOnServer > Date.now(), 'saved on the server');
await page.click('.channel-mute-bar');
await waitFor(() => document.querySelector('.channel-mute-bar')?.textContent.includes('بی‌صدا کردن'), null, 'unmuted');

if (process.env.APK_DIR) {
  step('Android app: update bar with the exact version, progress, what\'s new, and a close button');
  const app = await browser.newPage();
  app.on('pageerror', (e) => errors.push(e.message));
  await app.setViewport({ width: 390, height: 844, isMobile: true });
  // A stand-in for the app's native bridge: an old installed version, and an update that
  // reports progress the way Updater.java does.
  await app.evaluateOnNewDocument(() => {
    const emit = (e) => {
      (window.__amoreQ = window.__amoreQ || []).push(e);
      window.dispatchEvent(new Event('amore-native'));
    };
    window.AmoreAndroid = {
      info: () => JSON.stringify({ version: '0.8.0', versionCode: 800, background: false, server: location.origin }),
      installUpdate: () => {
        window.__installs = (window.__installs || 0) + 1;
        setTimeout(() => emit({ type: 'update', state: 'progress', percent: 42 }), 200);
      },
    };
  });
  await app.setCookie({ name: 'ac_session', value: owner.cookie(), url: BASE });
  await app.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
  const bar = () => app.evaluate(() => document.querySelector('.update-bar')?.innerText.replace(/\s+/g, ' ') || null);
  await app.waitForFunction(() => !!document.querySelector('.update-bar'), { timeout: 10000 });
  const text = await bar();
  console.log('   bar:', text);
  assert.ok(!/ناعدد|NaN/.test(text), 'no "NaN" in the version');
  const ver = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  assert.ok(text.includes(ver), `bar shows the exact version ${ver}`);
  // What's new
  await app.click('.update-bar [aria-label="تغییرات"]');
  await app.waitForFunction(() => document.querySelectorAll('.modal .release-notes li').length > 0, { timeout: 5000 });
  await app.goBack().catch(() => {});
  await app.waitForFunction(() => !document.querySelector('.modal'), { timeout: 5000 });
  // Update: progress shows in the bar
  await app.click('.update-bar .update-main');
  await app.waitForFunction(() => document.querySelector('.update-bar')?.innerText.includes('۴۲'), { timeout: 5000 });
  assert.equal(await app.evaluate(() => window.__installs), 1);
  console.log('   while downloading:', await bar());
  // Close: hidden, and stays hidden after a reload (until a newer version or 3 days)
  await app.reload({ waitUntil: 'networkidle2' });
  await app.waitForFunction(() => !!document.querySelector('.update-bar [aria-label="بستن"]'), { timeout: 10000 });
  await app.click('.update-bar [aria-label="بستن"]');
  await app.waitForFunction(() => !document.querySelector('.update-bar'), { timeout: 5000 });
  await app.reload({ waitUntil: 'networkidle2' });
  await sleep(1500);
  assert.equal(await bar(), null, 'closed bar stays closed');
  await app.close();
}

step('server unreachable (requests hang, like a domain that no longer resolves): opens offline, no endless "loading"');
await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' });
await waitFor(() => document.querySelectorAll('.sidebar .chat-item').length >= 2, null, 'chats saved on the device');
await sleep(1500);
// Without the service worker in between, so every request really goes through the interception.
await page.setBypassServiceWorker(true);
await page.setRequestInterception(true);
const stalled = [];
const onRequest = (req) => {
  if (req.isInterceptResolutionHandled()) return;
  if (new URL(req.url()).pathname.startsWith('/api/') || req.url().includes('/socket.io/')) stalled.push(req); // never answered
  else req.continue().catch(() => {});
};
page.on('request', onRequest);
const t0 = Date.now();
await page.reload({ waitUntil: 'domcontentloaded' });
await waitFor(() => document.querySelectorAll('.sidebar .chat-item').length >= 2, null, 'offline mode with the saved chats', 20000);
console.log(`   opened offline after ${Math.round((Date.now() - t0) / 1000)}s`);
page.off('request', onRequest);
await Promise.all(stalled.map((r) => r.abort().catch(() => {})));
await page.setRequestInterception(false);
await page.setBypassServiceWorker(false);

step('no JavaScript errors on the page');
assert.deepEqual(errors, [], 'page errors');
await browser.close();
console.log('\nUI test passed');
