// Android app end-to-end test on an emulator (run by .github/workflows/android.yml).
// Needs: adb with a booted emulator, the debug APK, and an AmoreChat server on the host at
// port 3100 with an empty data dir (the emulator reaches the host as 10.0.2.2).
// Usage: node test/android-e2e.mjs <setupCode> <path-to-debug.apk>
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const SETUP = process.argv[2];
const APK = process.argv[3];
const HOST = 'http://127.0.0.1:3100';
const SETUP2 = process.argv[4];
const HOST2 = 'http://127.0.0.1:3101';
const PKG = 'chat.amore.app.debug';
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const adb = (cmd) => execSync(`adb ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (s) => console.log(`\n▶ ${s}`);
let shot = 0;
const screenshot = (name) => execSync(`adb exec-out screencap -p > android-${++shot}-${name}.png`);

async function waitUntil(fn, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > end) {
      try {
        screenshot('fail');
      } catch {
        /* ignore */
      }
      throw new Error(`timed out: ${what}`);
    }
    await sleep(500);
  }
}

function client(base = HOST) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'x-requested-with': 'amorechat', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body && JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
}

// Minimal Chrome DevTools Protocol client for the app's WebView (debug builds enable it).
async function connectPage() {
  const sock = await waitUntil(() => adb('shell cat /proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1], 'WebView devtools socket');
  adb(`forward tcp:9333 localabstract:${sock}`);
  // The visible page (an activity recreated by Android leaves an old, hidden one behind).
  const ws = await waitUntil(async () => {
    const pages = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).filter((t) => t.type === 'page' && t.url.startsWith('http'));
    for (const p of pages.reverse()) {
      const attached = JSON.parse(p.description || '{}');
      if (attached.attached === false || attached.visible === false) continue;
      const w = new WebSocket(p.webSocketDebuggerUrl);
      await new Promise((ok, bad) => ((w.onopen = ok), (w.onerror = bad)));
      return w;
    }
    return null;
  }, 'visible WebView page');
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      waiting.get(d.id)(d);
      waiting.delete(d.id);
    }
  };
  const evaluate = (expression) =>
    new Promise((ok, bad) => {
      const n = ++id;
      // A page that's reloading may never answer: give up after a while so callers retry.
      const t = setTimeout(() => (waiting.delete(n), bad(new Error('devtools timeout'))), 12000);
      waiting.set(n, (d) => {
        clearTimeout(t);
        if (d.result?.exceptionDetails) bad(new Error(d.result.exceptionDetails.text + ' ' + JSON.stringify(d.result.exceptionDetails.exception?.description)));
        else ok(d.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  return { evaluate, close: () => ws.close() };
}

// Reconnects to the current page whenever a call fails (Android may replace the WebView).
async function devtools() {
  let conn = await connectPage();
  return {
    async evaluate(expr) {
      // A slow emulator sometimes drops the DevTools connection: reconnect and try once more
      // (navigations and in-flight reloads are the usual cause, not the app).
      for (let attempt = 1; ; attempt++) {
        try {
          return await conn.evaluate(expr);
        } catch (e) {
          try {
            conn.close();
          } catch {
            /* ignore */
          }
          await sleep(1500);
          conn = await connectPage().catch(() => conn);
          if (attempt >= 2 || !/devtools timeout|closed|not open|ECONN/i.test(e.message)) throw e;
        }
      }
    },
    close: () => conn.close(),
  };
}

// A real tap (adb input) on the element's centre: page px -> screen px, offset by where the WebView sits.
async function tap(dt, selector) {
  const xml = adb('exec-out uiautomator dump /dev/tty');
  const m = xml.match(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]/);
  const [left, top] = m ? [+m[1], +m[2]] : [0, 0];
  const p = JSON.parse(
    await dt.evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, d: devicePixelRatio }); })()`,
    ),
  );
  adb(`shell input tap ${Math.round(left + p.x * p.d)} ${Math.round(top + p.y * p.d)}`);
}

