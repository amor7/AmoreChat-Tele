# راه‌اندازی Tele + VPN (AmoreChat-Tele v1)

این سند مخصوص **AmoreChat-Tele** است — پروژهٔ مستقل پیام‌رسان + پل تلگرام.

## ۱. نصب پایه

```bash
# از سورس
git clone https://github.com/amor7/AmoreChat-Tele.git
cd AmoreChat-Tele

# یا نصب یک‌خطی (بعد از انتشار ریلیز):
# curl -fsSL https://raw.githubusercontent.com/amor7/AmoreChat-Tele/main/deploy/get.sh | sudo bash
```

## ۲. متغیرها در `.env`

```env
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef...
# SING_BOX_PATH=/usr/local/bin/sing-box
# TELE_SOCKS_PORT=17890
```

api_id / api_hash از https://my.telegram.org

## ۳. TDLib (لاگین تلگرام)

```bash
cd server && npm i tdl prebuilt-tdlib
```

بدون این پکیج‌ها، UI باز می‌شود ولی ورود واقعی تلگرام ممکن نیست.

## ۴. sing-box (تونل VPN فقط برای تلگرام)

باینری [sing-box](https://github.com/SagerNet/sing-box/releases) را نصب کنید و در PATH بگذارید یا `SING_BOX_PATH` را تنظیم کنید.

## ۵. پروتکل‌های پشتیبانی‌شده (ادمین → Tele / VPN)

| نوع | فرمت ورودی |
|-----|------------|
| SOCKS5 | `socks5://user:pass@host:1080` |
| HTTP | `http://host:8080` |
| Shadowsocks | `ss://...` |
| VLESS | `vless://...` |
| VMess | `vmess://...` |
| Trojan | `trojan://...` |
| **WireGuard** | فایل `.conf` استاندارد یا JSON outbound sing-box |
| Reality / پیچیده | JSON outbound کامل sing-box |

OpenVPN / Hysteria2 / TUIC در لیست هستند؛ برای آن‌ها فعلاً JSON outbound دستی توصیه می‌شود.

## ۶. ادمین

1. پنل مدیریت → **Tele / VPN**
2. فعال‌سازی Tele egress
3. افزودن لینک / کانفیگ → **Probe** تا healthy شود
4. در صورت نیاز ری‌استارت تونل

## ۷. کاربر

منو → **Tele (تلگرام)** → شماره → کد → همگام‌سازی گفتگوها → تیک نمایش → چت

## اصل امنیتی

- فقط ترافیک Tele از پروکسی عبور می‌کند.
- چت داخلی همیشه روی شبکه داخلی سرور می‌ماند.
- بدون پروکسی سالم، تلگرام **مستقیم وصل نمی‌شود** (fail-closed).
