# AmoreChat-Tele Changelog

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
