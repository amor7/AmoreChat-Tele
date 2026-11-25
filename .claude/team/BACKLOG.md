# کارهای باز

> موارد از onboarding 2026-11-23. «تأییدشده» = در کد دیده شد؛ بقیه گزارش ایجنت‌ها و هنوز بررسی دقیق نشده‌اند.

## باگ‌ها

> انجام‌شده در v1.0.40 (حذف شد): build تکرارپذیر Docker با `npm ci`، سخت‌کردن ffmpeg، چرخش لاگ Docker، چک دیسک نصب/آپدیت، safeInterval/unhandledRejection، TeleView هم‌سطح چت داخلی، ویس در صف آفلاین، پیش‌نویس ماندگار، QR (از ایده‌ها).

## ریسک‌ها (از /ideas 2026-11-23، بررسی‌شده توسط skeptic)
- [متوسط · v1.0.40] probe در `media.js` از رویداد `'exit'` به‌جای `'close'` استفاده می‌کند (از قبل در این branch) → stderr ممکن است ناقص بماند.
- [متوسط · v1.0.40] خروج اجباری (401، logout-all) پیش‌نویس/صف/cache را پاک نمی‌کند (`wipeLocal` فقط در خروج دستی)؛ روی دستگاه مشترک مهم است.
- [متوسط · v1.0.40] `watchedDownload` کل فایل را در حافظه جمع می‌کند (~۲× حجم) → دانلود فایل بزرگ تلگرام روی WebView ضعیف.
- [جزئی · v1.0.40] aiff/asf(wma)/ac3 در whitelist ffmpeg نیستند → موزیک با این قالب‌ها metadata/تبدیل نمی‌گیرد.
- [جزئی · v1.0.40] `media.js:~190` («video processing failed») و `timers.js` (still-running) هنوز از logger مرکزی نمی‌روند.
- [جزئی · v1.0.40] `get.sh`: حلقه‌ی disk-check با `DIR` دارای فاصله شکننده است.
- [جزئی · v1.0.40] پنل ادمین کد خروج 4 را به پیام «فضای دیسک کم است» ترجمه نمی‌کند (فقط در `log.txt`).

## بهبودها
- [جزئی · v1.0.40] تست‌های باقی‌مانده: تست یکپارچه برای `ffmpeg()` (رد playlist قبل از spawn، kill بعد از timeout، پاک شدن out) با `FFMPEG_PATH` ساختگی؛ تست `flushOutbox`/ویس با fake-indexeddb؛ ui-e2e برای پیش‌نویس بعد از reload. ویس واقعی روی اندروید را کاربر در 2026-11-23 دستی تست کرد و درست بود؛ Safari قدیمی تست نشده.
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

- [جزئی · v1.0.41] `liveClient` در `disconnectAccount` هنوز سقف زمانی ندارد (فقط logout سقف ۱۵ ثانیه دارد).
- [جزئی · v1.0.41] تست e2e نیست برای: انقضای idle، poll بدون touch (`x-amore-poll`)، `Cache-Control` مدیا برای کاربر دارای رمز.
- [جزئی · v1.0.41] VACUUM بکاپ (`backup-redact.js`) فایل موقت را در temp سیستم می‌سازد و فضای آن چک نمی‌شود.
- [جزئی · v1.0.41] بعد از رمز اشتباه تعداد تلاش باقی‌مانده نمایش داده نمی‌شود.
- [جزئی · v1.0.41] ادمینی که رمز حساب کاربر را ریست کرده، با ۵ حدس می‌تواند unlock او را ۱۵ دقیقه ببندد یا forgot بزند (قطع حساب تلگرام، بدون افشای داده).
- [جزئی · v1.0.41] `maxLength` مرورگر واحد UTF-16 می‌شمارد، سرور code point (۶۴).

