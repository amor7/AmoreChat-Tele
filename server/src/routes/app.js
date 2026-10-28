import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addStream } from '../push.js';
import { getSetting } from '../settings.js';

// The Android app: its notification stream, and the APK download page at /app
// (served by this server so phones can install it during a shutdown).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APK = path.join(process.env.APK_DIR || path.join(ROOT, 'android-dist'), 'amorechat.apk');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const versionCode = (v) => v.split('.').map(Number).reduce((n, p, i) => n + (p || 0) * [10000, 100, 1][i], 0);

// "What's new" for the in-app update bar: the recent versions' bullet points from CHANGELOG.md.
function releaseNotes() {
  let text;
  try {
    text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const part of text.split(/^## v/m).slice(1, 13)) {
    const [head, ...lines] = part.split(/\r?\n/);
    const version = head.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    const items = lines
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).replace(/\*\*/g, '').trim())
      .slice(0, 25);
    out.push({ version, versionCode: versionCode(version), items });
  }
  return out;
}
const NOTES = releaseNotes();

const apkInfo = () =>
  fs.existsSync(APK) ? { version: VERSION, versionCode: versionCode(VERSION), size: fs.statSync(APK).size, notes: NOTES } : null;

function page(siteName, apk) {
  const mb = apk ? (apk.size / 1048576).toFixed(1) : 0;
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>اپ اندروید ${siteName}</title>
<style>
  body { font-family: Vazirmatn, Tahoma, sans-serif; margin: 0; background: #0b0e1a; color: #e6e8f5; line-height: 1.9; }
  main { max-width: 620px; margin: 0 auto; padding: 28px 16px 48px; }
  .hero { text-align: center; }
  .logo { width: 84px; height: 84px; border-radius: 24px; background: linear-gradient(135deg, #6366f1, #a855f7); display: inline-grid; place-items: center; font-size: 42px; }
  h1 { font-size: 24px; margin: 10px 0 0; }
  .btn { display: inline-block; background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 14px; font-weight: 700; font-size: 17px; margin: 14px 0 4px; }
  .muted { color: #8f97b8; font-size: 14px; }
  .card { background: #121729; border: 1px solid #222a44; border-radius: 16px; padding: 14px 20px; margin: 14px 0; }
  ol, ul { padding-inline-start: 22px; margin: 6px 0; }
</style>
</head>
<body>
<main>
  <div class="hero">
    <div class="logo">💬</div>
    <h1>${siteName} برای اندروید</h1>
    ${
      apk
        ? `<a class="btn" href="/app/amorechat.apk" download>⬇ دانلود اپ (${mb} مگابایت)</a>
    <div class="muted">نسخه ${apk.version} · اندروید ۸ به بالا</div>`
        : `<p class="muted">فایل اپ روی این سرور نیست. آن را از صفحه نسخه‌ها در گیت‌هاب AmoreChat دانلود کنید.</p>`
    }
  </div>
  <div class="card"><b>چرا اپ؟</b><ul>
    <li>🔔 اعلان پیام و تماس حتی وقتی برنامه بسته است — <b>بدون نیاز به سرویس گوگل</b>، پس در قطعی اینترنت بین‌الملل هم کار می‌کند</li>
    <li>📞 زنگ تماس تمام‌صفحه، حتی روی صفحه قفل</li>
    <li>🔒 برای سرورهای آفلاین نیازی به نصب دستی گواهی نیست</li>
    <li>📤 ارسال عکس و فایل از گالری با دکمه «اشتراک‌گذاری»</li>
  </ul></div>
  <div class="card"><b>نصب</b><ol>
    <li>فایل را دانلود و باز کنید.</li>
    <li>اگر پرسید، اجازه «نصب از این منبع» را بدهید (یک بار).</li>
    <li>اپ را باز کنید و آدرس همین سرور را وارد کنید: <b dir="ltr">${'${location.host}'}</b></li>
  </ol></div>
  <p class="muted">آپدیت‌های ظاهر و امکانات برنامه خودکار از سرور می‌رسند؛ فقط گاهی لازم است فایل جدید را نصب کنید (داخل برنامه خبر داده می‌شود).</p>
</main>
<script>document.querySelectorAll('b[dir=ltr]').forEach((b) => (b.textContent = location.host));</script>
</body>
</html>`;
}

export default async function appRoutes(app) {
  app.get('/app', { config: { public: true } }, async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(page(getSetting('site_name') || 'AmoreChat', apkInfo())),
  );

  app.get('/app/amorechat.apk', { config: { public: true } }, async (_req, reply) => {
    if (!apkInfo()) return reply.code(404).send({ error: 'فایل اپ روی این سرور نیست' });
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', `attachment; filename="amorechat-${VERSION}.apk"`);
    reply.header('Content-Length', fs.statSync(APK).size);
    reply.header('Cache-Control', 'no-cache');
    return reply.send(fs.createReadStream(APK));
  });

  // Which app version this server offers (the app suggests updating when it's older).
  app.get('/api/app/android', { config: { public: true } }, async () => ({ apk: apkInfo() }));

  // Server-sent events for the app's background notifications.
  app.get('/api/notify/stream', async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const remove = addStream(req.user.id, req.user.session_id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const done = () => {
      clearInterval(ping);
      remove();
    };
    req.raw.on('close', done);
    res.on('close', done);
  });
}
