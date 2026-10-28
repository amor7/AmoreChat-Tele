# راه‌اندازی Tele + VPN

## ۱. پیام‌رسان
نصب عادی AmoreChat-Tele (Docker یا Node).

## ۲. متغیرها در `.env`
```
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
# SING_BOX_PATH=/usr/local/bin/sing-box
# TELE_SOCKS_PORT=17890
```
api_id/hash از https://my.telegram.org

## ۳. وابستگی‌ها
```bash
npm i tdl prebuilt-tdlib -w server
# نصب باینری sing-box روی سرور و در PATH
```

## ۴. ادمین
پنل مدیریت → **Tele / VPN** → افزودن لینک پروکسی (socks5 / http / ss / vless / vmess / trojan یا JSON outbound) → فعال‌سازی سیاست → Probe.

## ۵. کاربر
منو → **Tele (تلگرام)** → شماره → کد → انتخاب گفتگوها → چت.

## اصل امنیتی
بدون پروکسی سالم، Tele به تلگرام مستقیم وصل نمی‌شود. چت داخلی روی نت داخلی می‌ماند.
