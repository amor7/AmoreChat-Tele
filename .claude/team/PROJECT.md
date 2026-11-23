# AmoreChat-Tele — حافظه‌ی تیم

> ساخته‌شده با /onboard در 2026-11-23 (نسخه‌ی 1.0.39). بخش‌هایی که با (حدس) علامت خورده‌اند تأیید نشده‌اند.

## خلاصه
پیام‌رسان فارسی self-hosted (چت، گروه، کانال، تماس، ویس‌چت، استریم، موزیک؛ وب PWA + اپ اندروید) با «پل تلگرام» (Tele):
هر کاربر حساب تلگرام خودش را وصل می‌کند و فقط ترافیک تلگرام از پروکسی/VPN مالک سرور خارج می‌شود.
برای روزهای قطعی اینترنت بین‌الملل در ایران ساخته شده. وضعیت: فعال، انتشار مرتب با tag و release امضاشده. ریپو public است.

## اصل اول پروژه (از کاربر — هرگز نقض نشود)
- **سرور باید بدون اینترنت بین‌الملل کامل کار کند**: نصب، آپدیت، بکاپ، اجرا. هیچ وابستگی runtime به سرویس خارجی (CDN، Google، فونت آنلاین، npm/apt هنگام اجرا یا آپدیت، سرور زمان/DNS خارجی).
- **کاربران روی نت محدود/داخلی و بدون نت بین‌الملل باید همه‌ی امکانات را داشته باشند**؛ اینترنت کند و ناپایدار حالت عادی است، نه استثنا.
- فقط ترافیک تلگرام بیرون می‌رود و آن هم fail-closed است (هرگز اتصال مستقیم).
- هر پیشنهاد/فیچر باید با `docker-compose.isolated.yml` (شبکه‌ی بدون اینترنت) قابل تست باشد.

## ترجیحات کاربر
- اولویت: همه با هم — پایداری، امنیت، فیچر، کارایی.
- مقیاس: معمولاً **کمتر از ۵۰ کاربر در هر سرور**؛ perf فقط مشکلاتی را مهم بداند که در این مقیاس یا روی سرور ضعیف/نت کند واقعاً اثر دارند.
- متن‌های کاربر و README فارسی و RTL؛ کامنت‌های کد انگلیسی و درباره‌ی «چرا».
- هر تغییر رفتار → bump نسخه در هر سه package.json + یک خط در CHANGELOG (الگوی commitهای قبلی: `...; v1.0.X`).
- کار روی branch و PR (الگوی `fix/...`، `feat/...`، `ci/...`)، نه مستقیم روی main.

## تکنولوژی
- Node >=24، ESM (`"type":"module"`)، npm workspaces: `server`، `web`.
- سرور: Fastify ^5.12 (+cookie، multipart، rate-limit، static)، Socket.IO ^4.8، SQLite داخلی Node (`node:sqlite`، WAL).
- تلگرام: `tdl` ^8.1 + `prebuilt-tdlib` (TDLib)؛ خروجی با sing-box 1.14.4 (SOCKS محلی 127.0.0.1:17890) و OpenVPN؛ MTProto مستقیم به TDLib.
- رسانه/تماس: ffmpeg؛ LiveKit (سرور v1.13.7، `livekit-client` 2.22.3 قفل دقیق).
- وب: React ^19.3، Vite ^8.3، vite-plugin-pwa، zustand ^5، lucide-react، فونت Vazirmatn (محلی).
- اندروید: Java 17، compileSdk/targetSdk 35، minSdk 26، اساساً WebView؛ versionCode از نسخه‌ی package.json ریشه.
- زیرساخت: Docker، Caddy 2.11.7 (TLS)، tini.

## ساختار
| مسیر | نقش |
|---|---|
| `server/src/index.js` | نقطه‌ی ورود: Fastify، routeها، Socket.IO، حلقه‌های Tele، چاپ SETUP CODE |
| `server/src/routes/*.js` | هر فایل یک پلاگین Fastify (default export) |
| `server/src/db.js` | SQLite، cache prepared statement، **migrationها (آرایه، فقط append)** |
| `server/src/tele/` | پل تلگرام: `accounts.js` (نشست/TDLib)، `messages.js`، `egress.js`/`proxies.js`/`uri.js`/`ovpn.js` (خروجی)، `mirror.js` (کپی کانال)، `explore.js`، `alerts.js`، `access.js` |
| `server/src/routes/tele.js` | API تلگرام |
| `server/*-cli.js` | backup، reset-password، unban |
| `server/ovpn/*.sh` | سرویس OpenVPN مخصوص Tele |
| `server/test/` | unit (`*.test.mjs`) و اسکریپت‌های e2e |
| `web/src/` | `main.jsx`→`App.jsx`، `store.js` (zustand)، `api.js`، `socket.js`، `rtc.js`؛ کامپوننت‌ها در `components/` (Tele: `TeleView`، `TeleAdmin`، `TeleProxyForm`، `TeleForward`) |
| `android/` | اپ Java: `MainActivity`، `CallService`، `MusicService`، `NotifyService`، `Updater`، assets `setup.html`/`offline.html` |
| `tools/` | پکیج Node جدا برای eslint و اجرای unit test (عمداً جدا تا runtime id عوض نشود) |
| `deploy/` | نصب، آپدیت آفلاین، watchdog، امضای release، Caddyfile، livekit.yaml |
| `docs/` | `OFFLINE-INSTALL.md`، `TELE-SETUP.md`، `TELE-ARCHITECTURE.md` |
| `.github/workflows/` | ci، ci-e2e، android، release، release-tag، security، soak، tele-e2e، tele-login |

