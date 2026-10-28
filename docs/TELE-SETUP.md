# راه‌اندازی Tele + VPN

## ۱. نصب پایه
نصب عادی AmoreChat-Tele (Docker یا Node). ریپو: `amor7/AmoreChat-Tele`.

## ۲. متغیرها در `.env`
```
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef...
# اختیاری:
# SING_BOX_PATH=/usr/local/bin/sing-box
# TELE_SOCKS_PORT=17890
# DATA_DIR=./data
```
api_id و api_hash از https://my.telegram.org (اپلیکیشن خودتان).

## ۳. وابستگی‌های اختیاری (TDLib)
```bash
cd server && npm i tdl prebuilt-tdlib
```
بدون این‌ها لاگین و همگام‌سازی پیام کار نمی‌کند؛ UI و پنل ادمین همچنان باز می‌شوند و وضعیت «TDLib لازم است» نشان می‌دهند.

## ۴. باینری sing-box (تونل VPN سرور)
روی لینوکس:
```bash
# مثال: دانلود آخرین release از https://github.com/SagerNet/sing-box/releases
# و قرار دادن در PATH یا:
export SING_BOX_PATH=/usr/local/bin/sing-box
```
بدون sing-box، ادمین می‌تواند پروکسی اضافه کند ولی تونل واقعی بالا نمی‌آید (fail-closed: تلگرام مستقیم وصل نمی‌شود).

## ۵. ادمین — پنل Tele / VPN
1. وارد حساب owner/admin شوید.
2. پنل مدیریت → تب **Tele / VPN**.
3. «فعال‌سازی Tele egress» را روشن کنید.
4. لینک‌ها را اضافه کنید (هر خط یکی):
   - `socks5://user:pass@host:1080`
   - `http://host:8080`
   - `ss://...`
   - `vless://...` / `vmess://...` / `trojan://...`
   - یا یک **JSON outbound کامل sing-box** برای Reality و لینک‌های پیچیده
5. روی هر ردیف **تست (Probe)** بزنید تا وضعیت healthy شود.
6. در صورت نیاز **ری‌استارت تونل**.

سیاست‌ها: priority (failover)، best (کمترین تأخیر)، random، manual.

## ۶. کاربر — Tele
منوی کناری → **Tele (تلگرام)**:
1. شماره با کد کشور (+98…)
2. کد پیامکی / اپ
3. در صورت نیاز رمز دو مرحله‌ای
4. «همگام‌سازی» برای لیست گفتگوها
5. تیک «نمایش» روی گفتگوهای مورد نظر
6. باز کردن گفتگو و ارسال/دریافت متن

## اصل امنیتی
- ترافیک **فقط بخش Tele** از پروکسی‌های ادمین عبور می‌کند.
- چت داخلی AmoreChat همیشه روی شبکه داخلی سرور می‌ماند.
- اگر هیچ پروکسی سالمی نباشد، Tele به تلگرام **مستقیم وصل نمی‌شود** (fail-closed).
- نشست TDLib و کانفیگ پروکسی خارج از مسیرهای عمومی نگه‌داری می‌شوند.

## عیب‌یابی سریع
| علامت | علت محتمل |
|--------|------------|
| API: خیر | `TELEGRAM_API_ID` / `HASH` در env نیست |
| TDLib: خیر | `npm i tdl prebuilt-tdlib` در server |
| تونل خاموش | sing-box نصب نیست یا policy.enabled=false |
| «هیچ پروکسی سالمی» | هنوز Probe نزده‌اید یا همه unhealthy |
| لاگین گیر کرده | egress را ری‌استارت کنید؛ session در `data/tele-sessions` |