- [جزئی · v1.0.42] تست نگهبان رنگ (`server/test/css-tokens.test.mjs`) فقط hex را می‌گیرد؛ حدود ۳۰ `rgb()` ثابت (پوشش روی رسانه، سایه) مانده → در مرحله‌ی ۳ (ConfirmDialog) توکن `--scrim` و گرفتن `rgb()` با allowlist.
- [جزئی · v1.0.42] پس‌زمینه‌های کم‌رنگ دستی `color-mix(var(--ok|--danger) 8..15%)` هنوز یکدست نشده‌اند (`--*-soft` هست).
- [جزئی · v1.0.42] حالت سبک «خودکار» روی WebView قدیمی معمولاً تشخیص داده نمی‌شود (`deviceMemory`/`saveData` نیست)؛ به `navigator.connection` change هم گوش نمی‌دهد.
- [جزئی · v1.0.42] دکمه‌های `.segmented` `aria-pressed` ندارند؛ نقطه‌های «در حال اتصال»/ضبط در حالت کاهش حرکت فقط رنگ‌اند (مرحله‌ی ۲ a11y).
- [جزئی · v1.0.42] `theme.css` (صفحه‌های تماس) و `themes.css` نام‌های گیج‌کننده دارند → هنگام دست زدن به صفحه‌ی تماس، `theme.css` به `calls.css`.

- [مهم · v1.0.43، پیش از مرحله‌ی ۳] منوها (منوی پیام، چت، سایدبار) فعلاً `role=dialog` و Tab-trap دارند؛ برای Menu مرحله‌ی ۳: هسته‌ی `useLayer` (stack + Escape + Back + بازگرداندن focus) و `useMenu` با فلش‌ها و `role=menu`، Tab منو را ببندد. `Modal` یک حالت بی‌سر (`bare`) بگیرد تا Composer/QR/ShareDialog هم از آن استفاده کنند. (architect)
- [جزئی · v1.0.43] Back مرورگر (نه اپ اندروید) وسط آپلود Composer ورودی history را مصرف می‌کند و Back بعدی از چت خارج می‌شود (`backnav.js`).
- [جزئی · v1.0.43] `TeleForgot` در `TelePasscode.jsx` با Back بسته نمی‌شود؛ منوهای `.tele-more-menu`/`.tele-msg-menu` Escape ندارند؛ `pipProps` در CallView کیبورد ندارد.
- [جزئی · v1.0.43] تست DOM برای `useDialog` (Escape دولایه، wrap Tab، بازگرداندن focus) نیست؛ پیشنهاد: گام کوچک در `ui-e2e.mjs`.

- [جزئی · v1.0.44] `parseAnswer` در `web/src/api.js` (آپلودها) 401 را به `SIGNED_OUT_EVENT` نمی‌رساند (url ندارد).
- [جزئی · v1.0.44] e2e برای «تأیید و بلافاصله navigate» (`whenHistorySettled` در `confirm.js` به ترتیب flush افکت‌های React تکیه دارد)؛ اسکلتون با `background-position` روی WebView ضعیف repaint می‌کند (در حالت سبک خاموش).
- [جزئی · v1.0.44] Modal دیگر prop تازه نگیرد؛ Lightbox/sheet مرحله‌ی ۴ مستقیم روی `useDialog`/`useLayer` (architect).

- [جزئی · v1.0.45] پیام تلگرامِ «ارسال نشد» API ارسال دوباره/حذف ندارد (`DELETE /api/tele/messages/:id` فقط queued)؛ فعلاً فقط توضیح دارد.
- [جزئی · v1.0.45] لغو دانلود در کلاینت احتمالاً `downloadFile` تلگرام را در سرور متوقف نمی‌کند (ترافیک VPN) — بررسی شود. blob عکس/ویدیوهای دانلودشده تا بستن چت در حافظه می‌ماند (بدون سقف).
- [جزئی · v1.0.45] `/api/tele/status` برای badge سایدبار کل dialogs را برمی‌گرداند؛ پاسخ سبک `?brief=1` (perf). `sameMessage` در `tele-rules.js` باید با فیلدهای `publicMessage` سرور هم‌گام بماند.
- [جزئی · v1.0.45] TalkBack واقعی (click با `detail===0`) روی دستگاه تست نشده؛ long-press و `useBackdropGuard` در Message/TeleMessage/ChatView/Folders تکراری‌اند (architect).

