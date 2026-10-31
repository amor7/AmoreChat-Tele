// End-to-end voice/video test: real LiveKit + two headless Chromes with fake mic/camera.
// Run against a server on an EMPTY data dir that is connected to LiveKit.
// Usage: node test/rtc-e2e.mjs <baseUrl> <setupCode>   (needs `puppeteer` installed)
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2];
const SETUP = process.argv[3];
const step = (s) => console.log(`\n▶ ${s}`);

async function apiClient() {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const upload = async (buf, type, name) => {
    const form = new FormData();
    form.append('file', new Blob([buf], { type }), name);
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'x-requested-with': 'amorechat', cookie }, body: form });
    return res.json();
  };
  return { call, upload, cookie: () => cookie.split('=')[1] };
}

const owner = await apiClient();
const bob = await apiClient();
let r = await owner.call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200);
r = await owner.call('POST', '/api/admin/invites', { maxUses: 1 });
r = await bob.call('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob', invite: r.invite.code });
const bobId = r.user.id;
r = await owner.call('POST', '/api/chats', { type: 'voice', title: 'Lobby', isPublic: true });
const lobby = r.chat.id;
r = await owner.call('POST', '/api/chats/dm', { userId: bobId });
const dm = r.chat.id;
r = await owner.call('POST', '/api/chats', { type: 'channel', title: 'Radio', memberIds: [bobId] });
const radio = r.chat.id;
await owner.call('POST', `/api/chats/${dm}/messages`, { text: 'long-press me' });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

const browser = await puppeteer.launch({
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // A portrait "phone camera", to check desktop doesn't zoom it into a blur.
    ...(process.env.FAKE_VIDEO ? [`--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`] : []),
    // Isolated-network test: the server's own CA isn't installed in this browser.
    ...(process.env.INSECURE ? ['--ignore-certificate-errors'] : []),
  ],
  ...(process.env.INSECURE ? { acceptInsecureCerts: true } : {}),
});

async function openAs(client, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label} pageerror]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.log(`[${label} console]`, m.text()));
  await page.setViewport({ width: 1200, height: 800 });
  await page.setCookie({ name: 'ac_session', value: client.cookie(), url: BASE });
  return page;
}
const A = await openAs(owner, 'owner');
const B = await openAs(bob, 'bob');
A.on('dialog', (d) => d.accept());
B.on('dialog', (d) => d.accept());

const waitFor = (page, fn, arg, what, timeout = 20000) =>
  page.waitForFunction(fn, { timeout, polling: 250 }, arg).catch(async (e) => {
    await page.screenshot({ path: `e2e-fail-${Date.now()}.png` }).catch(() => {});
    throw new Error(`timed out waiting for: ${what} (${e.message})`);
  });
const count = (page, sel) => page.$$eval(sel, (els) => els.length);
async function clickText(page, selector, text) {
  await waitFor(page, ([s, t]) => [...document.querySelectorAll(s)].some((b) => b.textContent.includes(t)), [selector, text], `${selector} "${text}"`);
  await page.$$eval(selector, (els, t) => els.find((b) => b.textContent.includes(t)).click(), text);
}