## دستورها
```bash
npm ci                                   # نصب (CI از npm ci استفاده می‌کند)
npm run dev:server                       # سرور dev روی 3000 (node --watch)
npm run dev:web                          # vite روی 5173
npm run build                            # build وب → web/dist
npm start                                # اجرای سرور
npm ci --prefix tools && npm run lint --prefix tools && npm test --prefix tools   # lint + unit test
node server/test/<name>.mjs              # تست‌های e2e (نیاز به سرور در حال اجرا و SETUP CODE)
gradle -p android --no-daemon assembleDebug   # اندروید (Gradle 8.11.1، JDK 17)
docker compose up -d --build             # کل پشته
docker compose -f docker-compose.isolated.yml ...   # تست بدون اینترنت (job isolated در ci.yml)
```
نصب روی سرور: `cp .env.example .env && sudo bash deploy/install.sh` · آپدیت: `sudo amorechat-update [vX.Y.Z | /path/to/folder]`
`npm test` در ریشه وجود ندارد.

## قراردادها
- ESM با پسوند صریح `.js` و `node:` برای ماژول‌های داخلی؛ تست‌ها `.mjs`.
- فایل‌های سرور kebab-case کوتاه؛ کامپوننت‌ها PascalCase.jsx؛ ستون DB snake_case؛ JS camelCase؛ helperهای کوتاه (`get`، `all`، `run`، `tx`، `bad`).
- SQL خام با prepared statement (بدون ORM).
- migration: **فقط به انتهای آرایه در `db.js` اضافه کن**؛ هرگز ورودی قدیمی را عوض یا جابه‌جا نکن (`PRAGMA user_version`).
- خطا: `Object.assign(new Error(msg), { statusCode, expose: true })` و error handler مرکزی (`index.js`).
- route عمومی/بدون CSRF با `config: { public, noCsrf }`؛ CSRF با هدر `x-requested-with: amorechat`.
- تنظیمات از env (`DATA_DIR`، `PORT`، `TELE_*`).

## نقاط حساس
- **کلید نشست تلگرام** (`server/src/tele/accounts.js:192-218`): از `TELE_SESSION_KEY` در `.env`؛ اگر نباشد کلید در `DATA_DIR/tele-sessions/.key` کنار نشست‌ها ساخته می‌شود. عوض یا گم شدن کلید = از کار افتادن بی‌صدای همه‌ی نشست‌ها. هر تغییر در deploy/backup/restore باید حفظش کند.
- **migrationها** در `db.js` (الان v25).
- **ماژول‌های بزرگ و درهم Tele**: `TeleView.jsx` (~1258 خط)، `TeleAdmin.jsx` (~1043)، `accounts.js`، `messages.js`، `routes/tele.js` (~569، import از ~15 ماژول)؛ unit test ندارند → تغییر در Tele شعاع اثر بزرگ دارد.
- **سرویس `ovpn`** در compose با `user: root` و `NET_ADMIN` و دسترسی به `./data`.
- **زنجیره‌ی release**: امضا با `deploy/release-signing.pub` و `verify-release.sh`؛ نصب یک‌خطی `curl | sudo bash` از `deploy/get.sh`.
- نسخه در سه package.json تکرار شده (ریشه، server، web).

متغیرهای محیطی (فقط نام): `DOMAIN`، `TLS_MODE` (auto/internal/custom/off)، `ALSO_IP`، `ALLOW_HTTP`، `BACKUP_KEEP`، `LOG_LEVEL`، `PUBLIC_IP`، `LIVEKIT_API_SECRET`، `TELEGRAM_API_ID`، `TELEGRAM_API_HASH`، `SING_BOX_PATH`، `TELE_SOCKS_PORT`، `TELE_IDLE_MINUTES`، `TELE_SESSION_KEY`؛ در compose ولی نه در `.env.example`: `BACKUP_MIRROR_DIR`، `LIVEKIT_API_KEY`.

## تست‌ها
- unit فقط دو فایل: `server/test/handles.test.mjs`، `uri.test.mjs` (`node --test` از طریق `tools/test.mjs`).
- e2e زیاد و بدون فریم‌ورک (smoke، account، pentest، storage، rtc-api، tele-local، ...) + puppeteer (ui/rtc/crowd/soak) + shell (ovpn-e2e، recovery-e2e، watchdog، netem) + تلگرام واقعی روی test DC (`tele-e2e.yml`).
- پوشش unit بسیار کم: منطق tele و کل `web/src` تست واحد ندارند؛ ابزار coverage نیست.

## اعضای فعال تیم
همه فعال (پروژه UI وب و اندروید دارد، پس ux فعال است). devops برای هر تغییر در deploy/Docker/CI و هر چیزی که به حالت آفلاین ربط دارد حتماً رأی بدهد.
