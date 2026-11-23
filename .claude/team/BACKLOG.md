# کارهای باز

> موارد از onboarding 2026-11-23. «تأییدشده» = در کد دیده شد؛ بقیه گزارش ایجنت‌ها و هنوز بررسی دقیق نشده‌اند.

## باگ‌ها
- [مهم · تأییدشده] `Dockerfile:6-7` از `npm install` (نه `npm ci`) استفاده می‌کند و بعد `tdl`/`prebuilt-tdlib` را با بازه‌ی `^` دوباره نصب می‌کند → build تکرارپذیر نیست و ممکن است با lock و `Dockerfile.runtime` (که `npm ci` دارد) فرق کند. برای پروژه‌ای که بسته‌ی آفلاین منتشر می‌کند مهم است.

## بهبودها
- [مهم · تأییدشده] کلید نشست تلگرام: اگر `TELE_SESSION_KEY` در env نباشد، کلید در `DATA_DIR/tele-sessions/.key` کنار خود نشست‌ها ذخیره می‌شود (`server/src/tele/accounts.js:203-214`) → کپی پوشه‌ی data یا بکاپ = دسترسی به حساب‌های تلگرام؛ خلاف کامنت همان فایل. در نصب عادی `deploy/ensure-env.sh` کلید را در `.env` می‌سازد، پس خطر فقط در اجرای بدون compose است. پیشنهاد: هشدار در لاگ/پنل یا عدم شروع Tele بدون کلید، و مطمئن شدن که بکاپ این فایل را جدا نگه می‌دارد.
- [مهم] پوشش unit test بسیار کم: منطق `server/src/tele/*` (accounts، messages، egress، mirror) و کل `web/src` تست واحد ندارند، در حالی که این ماژول‌ها بزرگ و درهم‌اند. پیشنهاد: اول تست برای parse/انتخاب پروکسی، migrationها و تبدیل id موقت پیام.
- [مهم] سرویس `ovpn` در `docker-compose.yml` با `user: root` و `NET_ADMIN` به کل `./data` (شامل نشست‌های تلگرام) دسترسی دارد → محدود کردن mount به زیرپوشه‌ی لازم.
- [مهم] actionهای GitHub به tag (`@v4`) پین شده‌اند نه SHA، و `release.yml` دسترسی نوشتن دارد؛ `tele-e2e.yml` روی PR اجرا می‌شود و از secretها کلید cache می‌سازد → پین SHA و محدود کردن رویدادها.
- [جزئی] گاردی برای ویرایش اشتباه migrationهای قدیمی در `server/src/db.js` نیست (مثلاً تست که hash ورودی‌های قدیمی ثابت بماند).
- [جزئی] `TeleView.jsx` (~1258 خط) و `TeleAdmin.jsx` (~1043 خط) و `routes/tele.js` (وابسته به routeهای دیگر) → شکستن تدریجی هنگام تغییرات بعدی.
- [جزئی] `.env.example` متغیرهای `BACKUP_MIRROR_DIR` و `LIVEKIT_API_KEY` را که compose استفاده می‌کند ندارد.
- [جزئی] `docs/TELE-ARCHITECTURE.md:3` هنوز می‌گوید «draft… not a claim that Telegram integration is already implemented»، در حالی که پیاده‌سازی شده.

## ایده‌ها
- [کم] UI تلگرام با polling کار می‌کند (هر 5/10/60 ثانیه) در حالی که Socket.IO هست؛ در مقیاس <۵۰ کاربر اولویت پایین، ولی روی نت کند push مصرف داده را کم می‌کند.
- یکی کردن نسخه در سه package.json با یک اسکریپت bump.
