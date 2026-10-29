# AmoreChat-Tele Changelog

## [1.0.6] — 2026-10-29

### رفع اشکال
- `syncDialogMessages` دیگر `selected = 1` نمی‌کند (حذف گفتگو با polling بعدی خنثی می‌شد)
- پیام ارسالی: `updateMessageSendSucceeded` ردیف موقت را به شناسه نهایی منتقل می‌کند؛ پیام‌های `sending_state` از history ذخیره نمی‌شوند؛ UI صفحه آخر را جایگزین می‌کند و کلید رندر شناسه ردیف است

### ویژگی
- ریپلای: `reply_to` (مایگریشن v11)، `inputMessageReplyToMessage`، نقل‌قول با `getMessage` برای پیام‌های ذخیره‌نشده
- عکس: `tele_accounts.allow_media` (پیش‌فرض ۰)، تنظیم `tele_media_max_mb` (پیش‌فرض ۵)
  - `minithumbnail` در خود پیام؛ `GET /api/tele/messages/:id/photo` با `getRemoteFile` + `downloadFile` (بزرگ‌ترین اندازه زیر سقف)
  - `POST /api/tele/dialogs/:id/photo` (multipart، `inputMessagePhoto` / `inputPhoto`)؛ فایل موقت تا یک روز در `data/tele-uploads`
  - پنل مدیریت: `GET /api/admin/tele/accounts`، `PATCH /api/admin/tele/accounts/:id`، `PATCH /api/admin/tele/media`

## [1.0.5] — 2026-10-29

### رفع اشکال
- `liveClient()`: کلاینت TDLib بعد از ری‌استارت از نشست ذخیره‌شده باز می‌شود (قبلاً فقط در حافظه بود و بعد از هر آپدیت «اتصال برقرار نیست» می‌داد)

### مصرف VPN
- فقط گفتگوهای انتخاب‌شده (`selected`) به‌روز می‌شوند؛ فهرست کامل فقط با `refresh {all: true}` هنگام افزودن
- بستن کلاینت بعد از `TELE_IDLE_MINUTES` (پیش‌فرض ۱۰) بی‌استفاده بودن؛ ورود نیمه‌کاره بعد از ۳۰ دقیقه
- `setAutoDownloadSettings` خاموش برای همه شبکه‌ها، `online = false`
- `getChatHistory only_local` برای بررسی دوره‌ای؛ `openChat` حذف شد (بدون `closeChat` آپدیت‌های گروه را باز نگه می‌داشت)
- `getNetworkStatistics` در `/api/tele/status` (`live`, `traffic`)

## [1.0.4] — 2026-10-29

### رابط کاربری
- صفحه کامل `#/tele` به‌جای مودال، با همان ساختار چت داخلی (sidebar + chat-pane، موبایل تک‌ستونه)
- فهرست گفتگو: آخرین پیام، زمان، نخوانده، آیکون نوع؛ زبانه‌های همه/خصوصی/گروه/کانال؛ جستجو با اسم
- پیام‌ها: حباب، جداکننده روز، اسم و آواتار فرستنده در گروه، برچسب رسانه‌ها، بارگذاری قدیمی‌ترها، دریافت خودکار پیام جدید
- جستجو در کل تاریخچه گفتگو (`searchChatMessages`)

### سرور
- مایگریشن v10: `sender_id` / `sender_name` برای پیام‌ها؛ `last_text` / `last_at` / `last_out` / `unread` برای گفتگوها
- زمان واقعی پیام از تلگرام، اسم فرستنده با `getUser` / `getChat` (کش‌شده)، `loadChats` قبل از `getChats`
- `GET /api/tele/dialogs/:id/messages?before=` و `GET /api/tele/dialogs/:id/search?q=`
- باز کردن گفتگو: `openChat` + `viewMessages`؛ نیازی به انتخاب دستی گفتگو نیست

## [1.0.3] — 2026-10-29

