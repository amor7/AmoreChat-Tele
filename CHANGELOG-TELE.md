# AmoreChat-Tele Changelog

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
