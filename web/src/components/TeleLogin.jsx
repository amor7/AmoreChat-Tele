import { useEffect, useState } from 'react';
import { toFa, faDigits } from '../util';
import { disconnectTele, loginPhone, loginCode, loginPassword, resendLoginCode } from '../teleApi';
import { Check, LogOut, Send, ShieldCheck, TriangleAlert } from 'lucide-react';

// ---------- Login (phone → code → two-step password) ----------
const CODE_WHERE = {
  app: 'کد به اپ تلگرام شما (روی دستگاه دیگری که وارد هستید) فرستاده شد.',
  sms: 'کد با پیامک فرستاده شد.',
  call: 'کد با تماس تلفنی گفته می‌شود.',
  flash: 'تلگرام با شما تماس می‌گیرد؛ کد، رقم‌های آخر شماره تماس‌گیرنده است.',
  missed: 'تلگرام یک تماس بی‌پاسخ می‌دهد؛ کد، رقم‌های آخر شماره تماس‌گیرنده است.',
  fragment: 'کد در Fragment فرستاده شد.',
};
const CODE_NEXT = { sms: 'ارسال کد با پیامک', call: 'دریافت کد با تماس تلفنی', flash: 'دریافت کد با تماس', missed: 'دریافت کد با تماس بی‌پاسخ', fragment: 'ارسال کد در Fragment' };
const LOGIN_STEPS = ['شماره', 'کد', 'رمز'];
const LOGIN_TITLE = { disconnected: 'اتصال به تلگرام', awaiting_code: 'کد ورود را بنویسید', awaiting_password: 'رمز تلگرامتان را بنویسید' };
export default function TeleLogin({ status, reload }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phase = status.account?.status || 'disconnected';
  const runtime = status.runtime || {};
  const ready = runtime.apiConfigured && runtime.tdlAvailable;
  const step = Math.max(0, ['disconnected', 'awaiting_code', 'awaiting_password'].indexOf(phase));
  const info = status.codeInfo;
  // Telegram offers the other way (SMS, a call) only after its timeout.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== 'awaiting_code') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const wait = info?.timeout ? Math.max(0, Math.ceil((info.at + info.timeout * 1000 - now) / 1000)) : 0;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      // Keep the reason on screen and show the step the server is really on.
      setError(e.message);
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const cancel = () =>
    run(async () => {
      setCode('');
      setPassword('');
      await disconnectTele();
    });
  const submit = (send) => (e) => {
    e.preventDefault();
    run(send);
  };

  return (
    <div className="empty-pane tele-login">
      <span className="tele-logo">
        <Send size={34} />
      </span>
      <h2>{LOGIN_TITLE[phase] || LOGIN_TITLE.disconnected}</h2>
      <ol className="tele-login-steps" aria-label={`مرحله ${toFa(step + 1)} از ${toFa(LOGIN_STEPS.length)}`}>
        {LOGIN_STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'now' : i < step ? 'done' : ''}>
            <span>{i < step ? <Check size={13} /> : toFa(i + 1)}</span>
            {label}
          </li>
        ))}
      </ol>
      {!ready && (
        <div className="tele-block">
          <TriangleAlert size={17} /> تلگرام هنوز روی این سرور راه‌اندازی نشده است. به مدیر خبر دهید.
        </div>
      )}
      {ready && !runtime.egress?.running && runtime.egress?.lastError && (
        <div className="tele-block" title={runtime.egress.lastError}>
          <TriangleAlert size={17} /> اتصال سرور به تلگرام الان قطع است؛ ممکن است ورود انجام نشود.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {phase === 'disconnected' && ready && (
        <>
          <form className="form" onSubmit={submit(() => loginPhone(phone))}>
            <label>
              شماره موبایل تلگرام
              <input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+98912…" autoFocus />
            </label>
            <button className="btn primary" disabled={busy || !phone.trim()}>
              {busy ? 'در حال ارسال…' : 'دریافت کد'}
            </button>
          </form>
          <ul className="tele-perks">
            <li>
              <ShieldCheck size={16} /> پیام‌های تلگرام شما فقط برای خودتان است
            </li>
            <li>
              <Check size={16} /> روی گوشی به VPN نیاز ندارید
            </li>
            <li>
              <LogOut size={16} /> هر وقت بخواهید با یک دکمه خارج می‌شوید
            </li>
          </ul>
        </>
      )}
      {phase === 'awaiting_code' && (
        <form className="form" onSubmit={submit(() => loginCode(code))}>
          <p className="hint">{CODE_WHERE[info?.via] || 'کد را از اپ تلگرام یا پیامک بگیرید.'}</p>
          {info?.via === 'app' && <p className="hint">اگر اینترنت گوشی قطع است و کد به اپ تلگرام نمی‌رسد، کد را با پیامک یا تماس بخواهید (پیامک و تماس اینترنت لازم ندارد).</p>}
          <label>
            کد ورود
            <input className="tele-code" dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy || !code.trim()}>
              تأیید
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              شماره دیگر
            </button>
          </div>
          {info?.next ? (
            <button type="button" className="btn tele-resend" disabled={busy || wait > 0} onClick={() => run(resendLoginCode)}>
              {CODE_NEXT[info.next] || 'ارسال دوباره کد از راه دیگر'}
              {wait > 0 ? ` (${faDigits(String(Math.floor(wait / 60)))}:${faDigits(String(wait % 60).padStart(2, '0'))})` : ''}
            </button>
          ) : (
            info && <small className="muted">تلگرام فعلاً راه دیگری برای فرستادن کد پیشنهاد نمی‌کند؛ اگر نرسید، چند دقیقه بعد با «شماره دیگر» دوباره شماره را بفرستید.</small>
          )}
        </form>
      )}
      {phase === 'awaiting_password' && (
        <form className="form" onSubmit={submit(() => loginPassword(password))}>
          <label>
            رمز تأیید دومرحله‌ای تلگرام
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy || !password}>
              ورود
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              انصراف
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
