# کارهای باز

> موارد از onboarding 2026-11-23. «تأییدشده» = در کد دیده شد؛ بقیه گزارش ایجنت‌ها و هنوز بررسی دقیق نشده‌اند.

## باگ‌ها
- [مهم · تأییدشده] `Dockerfile:6-7` از `npm install` (نه `npm ci`) استفاده می‌کند و بعد `tdl`/`prebuilt-tdlib` را با بازه‌ی `^` دوباره نصب می‌کند → build تکرارپذیر نیست و ممکن است با lock و `Dockerfile.runtime` (که `npm ci` دارد) فرق کند. برای پروژه‌ای که بسته‌ی آفلاین منتشر می‌کند مهم است.

> انجام‌شده در v1.0.40 (حذف شد): سخت‌کردن ffmpeg، چرخش لاگ Docker، چک دیسک نصب/آپدیت، safeInterval/unhandledRejection، TeleView هم‌سطح چت داخلی، ویس در صف آفلاین، پیش‌نویس ماندگار، QR (از ایده‌ها).

## ریسک‌ها (از /ideas 2026-11-23، بررسی‌شده توسط skeptic)
- [متوسط · v1.0.40] probe در `media.js` از رویداد `'exit'` به‌جای `'close'` استفاده می‌کند (از قبل در این branch) → stderr ممکن است ناقص بماند.
- [متوسط · v1.0.40] خروج اجباری (401، logout-all) پیش‌نویس/صف/cache را پاک نمی‌کند (`wipeLocal` فقط در خروج دستی)؛ روی دستگاه مشترک مهم است.
- [متوسط · v1.0.40] `watchedDownload` کل فایل را در حافظه جمع می‌کند (~۲× حجم) → دانلود فایل بزرگ تلگرام روی WebView ضعیف.
- [جزئی · v1.0.40] aiff/asf(wma)/ac3 در whitelist ffmpeg نیستند → موزیک با این قالب‌ها metadata/تبدیل نمی‌گیرد.
- [جزئی · v1.0.40] `media.js:~190` («video processing failed») و `timers.js` (still-running) هنوز از logger مرکزی نمی‌روند.
- [جزئی · v1.0.40] `get.sh`: حلقه‌ی disk-check با `DIR` دارای فاصله شکننده است.
- [جزئی · v1.0.40] پنل ادمین کد خروج 4 را به پیام «فضای دیسک کم است» ترجمه نمی‌کند (فقط در `log.txt`).