- [جزئی · v1.0.46] کلیک روی لینک `#/admin/x` وقتی پنل باز است یک Back اضافه می‌خواهد (ورودی hash با `replaceState` خالی می‌شود ولی حذف نمی‌شود). polling پنل‌های «آمار» و «تماس فعال» در تب پنهان متوقف نمی‌شود.
- [جزئی · v1.0.46] برچسب کارت سلامت «تماس / ویس‌چت» با نام ناوبری «تماس و ویس‌چت فعال» یکی نیست؛ ناوبری ادمین roving با کلیدهای جهت ندارد.

- [جزئی · v1.0.49] یک ماژول مشترک `server/src/validate.js` (boolOf، textOf، numOf، httpError، cleanText): الان `parseBool`/`boolFields`/`settingValue`/`numOf`/`bad` در چند فایل با رفتار کمی متفاوت تکرار شده‌اند؛ قرارداد ورودی bool و قالب پیام خطای 400 در DECISIONS ثبت شود (architect).
- [جزئی · v1.0.49] پنهان ماندن mentionها در گروه با اعضای مخفی به `toJSON` روی همان شیء پیام تکیه دارد: هر `{...msg}` تازه که پخش شود آن را می‌اندازد → تست unit روی `serializeMessage` + `JSON.stringify` یک کپی.
- [جزئی · v1.0.49] `DELETE /members/:id` برای شناسه‌ی ناموجود 404 و موجود 200 می‌دهد (وجود کاربر قابل حدس)؛ PATCH access و mirrors در `routes/tele.js` هنوز در یک tx نیستند؛ `TeleAdminAccounts.jsx:127` ورودی سهمیه بعد از خطا مقدار ردشده را نشان می‌دهد؛ تست migration v27 و چک نهایی سهمیه در آپلود تکه‌ای و rate limit حذف فایل‌ها تست خودکار ندارند.
- [جزئی · v1.0.49] متن چند خطای سرور نمی‌گوید کاربر چه کند («نامعتبر»، «دسترسی ندارید»)؛ ارقام لاتین در خطاهای 429 (ux).

## ایده‌ها
- [کم] UI تلگرام با polling کار می‌کند (هر 5/10/60 ثانیه) در حالی که Socket.IO هست؛ در مقیاس <۵۰ کاربر اولویت پایین، ولی روی نت کند push مصرف داده را کم می‌کند.
  - همراهش: اعلان پیام تلگرام برای چت‌های «مهم» (الان در `server/src/tele/` هیچ notify/push نیست). با `TELE_IDLE_MINUTES` و `assertQuota` در تنش است؛ اول طراحی و تصمیم درباره‌ی بودجه‌ی ترافیک VPN.
- یکی کردن نسخه در سه package.json با یک اسکریپت bump.
- [کم] نظرسنجی در گروه/کانال (migration + UI؛ نظرسنجی تلگرام فقط متن نمایش داده می‌شود، `tele/messages.js:119`).
- [کم] خروجی HTML آفلاین از یک چت برای کاربر.
- رد شده در /ideas (برای تکرار نشدن): drill بکاپ/rollback (از قبل `server/test/recovery-e2e.sh` در `ci.yml`)؛ رمزگذاری `totp_secret`/hash کند recovery code (کلید کنار DB، کد ۴۸ بیتی)؛ auth روی upgrade `/rtc` (LiveKit خودش توکن می‌خواهد)؛ `errors.js` و حذف ۷۴ `Object.assign`؛ CSP تنگ‌تر و `read_only` کانتینر.