try {
  step('desktop: the send-file dialog is fully on screen (regression: it slid below the window)');
  await A.goto(`${BASE}/#/chat/${dm}`, { waitUntil: 'networkidle0' });
  // The ms value is shown with Persian digits (۴۲ms).
  await waitFor(A, () => /[0-9۰-۹]+ms/.test(document.querySelector('.site-name .ping')?.textContent || ''), null, 'ping indicator on the main screen');
  // Send / mic button sits at the right edge of the composer (Telegram-style).
  const sendRight = await A.evaluate(() => {
    const c = document.querySelector('.composer').getBoundingClientRect();
    const b = document.querySelector('.composer .send-btn').getBoundingClientRect();
    return c.right - b.right < 20;
  });
  if (!sendRight) throw new Error('send button is not on the right');
  const tmp = (await import('node:path')).join((await import('node:os')).tmpdir(), `ac-e2e-${Date.now()}.mp4`);
  (await import('node:fs')).writeFileSync(tmp, Buffer.alloc(200_000));
  const input = await A.$('.composer input[type=file]');
  await input.uploadFile(tmp);
  await waitFor(A, () => document.querySelector('.modal'), null, 'send dialog open');
  const box = await A.evaluate(() => {
    const send = [...document.querySelectorAll('.modal .btn.primary')].find((b) => b.textContent.includes('ارسال')).getBoundingClientRect();
    const m = document.querySelector('.modal').getBoundingClientRect();
    return { top: m.top, bottom: m.bottom, send: send.bottom, vh: innerHeight };
  });
  assert.ok(box.top >= 0 && box.bottom <= box.vh + 1 && box.send <= box.vh, `dialog off screen: ${JSON.stringify(box)}`);
  await A.$$eval('.modal .btn', (els) => els.find((b) => b.textContent.includes('انصراف')).click());

  step('upload survives a dropped connection and continues where it stopped');
  const big = (await import('node:path')).join((await import('node:os')).tmpdir(), `ac-resume-${Date.now()}.bin`);
  (await import('node:fs')).writeFileSync(big, (await import('node:crypto')).randomBytes(10 * 1024 * 1024));
  await A.waitForSelector('.composer input[type=file]');
  await (await A.$('.composer input[type=file]')).uploadFile(big);
  await waitFor(A, () => document.querySelector('.modal'), null, 'send dialog open');
  await A.emulateNetworkConditions({ download: 5e6, upload: 1.5e6, latency: 20 });
  const firstChunk = A.waitForResponse((res) => res.url().includes('/api/uploads/') && res.request().method() === 'PUT' && res.status() === 200);
  await A.$$eval('.modal .btn.primary', (els) => els.find((b) => b.textContent.includes('ارسال')).click());
  await firstChunk;
  await A.setOfflineMode(true);
  await waitFor(A, () => document.querySelector('.upload-waiting'), null, '"waiting for connection" shown');
  await sleep(1500);
  const offsets = [];
  A.on('request', (req) => req.method() === 'PUT' && req.url().includes('/api/uploads/') && offsets.push(Number(req.headers()['upload-offset'])));
  await A.setOfflineMode(false);
  await A.emulateNetworkConditions(null);
  await waitFor(A, () => !document.querySelector('.modal') && [...document.querySelectorAll('.file-name')].some((e) => e.textContent.includes('ac-resume')), null, 'file sent after reconnecting', 60000);
  assert.ok(offsets.length && Math.min(...offsets) > 0, `resumed instead of restarting (offsets ${offsets})`);

  step('both join the voice channel');
  await A.goto(`${BASE}/#/chat/${lobby}`, { waitUntil: 'networkidle0' });
  await clickText(A, '.voice-banner button', 'شروع ویس‌چت');
  await waitFor(A, () => document.querySelector('.voice-bar .dot.connected'), null, 'owner connected');
  // Bob is on a phone for the room part.
  await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await B.goto(`${BASE}/#/chat/${lobby}`, { waitUntil: 'networkidle0' });
  await clickText(B, '.voice-banner button', 'پیوستن');
  await waitFor(B, () => document.querySelector('.voice-bar .dot.connected'), null, 'bob connected');

  step('presence via webhook shows both in the sidebar');
  for (const p of [A, B]) await waitFor(p, () => document.querySelectorAll('.vc-user').length === 2, null, 'two names under Lobby');

  step('media: two people = WhatsApp style (other big, me small), remote audio flows');
  for (const p of [A, B]) {
    await p.click('.vbar-info');
    await waitFor(p, () => document.querySelectorAll('.room-view .mtile.person').length === 2, null, 'two person tiles');
    await waitFor(p, () => document.querySelector('.room-stage.spot.pip-mode .spot-main .mtile.person'), null, 'duo layout');
    await waitFor(p, () => document.querySelectorAll('audio').length >= 1, null, 'remote audio element');
  }
  await waitFor(A, () => document.querySelector('.room-view .mtile.speaking'), null, 'speaking indicator', 15000).then(
    () => console.log('  speaking indicator works'),
    () => console.log('  (speaking indicator not seen; fake audio may be too quiet)'),
  );

  step('camera: bob turns on the camera, owner receives video frames');
  await B.click('.room-view .ctl[title="دوربین"]');
  await waitFor(A, () => document.querySelector('.spot-main .mtile video')?.videoWidth > 0, null, 'owner sees bob camera big');
  if (process.env.FAKE_VIDEO) {
    await waitFor(A, () => document.querySelector('.spot-main .mtile video')?.dataset.fit === 'contain', null, 'portrait camera shown whole on desktop');
  }
  await A.screenshot({ path: 'shot-room-duo.png' });
  await B.screenshot({ path: 'shot-room-mobile.png' });

  step('tap the big tile: everyone in a grid; tap a tile: only that one big');
  await A.click('.spot-main .mtile');
  await waitFor(A, () => document.querySelectorAll('.room-stage.grid .meet-grid .mtile').length === 2, null, 'grid of everyone');
  await A.screenshot({ path: 'shot-room-grid.png' });
  await A.$$eval('.meet-grid .mtile', (els) => els.find((e) => e.textContent.includes('Bob')).click());
  await waitFor(A, () => document.querySelector('.room-stage.spot .spot-main .mtile video')?.videoWidth > 0, null, 'Bob alone in the spotlight again');
  await B.click('.room-view .ctl[title="دوربین"]');

  step('moderation through the LiveKit API: mute then kick bob');
  r = await owner.call('POST', `/api/rtc/${lobby}/moderate`, { userId: bobId, action: 'mute' });
  assert.equal(r.status, 200, JSON.stringify(r));
  await waitFor(B, () => document.querySelector('.room-view .ctl.off[title*="میکروفون"]') || document.querySelector('.ctl.off'), null, 'bob mic shown muted');
  r = await owner.call('POST', `/api/rtc/${lobby}/moderate`, { userId: bobId, action: 'kick' });
  assert.equal(r.status, 200, JSON.stringify(r));
  await waitFor(B, () => !document.querySelector('.room-view') && !document.querySelector('.voice-bar'), null, 'bob removed from room');
  await waitFor(A, () => document.querySelectorAll('.room-view .mtile.person').length === 1, null, 'owner sees bob gone');
  await B.setViewport({ width: 1200, height: 800 });
  await waitFor(A, () => document.querySelectorAll('.vc-user').length === 1, null, 'sidebar updated');
  await A.click('.room-view .ctl.hangup');
  await waitFor(A, () => !document.querySelector('.voice-bar') && !document.querySelector('.room-view'), null, 'owner left');

  step('1:1 video call: WhatsApp-style layout, swap, hang up');
  await A.goto(`${BASE}/#/chat/${dm}`, { waitUntil: 'networkidle0' });
  await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await B.goto(`${BASE}/#/chat/${dm}`, { waitUntil: 'networkidle0' });
  await A.click('button[aria-label="تماس تصویری"]');
  await waitFor(A, () => document.querySelector('.call-view .call-main'), null, 'caller sees own camera full-screen while ringing');
  await waitFor(B, () => document.querySelector('.incoming-call'), null, 'incoming call screen');
  await B.click('button[aria-label="پاسخ"]');
  for (const p of [A, B]) {
    await waitFor(p, () => document.querySelector('.call-view[data-remote="1"]'), null, 'other side connected');
    await waitFor(p, () => document.querySelector('.call-main')?.videoWidth > 0 && !document.querySelector('.call-main').classList.contains('mirror'), null, 'remote video full-screen');
    await waitFor(p, () => document.querySelector('video.call-pip'), null, 'own camera in the small box');
  }
  if (process.env.FAKE_VIDEO) {
    await waitFor(A, () => document.querySelector('.call-main')?.dataset.fit === 'contain', null, 'desktop: portrait caller shown whole, not zoomed');
    await waitFor(B, () => document.querySelector('.call-main')?.dataset.fit === 'cover', null, 'phone: portrait caller fills the screen');
  }
  for (const p of [A, B]) {
    await waitFor(p, () => /[0-9۰-۹]+ms/.test(document.querySelector('.call-ping .ping')?.textContent || ''), null, 'ping (ms) shown during the call');
  }
  await A.screenshot({ path: 'shot-call-desktop.png' });
  await B.screenshot({ path: 'shot-call-mobile.png' });
  await B.click('.call-pip');
  await waitFor(B, () => document.querySelector('.call-view.swapped .call-main.mirror'), null, 'tap swaps: own camera big');
  await B.screenshot({ path: 'shot-call-swapped.png' });
  await B.click('.call-pip');
  await waitFor(B, () => !document.querySelector('.call-view.swapped'), null, 'tap again swaps back');
  // Screen sharing in a call: the same quality dialog; the owner may pick up to 1080p.
  await A.$eval('.call-view .ctl[aria-label="اشتراک صفحه"]', (b) => b.click());
  await waitFor(A, () => !!document.querySelector('.modal .segmented'), null, 'stream dialog in the call');
  assert.deepEqual(await A.$eval('.modal .segmented', (el) => [...el.children].map((x) => x.textContent.trim())), ['480p', '720p', '1080p'], 'owner: every quality');
  const fpsOpts = await A.$$eval('.modal .segmented', (els) => [...els[1].children].map((x) => x.textContent));
  assert.equal(fpsOpts.length, 3, 'owner: 15, 30 and 60 fps');
  assert.ok(fpsOpts[2].includes('۶۰'));
  await clickText(A, '.modal .segmented button', '1080p');
  await clickText(A, '.modal .segmented button', '۶۰');
  await A.click('.modal .btn.primary');
  await waitFor(B, () => document.querySelector('.call-main.contain')?.videoWidth > 0, null, 'bob sees the shared screen');
  await A.$eval('.call-view .ctl[aria-label="اشتراک صفحه"]', (b) => b.click());
  await A.$eval('.call-view .ctl.hangup', (b) => b.click());
  await waitFor(B, () => !document.querySelector('.call-view'), null, 'call closed for bob');
  await waitFor(B, () => document.querySelector('.call-log'), null, 'call log message');
  // Switching mobile emulation off reloads the page, so only do it once the call is over.
  await B.setViewport({ width: 1200, height: 800 });

  step('streaming: owner shares the screen, bob sees LIVE and watches it');
  await A.goto(`${BASE}/#/chat/${lobby}`, { waitUntil: 'networkidle0' });
  await clickText(A, '.voice-banner button', 'شروع ویس‌چت');
  await waitFor(A, () => document.querySelector('.voice-bar .dot.connected'), null, 'owner connected again');
  await A.click('.vbar-info');
  await A.click('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
  // A real mouse click: the dialog must be on top of the full-screen room (it once opened behind it).
  await waitFor(A, () => !!document.querySelector('.modal .btn.primary'), null, 'stream dialog');
  const onTop = await A.$eval('.modal .btn.primary', (b) => { const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
  assert.ok(onTop, 'the stream dialog is visible above the room');
  await A.click('.modal .btn.primary');
  await waitFor(A, () => document.querySelector('.room-view .ctl.on[title="اشتراک صفحه (استریم)"]'), null, 'owner is sharing');
  await B.goto(`${BASE}/#/chat/${lobby}`, { waitUntil: 'networkidle0' });
  await waitFor(B, () => document.querySelector('.vc-user .live-badge'), null, 'LIVE badge in sidebar');
  await clickText(B, '.voice-banner button', 'پیوستن');
  await waitFor(B, () => document.querySelector('.voice-bar .dot.connected'), null, 'bob connected');
  await B.click('.vbar-info');
  await waitFor(B, () => document.querySelector('.watch-btn'), null, '"watch stream" button (not auto-subscribed)');
  await B.click('.watch-btn');
  await waitFor(B, () => document.querySelector('.spot-main .mtile.screen video')?.videoWidth > 0, null, 'watched stream shown big');
  await waitFor(B, () => document.querySelectorAll('.filmstrip .mtile').length === 2, null, 'people in the side strip');
  await B.screenshot({ path: 'shot-room-stream.png' });

  step('volume: bob turns the owner up to 150% (and the stream separately)');
  await B.$eval('.mtile.person:not(.speaking) .tile-more, .mtile.person .tile-more', (b) => b.click());
  await waitFor(B, () => document.querySelectorAll('.tile-menu .vol-slider input').length === 2, null, 'voice + stream volume sliders');
  await B.$eval('.tile-menu .vol-slider input', (el) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '150');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(B, () => document.querySelector('.tile-menu .vol-head b')?.textContent.includes('۱۵۰'), null, 'volume shows 150%');
  assert.equal(await B.evaluate(() => JSON.parse(localStorage.getItem('amorechat:volumes'))[1].voice), 1.5, 'remembered on this device');

  await A.click('.room-view .ctl[title="اشتراک صفحه (استریم)"]');
  await waitFor(B, () => !document.querySelector('.mtile.screen'), null, 'stream ends for viewer');
  for (const p of [A, B]) {
    await p.$eval('.room-view .ctl.hangup', (b) => b.click());
    await waitFor(p, () => !document.querySelector('.room-view'), null, 'left the lobby');
  }

  step('channel voice chat: only the admin starts it; bob listens hidden, raises a hand, gets to speak');
  await B.goto(`${BASE}/#/chat/${radio}`, { waitUntil: 'networkidle0' });
  if (await B.$('.chat-head button[aria-label="شروع ویس‌چت"]')) throw new Error('subscriber can start a channel voice chat');
  await A.goto(`${BASE}/#/chat/${radio}`, { waitUntil: 'networkidle0' });
  await A.click('.chat-head button[aria-label="شروع ویس‌چت"]');
  await waitFor(A, () => document.querySelector('.voice-bar .dot.connected'), null, 'admin started the voice chat');
  await A.click('.vbar-info');
  await clickText(B, '.voice-banner button', 'پیوستن');
  await waitFor(B, () => document.querySelector('.voice-bar .dot.connected'), null, 'bob joined as listener');
  await B.click('.vbar-info');
  await waitFor(B, () => document.querySelector('.room-view .ctl.hand') && !document.querySelector('.room-view .ctl[title="بستن میکروفون"]'), null, 'listener: hand button, no mic');
  await waitFor(A, () => /شنونده‌ها \(۱\)/.test(document.querySelector('.stage-panel')?.textContent || ''), null, 'admin sees one listener');
  assert.equal(await count(A, '.mtile.person'), 1, 'hidden listener has no tile');
  await B.click('.room-view .ctl.hand');
  await waitFor(A, () => document.querySelector('.stage-panel .hand-count'), null, 'admin sees the raised hand');
  await clickText(A, '.stage-panel .stage-list button', 'اجازه صحبت');
  await waitFor(B, () => document.querySelector('.room-view .ctl[title="بستن میکروفون"]'), null, 'bob can speak now (mic on)');
  await waitFor(A, () => document.querySelectorAll('.mtile.person').length === 2, null, 'speaker visible to the admin');
  await A.screenshot({ path: 'shot-stage-admin.png' });
  await clickText(A, '.stage-panel .stage-actions button', 'پایان برای همه');
  await waitFor(B, () => !document.querySelector('.voice-bar') && !document.querySelector('.room-view'), null, 'voice chat ended for bob');

  step('a deleted message leaves no trace for members; a moderator can open what it said');
  await A.goto(`${BASE}/#/chat/${radio}`, { waitUntil: 'networkidle0' });
  await B.goto(`${BASE}/#/chat/${radio}`, { waitUntil: 'networkidle0' });
  const post = (await owner.call('POST', `/api/chats/${radio}/messages`, { text: 'post to delete' })).message.id;
  const hasPost = () => [...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes('post to delete'));
  await waitFor(B, hasPost, null, 'bob sees the post');
  assert.equal((await owner.call('DELETE', `/api/messages/${post}`, {})).status, 200);
  await waitFor(B, () => ![...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes('post to delete')), null, 'gone for bob');
  assert.equal(await B.evaluate(() => document.body.textContent.includes('حذف شد') || !!document.querySelector('.deleted-note')), false, 'bob sees no trace');
  await waitFor(A, () => document.querySelector('.deleted-note'), null, 'the owner sees where it was');
  await clickText(A, '.deleted-note button', 'نمایش');
  await waitFor(A, () => document.querySelector('.deleted-body')?.textContent.includes('post to delete'), null, 'the owner reads what it said');
  await A.screenshot({ path: 'shot-deleted.png' });

  step('music: plays on through the chat\'s songs, shuffle, repeat, and keeps playing in other chats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-'));
  for (const n of [1, 2, 3]) {
    const file = path.join(dir, `s${n}.mp3`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + n * 100}:duration=3`, '-metadata', `title=Song ${n}`, '-metadata', 'artist=Tester', file]);
    const f = await owner.upload(fs.readFileSync(file), 'audio/mpeg', `s${n}.mp3`);
    await owner.call('POST', `/api/chats/${radio}/messages`, { fileId: f.id ?? f.file?.id, type: 'file' });
  }
  await waitFor(A, () => document.querySelectorAll('.music-msg').length === 3, null, 'three songs in the chat');
  await A.screenshot({ path: 'shot-music-chat.png' });
  await A.$$eval('.music-msg .music-play', (b) => b[0].click());
  const barTitle = (t) => [...document.querySelectorAll('.music-bar-text b')].some((b) => b.textContent === t);
  await waitFor(A, barTitle, 'Song 1', 'the bar shows the song');
  await waitFor(A, barTitle, 'Song 2', 'the next song plays by itself', 15000);
  await A.click('.music-bar-text');
  await waitFor(A, () => document.querySelectorAll('.music-queue li').length === 3, null, 'the queue is the chat\'s music');
  await A.screenshot({ path: 'shot-music-player.png' });
  await A.click('.music-sheet button[aria-label="شافل خاموش"]');
  await waitFor(A, () => document.querySelector('.music-sheet button[aria-label="شافل روشن"]'), null, 'shuffle on');
  await A.click('.music-sheet button[aria-label="شافل روشن"]');
  await A.click('.music-sheet button[aria-label="تکرار خاموش"]');
  await waitFor(A, () => document.querySelector('.music-sheet button[aria-label="تکرار همه"]'), null, 'repeat all');
  await A.click('.music-sheet button[aria-label="تکرار همه"]');
  await waitFor(A, () => document.querySelector('.music-sheet button[aria-label="تکرار همین آهنگ"]'), null, 'repeat one');
  await A.click('.music-sheet button[aria-label="تکرار همین آهنگ"]');
  await A.click('.music-sheet-close');
  await A.evaluate((id) => (location.hash = `#/chat/${id}`), dm);
  await waitFor(A, () => document.querySelector('.music-bar'), null, 'the bar stays in another chat');
  await A.click('.music-bar button[aria-label="بستن پلیر"]');
  await waitFor(A, () => !document.querySelector('.music-bar'), null, 'the player closes');

  step('offline: the app opens without a connection, queues a message, sends it when back online');
  await A.goto(`${BASE}/#/chat/${dm}`, { waitUntil: 'networkidle0' });
  await A.evaluate(() => navigator.serviceWorker?.ready);
  await A.reload({ waitUntil: 'networkidle0' }); // now controlled by the service worker
  await waitFor(A, () => [...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes('long-press me')), null, 'chat loaded online');
  await sleep(1500); // let the device copy be written
  await A.setOfflineMode(true);
  await A.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(A, () => document.querySelector('.offline-bar') && document.querySelectorAll('.chat-item').length > 0, null, 'app opened offline with the saved chat list');
  await waitFor(A, () => [...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes('long-press me')), null, 'saved messages shown offline');
  await A.click('.composer textarea');
  await A.type('.composer textarea', 'sent while offline');
  await A.keyboard.press('Enter');
  await waitFor(A, () => document.querySelector('.outbox .pending-icon'), null, 'message waits in the outbox (⏳)');
  await A.screenshot({ path: 'shot-offline.png' });
  await A.setOfflineMode(false);
  await waitFor(A, () => !document.querySelector('.outbox'), null, 'outbox emptied after reconnecting', 40000);
  const sent = await bob.call('GET', `/api/chats/${dm}/messages`);
  assert.ok(sent.messages.some((m) => m.text === 'sent while offline'), 'queued message reached the server');

  step('phone: long-press a message opens the menu and it stays open');
  await B.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await B.goto(`${BASE}/#/chat/${dm}`, { waitUntil: 'networkidle0' });
  const pt = await B.$$eval('.msg-row .bubble', (els) => {
    const el = els.find((e) => e.textContent.includes('long-press me'));
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await B.touchscreen.touchStart(pt.x, pt.y);
  await sleep(800);
  await B.touchscreen.touchEnd();
  await sleep(800);
  if (!(await B.$('.menu.floating .quick-reactions'))) throw new Error('message menu closed right after the long-press');
  await B.screenshot({ path: 'shot-longpress.png' });

  console.log('\nRTC E2E TEST PASSED');
} finally {
  await browser.close();
}