## بهبودها
- [جزئی · v1.0.40] تست‌های باقی‌مانده: تست یکپارچه برای `ffmpeg()` (رد playlist قبل از spawn، kill بعد از timeout، پاک شدن out) با `FFMPEG_PATH` ساختگی؛ تست `flushOutbox`/ویس با fake-indexeddb؛ ui-e2e برای پیش‌نویس بعد از reload. ویس واقعی روی WebView اندروید و Safari قدیمی دستی تست نشده.
- [جزئی · v1.0.40] CI: `TLS_MODE=custom` تست نمی‌شود (پیشنهاد: job با `key.pem` مالک 1000 و mode 600).
- [جزئی · v1.0.40] حجم عکس تلگرام در پیام سرور نیست (`tele/messages.js` ~90) → نمایش حجم کنار دانلود عکس کار نمی‌کند.
- [جزئی · v1.0.40] تکرار کد: `parseAnswer` در `api()`؛ قاعده‌ی retry در `upload()` و `failureKind`؛ `voiceExt` در سه جا. `plainHttpUrl` در `transfer.js` جای درستی نیست.
- [جزئی · v1.0.40] QR: برای `/ca` فقط در صفحه‌ی سلامت ادمین است؛ کاربر عادی `TLS_MODE` را نمی‌داند؛ `ALSO_IP` با گواهی داخلی پوشش داده نمی‌شود. دیالوگ QR `aria-modal` و focus trap ندارد؛ alt آن کل URL را می‌خواند.
- [جزئی · v1.0.40] دکمه‌ی «حالا بفرست» (صف آفلاین) بازخورد ندارد.
- [جزئی] `closeLive` در `tele/accounts.js:326` export نشده و shutdown (`server/src/index.js:233-240`) کلاینت‌های TDLib را نمی‌بندد و `flushUsage` نمی‌زند → تا ۶۰ ثانیه شمارش ترافیک در هر restart گم می‌شود.
- [جزئی] پوشه‌های بکاپ و mirror بدون mode ساخته می‌شوند (`server/src/backup.js:14,66,78,82`) در حالی که شامل `totp_secret`، پیام‌ها و اسرار پروکسی‌اند → `0o700`/`0o600`. همراهش مستند «بازیابی روی سرور خالی» (بکاپ پنل `.env`، `TELE_SESSION_KEY` و certs را ندارد؛ کپی دستی `.env` را یادآوری کند).
- [مهم · تأییدشده] کلید نشست تلگرام: اگر `TELE_SESSION_KEY` در env نباشد، کلید در `DATA_DIR/tele-sessions/.key` کنار خود نشست‌ها ذخیره می‌شود (`server/src/tele/accounts.js:203-214`) → کپی پوشه‌ی data یا بکاپ = دسترسی به حساب‌های تلگرام؛ خلاف کامنت همان فایل. در نصب عادی `deploy/ensure-env.sh` کلید را در `.env` می‌سازد، پس خطر فقط در اجرای بدون compose است. پیشنهاد: هشدار در لاگ/پنل یا عدم شروع Tele بدون کلید، و مطمئن شدن که بکاپ این فایل را جدا نگه می‌دارد.
- [مهم] پوشش unit test بسیار کم: منطق `server/src/tele/*` (accounts، messages، egress، mirror) و کل `web/src` تست واحد ندارند، در حالی که این ماژول‌ها بزرگ و درهم‌اند. پیشنهاد: اول تست برای parse/انتخاب پروکسی، migrationها و تبدیل id موقت پیام.
- [مهم] سرویس `ovpn` در `docker-compose.yml` با `user: root` و `NET_ADMIN` به کل `./data` (شامل نشست‌های تلگرام) دسترسی دارد → محدود کردن mount به زیرپوشه‌ی لازم. (`cap_drop` و `no-new-privileges` برای `app`/`caddy` در v1.0.40 انجام شد (در `compose config` تأیید شد)؛ `ovpn` دست‌نخورده ماند.)
- [مهم] actionهای GitHub به tag (`@v4`) پین شده‌اند نه SHA، و `release.yml` دسترسی نوشتن دارد؛ `tele-e2e.yml` روی PR اجرا می‌شود و از secretها کلید cache می‌سازد → پین SHA و محدود کردن رویدادها. (بخش `timeout-minutes` و `concurrency` در v1.0.40 انجام شد؛ پین SHA و محدودسازی رویدادها باقی است.)
- [جزئی] گاردی برای ویرایش اشتباه migrationهای قدیمی در `server/src/db.js` نیست (مثلاً تست که hash ورودی‌های قدیمی ثابت بماند).
- [جزئی] `TeleView.jsx` (~1258 خط) و `TeleAdmin.jsx` (~1043 خط) و `routes/tele.js` (وابسته به routeهای دیگر) → شکستن تدریجی هنگام تغییرات بعدی. هنگام شکستن: فراخوانی‌های `api` تلگرام (~۴۳ در Tele*.jsx) به `web/src/teleApi.js`، و `requireChat`/`assertCanPost`/`registerFile` از `routes/{chats,messages,files}.js` به ماژول دامنه منتقل شوند تا route از route دیگر import نکند.
- [جزئی] `.env.example` متغیر `LIVEKIT_API_KEY` را که compose استفاده می‌کند ندارد (در compose ثابت `amorechat` است، پس شاید لازم نباشد).

## ایده‌ها
- [کم] UI تلگرام با polling کار می‌کند (هر 5/10/60 ثانیه) در حالی که Socket.IO هست؛ در مقیاس <۵۰ کاربر اولویت پایین، ولی روی نت کند push مصرف داده را کم می‌کند.
  - همراهش: اعلان پیام تلگرام برای چت‌های «مهم» (الان در `server/src/tele/` هیچ notify/push نیست). با `TELE_IDLE_MINUTES` و `assertQuota` در تنش است؛ اول طراحی و تصمیم درباره‌ی بودجه‌ی ترافیک VPN.
- یکی کردن نسخه در سه package.json با یک اسکریپت bump.
- [کم] نظرسنجی در گروه/کانال (migration + UI؛ نظرسنجی تلگرام فقط متن نمایش داده می‌شود، `tele/messages.js:119`).
- [کم] خروجی HTML آفلاین از یک چت برای کاربر.
- رد شده در /ideas (برای تکرار نشدن): drill بکاپ/rollback (از قبل `server/test/recovery-e2e.sh` در `ci.yml`)؛ رمزگذاری `totp_secret`/hash کند recovery code (کلید کنار DB، کد ۴۸ بیتی)؛ auth روی upgrade `/rtc` (LiveKit خودش توکن می‌خواهد)؛ `errors.js` و حذف ۷۴ `Object.assign`؛ CSP تنگ‌تر و `read_only` کانتینر.