### رفع اشکال
- ورود با شماره: سازگاری با `tdl` 8 (بدون `connect()`)، انتظار برای وضعیت TDLib قبل از ارسال شماره
- `addProxy` با امضای جدید (و قدیمی به‌عنوان جایگزین)؛ خطای آن ورود را متوقف می‌کند (fail-closed)
- وضعیت `awaiting_code` فقط بعد از پذیرش شماره ثبت می‌شود؛ ورود ناموفق یا نیمه‌کاره به مرحله شماره برمی‌گردد
- مرحله رمز دومرحله‌ای بعد از کد درست تشخیص داده می‌شود
- پیام خطای واقعی TDLib به کاربر نشان داده می‌شود (به‌جای «خطای داخلی سرور»)

## [1.0.2] — 2026-10-29

### رفع اشکال
- تونل بعد از Probe موفق، تغییر سیاست، ویرایش/حذف پروکسی و راه‌اندازی سرور خودکار با پروکسی انتخاب‌شده روشن می‌شود
- ری‌استارت تونل وضعیت را اشتباه «خاموش» نمی‌زند (رقابت بین پروسه قدیم و جدید sing-box)
- خطای شروع sing-box گزارش می‌شود؛ پنل کاربر دلیل خاموش بودن را نشان می‌دهد

## [1.0.1] — 2026-10-29

### رفع اشکال
- سایدبار کامل برگشت (کانال‌های صوتی، نوار آپدیت اندروید، چند سرور، آیکون‌ها، منوی گفتگو) + گزینه Tele
- `amorechat-update` و `deploy/update.sh` از `amor7/AmoreChat-Tele` آپدیت می‌گیرند (نه `amor7/AmoreChat`)
- `package-lock.json` با `tdl` / `prebuilt-tdlib` هماهنگ شد؛ ساخت Docker و CI دوباره سالم است
- حذف ورک‌فلوی خراب `tele-patch.yml`
- نسخه `package.json` = 1.0.1 (قبلاً 0.9.14 بود)

### آپدیت سرورهایی که v1.0.0 دارند
دستور `amorechat-update` نصب‌شده روی این سرورها هنوز به ریپوی قدیمی اشاره می‌کند؛ یک بار این را بزنید (بعد از آن `sudo amorechat-update` کافی است):

```bash
cd /path/to/amorechat-tele && curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/update.sh -o /tmp/tele-update.sh && sudo AMORECHAT_DIR="$PWD" AMORECHAT_REPO=amor7/AmoreChat-Tele bash /tmp/tele-update.sh v1.0.1
```

## [1.0.0] — 2026-10-29

اولین ریلیز مستقل **AmoreChat-Tele**.

### ویژگی‌ها
- پیام‌رسان کامل self-hosted (چت، گروه، کانال، تماس، ویس‌چت، استریم، PWA، اپ اندروید)
- لایه **Tele**: اتصال حساب شخصی تلگرام هر کاربر داخل اپ
- **VPN/پروکسی فقط روی سرور** — کاربر نهایی VPN نصب نمی‌کند
- پشتیبانی پروکسی: SOCKS5، HTTP، Shadowsocks، VLESS، VMess، Trojan، **WireGuard**، JSON outbound (Reality و …)
- fail-closed: بدون پروکسی سالم، اتصال مستقیم به تلگرام برقرار نمی‌شود
- پنل ادمین Tele / VPN با سیاست priority / best / random / manual و Probe
- UI کاربر: لاگین شماره/کد/۲FA، انتخاب گفتگو، ارسال و دریافت متن

### اسناد
- README مخصوص AmoreChat-Tele (نه AmoreChat)
- docs/TELE-SETUP.md و docs/TELE-ARCHITECTURE.md

### وابستگی‌های اختیاری
- `tdl` + `prebuilt-tdlib` برای TDLib
- باینری `sing-box` برای egress