// Active notifications only: dumpsys also lists recently removed ones (archive / history).
const notifications = () => {
  const all = adb('shell dumpsys notification --noredact');
  const cut = all.search(/\n\s*(mArchive|Archive|Notification History|mHistory)/i);
  return cut > 0 ? all.slice(0, cut) : all;
};

// ---------- Accounts ----------
const owner = client();
const bob = client();
let r = await owner('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner', invite: SETUP });
assert.equal(r.status, 200, JSON.stringify(r));
r = await owner('POST', '/api/admin/invites', { maxUses: 1 });
r = await bob('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob', invite: r.invite.code });
const bobId = r.user.id;
const dm = (await owner('POST', '/api/chats/dm', { userId: bobId })).chat.id;

try {
  if (process.env.ISOLATE) {
    adb('root'); // to set the phone's firewall below (restarts adbd: do it before anything else)
    await sleep(4000);
    adb('wait-for-device');
  }

  step('install and open the app pointed at the test server');
  adb(`install -r -g ${APK}`);
  adb(`shell pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
  adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity --es server http://10.0.2.2:3100`);
  let dt = await devtools();
  await waitUntil(() => dt.evaluate("!!document.querySelector('.auth-card')"), 'login screen inside the app');
  assert.equal(await dt.evaluate('typeof window.AmoreAndroid'), 'object', 'native bridge available');
  screenshot('login');

  if (process.env.ISOLATE) {
    // A full shutdown on the phone: only the AmoreChat servers (on the host: 10.0.2.2, and
    // localhost via adb reverse) stay reachable; everything else, DNS included, is refused.
    // Checked from inside the app itself (its own network identity), before and after.
    step('cut the phone off the internet: only the AmoreChat servers stay reachable');
    const probe = (url) => dt.evaluate(`AmoreAndroid.probe(${JSON.stringify(url)})`);
    const before = await probe('https://www.google.com/');
    console.log('   before, google:', before);
    for (const rule of [
      'iptables -I OUTPUT 1 -o lo -j ACCEPT',
      'iptables -I OUTPUT 2 -d 10.0.2.2 -j ACCEPT',
      'iptables -I OUTPUT 3 -j REJECT',
      'ip6tables -I OUTPUT 1 -o lo -j ACCEPT',
      'ip6tables -I OUTPUT 2 -j REJECT',
    ]) {
      adb(`shell ${rule}`);
    }
    const google = await probe('https://www.google.com/');
    const cloudflare = await probe('http://1.1.1.1/');
    let ours;
    for (let i = 0; i < 3 && ours !== 'HTTP 200'; i++) {
      if (i) await sleep(2000);
      ours = await probe('http://10.0.2.2:3100/healthz');
    }
    if (ours !== 'HTTP 200') console.log(adb('shell iptables -S OUTPUT'));
    console.log('   after, google:', google, '| 1.1.1.1:', cloudflare, '| AmoreChat server:', ours);
    assert.match(google, /^ERR/, 'the internet (by name) is unreachable from the app');
    assert.match(cloudflare, /^ERR/, 'the internet (by IP) is unreachable from the app');
    assert.equal(ours, 'HTTP 200', 'the AmoreChat server is still reachable');
  }

  step('sign in (as bob) through the page');
  await dt.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'Str0ng-Pass-77' }) }).then((r) => r.status)`);
  await dt.evaluate('location.reload(), true');
  dt.close();
  dt = await devtools();
  await waitUntil(() => dt.evaluate("!!document.querySelector('.sidebar .chat-item')"), 'chat list loaded');
  const info = JSON.parse(await dt.evaluate('AmoreAndroid.info()'));
  console.log('app info', info);
  assert.equal(info.background, true);
  assert.equal(info.server, 'http://10.0.2.2:3100');
  assert.ok(await dt.evaluate("document.documentElement.classList.contains('android-app')"));
  const pages = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).filter((t) => t.type === 'page');
  console.log('webview pages:', pages.map((p) => `${p.url} ${p.description}`));
  assert.equal(pages.length, 1, 'exactly one WebView page');
  await sleep(3000); // software-rendered emulator: let it paint
  assert.equal(await dt.evaluate("!!document.querySelector('.splash')"), false, 'not stuck on the loading screen');
  // Regression: the long "new login" preview used to make the chat list wider than the phone.
  assert.equal(await dt.evaluate("document.querySelector('.sidebar').getBoundingClientRect().width <= innerWidth + 1"), true, 'chat list fits the screen');
  screenshot('chats');

  step('background connection: the service is running');
  await waitUntil(() => /NotifyService/.test(adb(`shell dumpsys activity services ${PKG}`)), 'NotifyService running');
  await waitUntil(() => notifications().includes('متصل'), '"connected" status notification');

  step('app in the background: a new message shows a system notification');
  adb('shell input keyevent KEYCODE_HOME');
  await sleep(1500);
  await owner('POST', `/api/chats/${dm}/messages`, { text: 'پیام آزمایشی از اپ' });
  await waitUntil(() => notifications().includes('پیام آزمایشی از اپ'), 'message notification posted');
  screenshot('message-notification');

  step('incoming call rings with a full-screen call notification; ends when cancelled');
  r = await owner('POST', '/api/calls', { userId: bobId, video: false });
  assert.equal(r.status, 200, JSON.stringify(r));
  await waitUntil(() => notifications().includes('تماس صوتی ورودی'), 'call notification posted');
  screenshot('call-notification');
  await owner('POST', `/api/calls/${r.call.id}/end`);
  await waitUntil(() => !notifications().includes('تماس صوتی ورودی'), 'call notification removed');

  step('opening the app clears message notifications');
  adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity`);
  await waitUntil(() => !notifications().includes('پیام آزمایشی از اپ'), 'notification cleared');

  step('profile shows the notification connection as connected');
  dt = await devtools();
  await waitUntil(async () => {
    const i = JSON.parse(await dt.evaluate('AmoreAndroid.info()'));
    return i.connected === true && i.status === 'متصل';
  }, 'status "connected" reported to the page');

  step("phone Back goes step by step: profile popup, then chat, then chat list");
  await dt.evaluate("location.hash = '#/', true");
  await waitUntil(() => dt.evaluate("!!document.querySelector('.sidebar .chat-item')"), 'chat list');
  await tap(dt, `.sidebar a.chat-item[href="#/chat/${dm}"]`);
  await waitUntil(() => dt.evaluate("!!document.querySelector('.chat-head .chat-head-info')"), 'chat opened');
  // The back arrow sits on the left of the header (RTL) and points left.
  assert.equal(await dt.evaluate("(() => { const b = document.querySelector('.chat-head .back').getBoundingClientRect(); return b.width > 0 && b.right < innerWidth / 2; })()"), true, 'back arrow on the left');
  await tap(dt, '.chat-head .chat-head-info');
  await waitUntil(() => dt.evaluate("!!document.querySelector('.modal')"), 'profile popup open');
  screenshot('back-1-popup');
  adb('shell input keyevent KEYCODE_BACK');
  await waitUntil(() => dt.evaluate("!document.querySelector('.modal')"), 'Back closed the popup');
  await sleep(800);
  assert.equal(await dt.evaluate('location.hash'), `#/chat/${dm}`, 'still in the chat after closing the popup');
  adb('shell input keyevent KEYCODE_BACK');
  await waitUntil(async () => !(await dt.evaluate('location.hash')).startsWith('#/chat/'), 'Back returned to the chat list');
  assert.equal(await dt.evaluate("!!document.querySelector('.sidebar .chat-item')"), true, 'chat list visible');
  screenshot('back-2-list');

  step('share a file from another app into AmoreChat and send it');
  adb(`shell mkdir -p /sdcard/Android/data/${PKG}/files`);
  adb(`shell "echo hello-share > /sdcard/Android/data/${PKG}/files/share-test.txt"`);
  adb(`shell am start -a android.intent.action.SEND -t text/plain --eu android.intent.extra.STREAM content://${PKG}.files/files/share-test.txt -n ${PKG}/chat.amore.app.MainActivity`);
  await waitUntil(() => dt.evaluate("[...document.querySelectorAll('.share-file')].some((e) => e.textContent.includes('share-test.txt'))"), 'share target picker with the file');
  screenshot('share-picker');
  await dt.evaluate("[...document.querySelectorAll('.modal .row-item')].find((b) => b.textContent.includes('Owner')).click(), true");
  await waitUntil(() => dt.evaluate("[...document.querySelectorAll('.modal .file-name')].some((e) => e.textContent.includes('share-test.txt'))"), 'send dialog with the shared file');
  await dt.evaluate("[...document.querySelectorAll('.modal .btn.primary')].find((b) => b.textContent.includes('ارسال')).click(), true");
  await waitUntil(async () => (await owner('GET', `/api/chats/${dm}/messages`)).messages.some((m) => m.file?.name === 'share-test.txt'), 'shared file arrived in the chat');

  step('in-app update: downloads the APK from the server and opens Android installer');
  adb(`shell appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`);
  await dt.evaluate('AmoreAndroid.installUpdate(), true');
  await waitUntil(() => /packageinstaller/i.test(adb('shell dumpsys activity activities | grep -i -E "topResumedActivity|mResumedActivity"')), 'package installer opened');
  screenshot('installer');
  adb('shell input keyevent KEYCODE_BACK');

  if (SETUP2) {
    step('second server: add it and sign in; the first one stays signed in');
    const owner2 = client(HOST2);
    const bob2 = client(HOST2);
    r = await owner2('POST', '/api/auth/register', { username: 'zahra', password: 'Str0ng-Pass-77', displayName: 'Zahra', invite: SETUP2 });
    assert.equal(r.status, 200, JSON.stringify(r));
    r = await owner2('POST', '/api/admin/invites', { maxUses: 1 });
    r = await bob2('POST', '/api/auth/register', { username: 'bob', password: 'Str0ng-Pass-77', displayName: 'Bob 2', invite: r.invite.code });
    const dm2 = (await owner2('POST', '/api/chats/dm', { userId: r.user.id })).chat.id;
    adb(`shell am force-stop ${PKG}`);
    // Another host name than the first server (cookies are per host, not per port).
    adb('reverse tcp:3101 tcp:3101');
    adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity --es server http://localhost:3101`);
    dt = await devtools();
    await waitUntil(() => dt.evaluate("location.host === 'localhost:3101' && !!document.querySelector('.auth-card')"), 'login screen of the second server');
    await dt.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'Str0ng-Pass-77' }) }).then((r) => r.status)`);
    await dt.evaluate('location.reload(), true');
    await waitUntil(() => dt.evaluate("location.host === 'localhost:3101' && !!document.querySelector('.sidebar .chat-item')"), 'second server chat list');
    const servers = JSON.parse(await dt.evaluate('AmoreAndroid.servers()'));
    assert.equal(servers.length, 2, JSON.stringify(servers));
    await waitUntil(() => notifications().includes('متصل به 2 سرور'), 'background connection to both servers');

    step('back on the first server: a message on the second one still notifies');
    await dt.evaluate("AmoreAndroid.switchServer('http://10.0.2.2:3100'), true");
    await waitUntil(() => dt.evaluate("location.host === '10.0.2.2:3100' && !!document.querySelector('.sidebar .chat-item')"), 'first server shown again, still signed in');
    await owner2('POST', `/api/chats/${dm2}/messages`, { text: 'پیام از سرور دوم' });
    await waitUntil(() => notifications().includes('پیام از سرور دوم'), 'notification from the other server');
    await waitUntil(async () => JSON.parse(await dt.evaluate('AmoreAndroid.servers()')).find((x) => x.url.endsWith(':3101')).unread > 0, 'unread badge for the other server');
    screenshot('multi-server');

    step('menu → "add another server": the add page stays open (it used to bounce back)');
    await dt.evaluate("document.querySelector('.menu-btn').click(), true");
    await waitUntil(() => dt.evaluate("!!document.querySelector('.server-switcher')"), 'server switcher in the menu');
    await dt.evaluate("[...document.querySelectorAll('.server-switcher button')].find((b) => b.textContent.includes('افزودن')).click(), true");
    await waitUntil(() => dt.evaluate("location.href.startsWith('file:') && !!document.getElementById('addr')"), 'add-server page');
    await sleep(3000);
    assert.equal(await dt.evaluate("location.href.startsWith('file:') && !!document.getElementById('addr')"), true, 'still on the add-server page');
    await dt.evaluate("document.getElementById('cancelAdd').click(), true");
    await waitUntil(() => dt.evaluate("location.host === '10.0.2.2:3100' && !!document.querySelector('.sidebar .chat-item')"), 'back on the first server');

    step('signed out on one server: the sign-in page also offers the other server');
    await dt.evaluate("fetch('/api/auth/logout', { method: 'POST', headers: { 'x-requested-with': 'amorechat' } }).then(() => location.reload()), true");
    await waitUntil(() => dt.evaluate("!!document.querySelector('.auth-card') && [...document.querySelectorAll('.app-servers button')].some((b) => b.textContent.includes('localhost'))"), 'other server offered on the sign-in page');
    screenshot('signed-out-servers');
    await dt.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'Str0ng-Pass-77' }) }).then(() => location.reload()), true`);
    await waitUntil(() => dt.evaluate("location.host === '10.0.2.2:3100' && !!document.querySelector('.sidebar .chat-item')"), 'signed in again on the first server');

    step('leave the second server completely: removed, signed out there, notifications stop');
    const sessionsBefore = (await bob2('GET', '/api/me/sessions')).sessions.length;
    await dt.evaluate("AmoreAndroid.removeServer('http://localhost:3101'), true");
    await waitUntil(async () => JSON.parse(await dt.evaluate('AmoreAndroid.servers()')).length === 1, 'only the first server left');
    await waitUntil(async () => (await bob2('GET', '/api/me/sessions')).sessions.length === sessionsBefore - 1, 'the phone signed out on the second server').catch((e) => {
      console.log(adb('logcat -d -s AmoreChat:I'));
      throw e;
    });
    await waitUntil(() => !notifications().includes('متصل به 2 سرور'), 'background connection to one server only');
  }

  step('reboot-free restart: service survives the activity being closed');
  adb(`shell am force-stop ${PKG}`);
  adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity`);
  await waitUntil(() => /NotifyService/.test(adb(`shell dumpsys activity services ${PKG}`)), 'service restarted with the app');

  step('app lock with a real screen lock: no crash, unlocks with the phone PIN');
  adb('shell locksettings set-pin 1111');
  dt = await devtools();
  await waitUntil(() => dt.evaluate("!!document.querySelector('.sidebar')"), 'app ready');
  adb('logcat -c');
  await dt.evaluate('AmoreAndroid.setAppLock(true), true');
  await sleep(3000);
  screenshot('lock-prompt');
  const crash = adb('logcat -d -s AndroidRuntime:E');
  assert.ok(!/FATAL EXCEPTION/.test(crash), `app crashed:\n${crash}`);
  assert.ok(adb(`shell pidof ${PKG}`).trim(), 'app still running');
  adb('shell input text 1111');
  adb('shell input keyevent KEYCODE_ENTER');
  await waitUntil(async () => (await dt.evaluate('AmoreAndroid.appLock()')) === true, 'lock turned on after confirming the PIN');
  adb('shell locksettings clear --old 1111');

  console.log('\nANDROID E2E TEST PASSED');
} catch (e) {
  console.error(e);
  try {
    // Section headers of dumpsys, to see where things are listed
    const lines = adb('shell dumpsys notification --noredact').split('\n');
    console.log(lines.filter((l) => /^ {0,4}\S/.test(l)).slice(0, 80).join('\n'));
  } catch {
    /* ignore */
  }
  try {
    console.log(adb('logcat -d -t 300 AndroidRuntime:E chromium:W *:S'));
  } catch {
    /* ignore */
  }
  process.exit(1);
}
process.exit(0);
