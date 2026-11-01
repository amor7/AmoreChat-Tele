// The Android app for hours on an emulator (.github/workflows/soak.yml): one person on the app while
// others send from the server's API. Messages in front and in the background, photos, music with
// the screen off, calls ringing, rotating, losing the network, the app killed and reopened. Every
// problem goes in soak-android/report.md.
// Usage: HOURS=1 node test/soak-android.mjs <setupCode> <path-to-debug.apk>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

const SETUP = process.argv[2];
const APK = process.argv[3];
const HOURS = Number(process.env.HOURS || 1);
const HOST = 'http://127.0.0.1:3100';
const PKG = 'chat.amore.app.debug';
const OUT = path.resolve('soak-android');
const PASS = 'Str0ng-Pass-77';
const END = Date.now() + HOURS * 3600e3;
const started = Date.now();
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const adb = (cmd) => execSync(`adb ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
const log = (...a) => console.log(`[${((Date.now() - started) / 60000).toFixed(1)}m]`, ...a);
const word = () => `w${crypto.randomBytes(4).toString('hex')}`;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const issues = new Map();
const stats = { actions: {}, failed: {}, memory: [] };
let shots = 0;
function shot() {
  if (shots >= 150) return null;
  const f = `android-${++shots}.png`;
  try {
    execSync(`adb exec-out screencap -p > ${JSON.stringify(path.join(OUT, f))}`, { timeout: 30000 });
    return f;
  } catch {
    return null;
  }
}
function issue(severity, area, text) {
  const key = `${area}|${String(text).replace(/\d{2,}/g, 'N').slice(0, 200)}`;
  const i = issues.get(key);
  if (i) return void i.count++;
  issues.set(key, { severity, area, text: String(text).slice(0, 1200), count: 1, shot: shot() });
  log(`!! [${severity}] ${area}: ${String(text).slice(0, 200)}`);
}
function report() {
  const list = [...issues.values()].sort((a, b) => a.severity.localeCompare(b.severity) || b.count - a.count);
  const md = [
    `# Android soak: ${((Date.now() - started) / 3600e3).toFixed(2)} of ${HOURS} hours`,
    '',
    '## Problems',
    ...list.map((i) => `- **${i.severity}** \`${i.area}\` ×${i.count}: ${i.text}${i.shot ? ` (${i.shot})` : ''}`),
    list.length ? '' : 'None.',
    '## Actions',
    '| action | done | failed |',
    '|---|---|---|',
    ...Object.entries(stats.actions).sort().map(([k, n]) => `| ${k} | ${n} | ${stats.failed[k] || 0} |`),
    '',
    `App memory (MB) by the hour: ${stats.memory.filter((_, i) => i % 12 === 0).join(', ')}`,
  ];
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
}

