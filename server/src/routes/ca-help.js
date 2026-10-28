// Served at http://<server>/ca (via Caddy) when TLS_MODE=internal: how to trust this
// server's own certificate authority on each kind of device. Plain HTML, no app needed.
const PAGE = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>نصب گواهی امنیتی</title>
<style>
  body { font-family: Vazirmatn, Tahoma, sans-serif; margin: 0; background: #eef1f8; color: #121628; line-height: 1.9; }
  main { max-width: 680px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; }
  .card { background: #fff; border-radius: 16px; padding: 16px 20px; margin: 14px 0; box-shadow: 0 2px 10px rgb(30 34 70 / .08); }
  .btn { display: inline-block; background: linear-gradient(135deg, #6366f1, #a855f7); color: #fff; text-decoration: none;
         padding: 12px 22px; border-radius: 12px; font-weight: 700; margin: 6px 0; }
  ol { padding-inline-start: 22px; margin: 6px 0; }
  .muted { color: #6b7390; font-size: 14px; }
  code { background: #eef1f8; padding: 1px 6px; border-radius: 6px; }
</style>
</head>
<body>
<main>
  <h1>🔐 نصب گواهی امنیتی سرور</h1>
  <p>این سرور گواهی امنیتی (SSL) خودش را صادر می‌کند تا بدون اینترنت بین‌الملل هم ارتباط رمزنگاری‌شده باشد.
  برای اینکه مرورگر به آن اعتماد کند، <b>یک بار</b> روی هر دستگاه این گواهی را نصب کنید.</p>
  <p><a class="btn" href="/ca.crt">⬇ دانلود گواهی</a></p>
  <p class="muted">فقط گواهی را از همین سرور و شبکه‌ای که به آن اعتماد دارید نصب کنید.</p>

  <div class="card"><h3>🤖 اپ اندروید AmoreChat</h3>
    <p>برای اپ اندروید <b>نصب گواهی لازم نیست</b>: اپ را از <a href="/app">اینجا</a> دانلود کنید؛ موقع وارد کردن آدرس سرور، اپ یک «اثر انگشت» نشان می‌دهد. اگر با اثر انگشت زیر یکی بود، تأیید کنید.</p>
    <p class="muted">اثر انگشت (SHA-256) گواهی این سرور:</p>
    <code id="fp" dir="ltr" style="display:block;word-break:break-all;padding:10px;font-size:13px">…</code>
  </div>

  <div class="card"><h3>📱 اندروید</h3><ol>
    <li>فایل را دانلود کنید.</li>
    <li>تنظیمات ← امنیت ← رمزگذاری و اعتبارنامه‌ها ← <b>نصب گواهی</b> ← <b>گواهی CA</b> (در بعضی گوشی‌ها: تنظیمات ← امنیت ← نصب از حافظه).</li>
    <li>فایل <code>amorechat-ca.crt</code> را انتخاب کنید و تأیید کنید.</li>
    <li>مرورگر را کامل ببندید و دوباره باز کنید.</li>
  </ol></div>

  <div class="card"><h3>🍏 آیفون / آیپد</h3><ol>
    <li>این صفحه را در <b>Safari</b> باز کنید و فایل را دانلود کنید؛ پیام «Profile Downloaded» می‌آید.</li>
    <li>Settings ← General ← VPN & Device Management ← پروفایل دانلودشده ← <b>Install</b>.</li>
    <li>Settings ← General ← About ← <b>Certificate Trust Settings</b> ← گواهی را <b>روشن</b> کنید.</li>
  </ol></div>

  <div class="card"><h3>💻 ویندوز</h3><ol>
    <li>فایل را دانلود و روی آن دوبار کلیک کنید ← <b>Install Certificate</b>.</li>
    <li>Local Machine (یا Current User) ← <b>Place all certificates in the following store</b> ← <b>Trusted Root Certification Authorities</b>.</li>
    <li>مرورگر را دوباره باز کنید. (فایرفاکس: Settings ← Certificates ← View Certificates ← Authorities ← Import)</li>
  </ol></div>

  <div class="card"><h3>🍎 مک</h3><ol>
    <li>فایل را باز کنید تا در Keychain Access اضافه شود.</li>
    <li>روی گواهی دوبار کلیک ← Trust ← <b>Always Trust</b>.</li>
  </ol></div>

  <p>بعد از نصب، برنامه را از <b>https</b> باز کنید.</p>
</main>
<script>
// SHA-256 of the certificate, computed here (crypto.subtle isn't available on plain http pages).
function sha256(bytes) {
  const K = [], H = [];
  const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
  for (let n = 2, c = 0; c < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
    if (!prime) continue;
    if (c < 8) H.push(frac(Math.sqrt(n)));
    K.push(frac(Math.cbrt(n)));
    c++;
  }
  const len = bytes.length, total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Math.floor(bits / Math.pow(2, 8 * i)) & 255;
  const w = new Uint32Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (H[i] = (H[i] + v) >>> 0));
  }
  return H.map((v) => v.toString(16).padStart(8, '0')).join('').toUpperCase().match(/../g).join(':');
}
fetch('/ca.crt')
  .then((r) => r.text())
  .then((pem) => {
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\\s+/g, '');
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    document.getElementById('fp').textContent = sha256(bytes);
  })
  .catch(() => (document.getElementById('fp').textContent = 'در حالت گواهی داخلی (TLS_MODE=internal) نمایش داده می‌شود'));
</script>
</body>
</html>`;

export default async function caHelpRoutes(app) {
  app.get('/ca-help', { config: { public: true } }, async (_req, reply) => reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      // Static page with one inline script (the fingerprint); nothing user-supplied on it.
      .header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .send(PAGE));
}
