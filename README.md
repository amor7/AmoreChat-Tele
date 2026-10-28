# AmoreChat-Tele

**نسخه ۱.۰.۰** — پیام‌رسان فارسی self-hosted + لایهٔ **Tele** (پل تلگرام از طریق پروکسی/VPN روی سرور، بدون نیاز به VPN روی گوشی کاربر).

این یک **پروژهٔ مستقل** است. ریپوی جداگانهٔ `amor7/AmoreChat` دست‌نخورده می‌ماند و لینک‌های نصب این پروژه فقط به `AmoreChat-Tele` اشاره می‌کنند.

<div dir="rtl">

## این پروژه چیست؟

| بخش | توضیح |
|-----|--------|
| **پیام‌رسان داخلی** | چت خصوصی، گروه، کانال، تماس صوتی/تصویری، ویس‌چت، استریم، PWA، اپ اندروید — روی سرور داخل ایران، بدون وابستگی به سرویس خارجی |
| **Tele** | هر عضو تیم حساب تلگرام خودش را وصل می‌کند؛ گفتگوهای انتخابی داخل اپ دیده می‌شوند و پیام دوطرفه می‌رود |
| **VPN سرور** | فقط ترافیک تلگرام از پروکسی‌های ادمین عبور می‌کند؛ چت داخلی همیشه روی نت داخلی می‌ماند |

### ویژگی‌های Tele (v1)

- ورود با شماره + کد + رمز دو مرحله‌ای (TDLib)
- انتخاب پیوی / گروه / کانال برای نمایش در بخش Tele
- ارسال و دریافت متن (رسانه در نسخه‌های بعدی گسترش می‌یابد)
- حریم خصوصی: پیام‌های تلگرام هر کاربر فقط برای خودش
- **fail-closed**: اگر پروکسی سالم نباشد، به تلگرام مستقیم وصل نمی‌شود

### پروکسی / VPN پشتیبانی‌شده (ادمین)

SOCKS5 · HTTP · Shadowsocks · VLESS · VMess · Trojan · **WireGuard** · JSON outbound کامل sing-box (از جمله Reality)

---

## امکانات پیام‌رسان

- چت خصوصی، گروه، کانال، پیام‌های ذخیره‌شده، کانال اضطراری
- تماس صوتی/تصویری، کانال صوتی، ویس‌چت گروهی، استریم صفحه
- پیام صوتی، ویدیو چندکیفیت، ری‌اکشن، جستجو، فوروارد، حذف خودکار
- ورود دومرحله‌ای، لیست دستگاه‌ها، بکاپ، پنل مدیریت، PWA، اپ اندروید

جزئیات بیشتر امکانات هسته از همان معماری پیام‌رسان self-hosted آمده؛ تمرکز این ریپو روی **Tele + VPN سرور** است.

---

## نصب

### پیش‌نیاز
- سرور لینوکس (پیشنهاد: Ubuntu 22.04/24.04 داخل ایران)
- دامنه با رکورد A به IP سرور (یا IP خام با `TLS_MODE=internal`)
- پورت‌های ۸۰/۴۴۳ و در صورت تماس: ۷۸۸۱/۷۸۸۲ و ۳۴۷۸

### روش ۱: کلون و Docker

```bash
git clone https://github.com/amor7/AmoreChat-Tele.git
cd AmoreChat-Tele
cp .env.example .env
# DOMAIN و در صورت نیاز TELEGRAM_API_ID / HASH را ویرایش کنید
sudo bash deploy/install.sh
```

### روش ۲: نصب یک‌خطی (بعد از انتشار ریلیز با asset)

```bash
curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/get.sh | sudo bash
# یا نسخه مشخص:
curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/get.sh | sudo bash -s -- v1.0.0
```

پوشه پیش‌فرض نصب: `./amorechat-tele`

### توسعه محلی

```bash
npm install
npm run dev:server   # پورت 3000
npm run dev:web      # پورت 5173
```

Node.js 24+ لازم است.

---

## راه‌اندازی Tele

راهنمای کامل: **[docs/TELE-SETUP.md](docs/TELE-SETUP.md)** · معماری: **[docs/TELE-ARCHITECTURE.md](docs/TELE-ARCHITECTURE.md)**

خلاصه:

1. در `.env`: `TELEGRAM_API_ID` و `TELEGRAM_API_HASH` (از my.telegram.org)
2. `cd server && npm i tdl prebuilt-tdlib`
3. نصب باینری **sing-box** روی سرور
4. پنل ادمین → **Tele / VPN** → افزودن پروکسی (از جمله WireGuard conf) → Probe → فعال‌سازی egress
5. منوی کاربر → **Tele (تلگرام)** → لاگین و انتخاب گفتگوها

---

## به‌روزرسانی

```bash
cd amorechat-tele   # یا مسیر نصب شما
sudo bash deploy/update.sh          # آخرین
sudo bash deploy/update.sh v1.0.0    # نسخه مشخص
```

---

## SSL و قطعی اینترنت

| `TLS_MODE` | کاربرد |
|------------|--------|
| `auto` | Let's Encrypt |
| `internal` | گواهی خود سرور — مناسب قطعی طولانی |
| `custom` | cert.pem / key.pem در `certs/` |

راهنمای آفلاین مفصل: [docs/OFFLINE-INSTALL.md](docs/OFFLINE-INSTALL.md)

---

## نسخه و تغییرات

- نسخه فعلی: **1.0.0** — [CHANGELOG-TELE.md](CHANGELOG-TELE.md)
- تگ ریلیز: `v1.0.0`

---

ایموجی: Microsoft Fluent Emoji (MIT) · آیکون: Lucide (ISC)

</div>