function client() {
  let cookie = '';
  const call = async (method, url, body, form) => {
    const res = await fetch(HOST + url, { method, signal: AbortSignal.timeout(120000), headers: { 'x-requested-with': 'amorechat', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: form || (body && JSON.stringify(body)) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { http: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return call;
}
const ok = (r, what) => {
  if (r.http < 200 || r.http >= 300) throw new Error(`${what}: ${r.http} ${r.error || ''}`);
  return r;
};
async function until(fn, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(600);
  }
}

// The app's WebView, through DevTools.
let page = null;
async function connect() {
  const sock = await until(() => adb('shell cat /proc/net/unix').match(/@(webview_devtools_remote_\d+)/)?.[1], 'WebView debugging socket', 60000);
  adb(`forward tcp:9333 localabstract:${sock}`);
  const target = await until(async () => (await (await fetch('http://127.0.0.1:9333/json/list')).json()).filter((t) => t.type === 'page' && t.url.startsWith('http')).at(-1), 'WebView page', 60000);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((yes, no) => ((ws.onopen = yes), (ws.onerror = no)));
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (waiting.has(d.id)) waiting.get(d.id)(d);
    if (d.method === 'Runtime.exceptionThrown') issue('high', 'page-crash', d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
  };
  const send = (method, params) =>
    new Promise((yes, no) => {
      const n = ++id;
      const t = setTimeout(() => (waiting.delete(n), no(new Error('devtools timeout'))), 20000);
      waiting.set(n, (d) => {
        clearTimeout(t);
        waiting.delete(n);
        yes(d);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send('Runtime.enable', {});
  page = {
    ws,
    async evaluate(expression) {
      const d = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || d.result.exceptionDetails.text);
      return d.result?.result?.value;
    },
  };
}
const ev = async (expr) => {
  try {
    return await page.evaluate(expr);
  } catch (e) {
    if (!/devtools timeout|closed|CLOSED|not open|OPEN/.test(e.message)) throw e;
    await connect();
    return page.evaluate(expr);
  }
};
const notifications = () => {
  const all = adb('shell dumpsys notification --noredact');
  const cut = all.search(/\n\s*(mArchive|Archive|Notification History|mHistory)/i);
  return cut > 0 ? all.slice(0, cut) : all;
};
const foreground = async () => {
  adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity`);
  await sleep(1500);
};
const open = async (chat) => {
  await ev(`location.hash = '#/chat/${chat}', true`);
  await until(() => ev("!!document.querySelector('.chat-head')"), 'chat open in the app');
  await sleep(500);
};

// ---------- People ----------
const owner = client();
const app = client();
ok(await owner('POST', '/api/auth/register', { username: 'owner', password: PASS, displayName: 'Owner', invite: SETUP }), 'owner');
ok(await owner('PATCH', '/api/admin/settings', { registration_mode: 'open' }), 'open');
const appId = ok(await app('POST', '/api/auth/register', { username: 'phone', password: PASS, displayName: 'Phone' }), 'register').user.id;
const dm = ok(await owner('POST', '/api/chats/dm', { userId: appId }), 'dm').chat.id;
ok(await owner('POST', `/api/chats/${dm}/messages`, { text: 'شروع' }), 'hello');
const channel = ok(await owner('POST', '/api/chats', { type: 'channel', title: 'موزیک', memberIds: [appId] }), 'channel').chat.id;

const say = async (text) => ok(await owner('POST', `/api/chats/${dm}/messages`, { text }), 'say');
const fx = {};
async function uploadFile(file, type) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  const r = await owner('POST', '/api/upload', null, form);
  return ok(r, 'upload').id ?? r.file?.id;
}
const dir = fs.mkdtempSync(path.join(OUT, 'fx-'));
fx.png = path.join(dir, 'p.png');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', fx.png]);
fx.song = path.join(dir, 'Artist - Long Song.mp3');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=440', '-t', '120', fx.song]);

const acts = {
  async messageInFront() {
    await foreground();
    await open(dm);
    const t = word();
    await say(t);
    await until(() => ev(`[...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes(${JSON.stringify(t)}))`), 'message shown in the open chat');
  },
  async messageInBackground() {
    await foreground();
    adb('shell input keyevent KEYCODE_HOME');
    await sleep(2000);
    const t = word();
    await say(t);
    await until(() => notifications().includes(t), 'notification for a message with the app closed', 45000);
    await foreground();
    await until(() => !notifications().includes(t), 'notification gone after opening the app', 20000);
  },
  async sendFromApp() {
    await foreground();
    await open(dm);
    const t = word();
    await ev(`(() => { const e = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, ${JSON.stringify(t)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await ev(`document.querySelector('.composer button[aria-label="ارسال"]').click(), true`);
    await until(async () => (await owner('GET', `/api/chats/${dm}/messages?limit=50`)).messages?.some((m) => m.text === t), 'message from the app arrives');
  },
  async photo() {
    await foreground();
    await open(dm);
    const fileId = await uploadFile(fx.png, 'image/png');
    ok(await owner('POST', `/api/chats/${dm}/messages`, { fileId, type: 'image' }), 'photo');
    await until(() => ev(`[...document.querySelectorAll('.bubble img')].some((i) => i.complete && i.naturalWidth > 0)`), 'photo shown in the app', 45000);
  },
  async musicScreenOff() {
    await foreground();
    await open(channel);
    if (!(await ev("!!document.querySelector('.music-msg .music-play')"))) {
      const fileId = await uploadFile(fx.song, 'audio/mpeg');
      ok(await owner('POST', `/api/chats/${channel}/messages`, { fileId, type: 'file' }), 'song');
    }
    await until(() => ev("!!document.querySelector('.music-msg .music-play')"), 'song in the app');
    await ev("[...document.querySelectorAll('.music-msg .music-play')].at(-1).click(), true");
    await until(() => notifications().includes('Long Song'), 'music notification', 30000);
    const a = await until(() => ev("Number(document.querySelector('.music-bar-seek')?.value) || 0"), 'song moving');
    adb('shell input keyevent KEYCODE_HOME');
    await sleep(500);
    adb('shell input keyevent KEYCODE_SLEEP');
    await sleep(20000);
    adb('shell input keyevent KEYCODE_WAKEUP');
    await foreground();
    const b = Number(await ev("Number(document.querySelector('.music-bar-seek')?.value) || 0"));
    if (b < a + 8) throw new Error(`music stopped with the screen off (${a} → ${b} s)`);
    adb('shell input keyevent KEYCODE_MEDIA_PAUSE');
    await sleep(1500);
    if (await ev(`!!document.querySelector('.music-bar button[aria-label="توقف"]')`)) throw new Error('the media key did not pause');
    await ev(`document.querySelector('.music-bar button[aria-label="بستن پلیر"]').click(), true`);
    await until(() => !notifications().includes('Long Song'), 'music notification gone');
  },
  async incomingCall() {
    // With the app in front the call shows in the page; the notification is for a closed app.
    await foreground();
    adb('shell input keyevent KEYCODE_HOME');
    await sleep(2000);
    const r = ok(await owner('POST', '/api/calls', { userId: appId, video: false }), 'call');
    await until(() => notifications().includes('تماس صوتی ورودی'), 'call notification', 45000);
    ok(await owner('POST', `/api/calls/${r.call.id}/end`, {}), 'end call');
    await until(() => !notifications().includes('تماس صوتی ورودی'), 'call notification gone', 45000);
  },
  async rotate() {
    await foreground();
    await open(dm);
    adb('shell settings put system accelerometer_rotation 0');
    adb('shell settings put system user_rotation 1');
    await sleep(3000);
    await connect();
    await until(() => ev("!!document.querySelector('.chat-head')"), 'app after rotating');
    adb('shell settings put system user_rotation 0');
    await sleep(3000);
    await connect();
  },
  async losesNetwork() {
    await foreground();
    await open(dm);
    adb('shell svc wifi disable');
    adb('shell svc data disable');
    const t = word();
    await sleep(8000);
    await say(t);
    await sleep(8000);
    adb('shell svc wifi enable');
    adb('shell svc data enable');
    await until(() => ev(`[...document.querySelectorAll('.bubble')].some((b) => b.textContent.includes(${JSON.stringify(t)}))`), 'message after the network came back', 90000);
  },
  async killedAndReopened() {
    adb(`shell am force-stop ${PKG}`);
    await sleep(2000);
    await foreground();
    await connect();
    await until(() => ev("!!document.querySelector('.sidebar .chat-item')"), 'still signed in after the app was killed', 60000);
  },
};

// ---------- Start ----------
adb(`install -r -g ${APK}`);
adb(`shell pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
adb(`shell am start -n ${PKG}/chat.amore.app.MainActivity --es server http://10.0.2.2:3100`);
await connect();
await until(() => ev("!!document.querySelector('.auth-card')"), 'login screen', 60000);
await ev(`fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'phone', password: ${JSON.stringify(PASS)} }) }).then((r) => r.status)`);
await ev('location.reload(), true');
await sleep(3000);
await connect();
await until(() => ev("!!document.querySelector('.sidebar .chat-item')"), 'chat list', 60000);
log('app signed in');
adb('logcat -c');

const names = Object.keys(acts);
let i = 0;
while (Date.now() < END) {
  const name = pick(names);
  stats.actions[name] = (stats.actions[name] || 0) + 1;
  try {
    await Promise.race([acts[name](), sleep(240000).then(() => Promise.reject(new Error('action took over 4 minutes')))]);
  } catch (e) {
    stats.failed[name] = (stats.failed[name] || 0) + 1;
    issue('medium', name, e.message);
    try {
      adb('shell svc wifi enable');
      adb('shell svc data enable');
      adb('shell settings put system user_rotation 0');
      await foreground();
      await connect();
    } catch (e2) {
      issue('high', 'recover', `app not reachable after a failure: ${e2.message}`);
    }
  }
  if (++i % 5 === 0) {
    try {
      const crash = adb('logcat -d -b crash -t 40');
      if (crash.includes(PKG)) issue('high', 'app-crash', crash.slice(-1000));
      const pss = adb(`shell dumpsys meminfo ${PKG}`).match(/TOTAL PSS:\s+(\d+)/)?.[1];
      if (pss) stats.memory.push(Math.round(pss / 1024));
    } catch {
      /* the emulator was busy */
    }
    report();
  }
  await sleep(4000);
}
report();
log(`done: ${issues.size} different problems`);
process.exit(0);
