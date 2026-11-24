import { useEffect, useRef, useState } from 'react';
import { Lock, LockKeyhole, ShieldOff, KeyRound, TriangleAlert } from 'lucide-react';
import { api, TELE_LOCK_EVENT } from '../api';
import { useStore } from '../store';
import { toFa, faDigits } from '../util';
import { clearDrafts } from '../drafts';
import { IDLE_CHOICES, PASSCODE_MIN, PASSCODE_MAX, passcodeProblem, isNumericPasscode, secondsLeft, clockText, lockedUntilFrom } from '../tele-lock-rules';
import { Modal } from './Modals';

// The user's own passcode for the Telegram section (server/src/tele/passcode.js): the settings
// part and the lock screen. Only the user can set, change or remove it; an admin cannot.

const IDLE_LABEL = (m) => (m ? (m === 60 ? 'بعد از ۱ ساعت بی‌فعالیتی' : `بعد از ${toFa(m)} دقیقه بی‌فعالیتی`) : 'فقط با خروج از برنامه یا راه‌اندازی دوباره سرور');

export const FORGET_RISK = 'اگر فراموشش کنید، تنها راه برداشتنش قطع حساب تلگرام و پاک شدن تاریخچه‌ی ذخیره‌شده است.';

export const FORGOT_WARNING = 'حساب تلگرام قطع و تاریخچه‌ی ذخیره‌شده پاک می‌شود. برای وصل شدن دوباره کد تلگرام لازم است که در روزهای قطعی ممکن است نرسد. کانال‌های آینه‌ای (mirror) متوقف می‌شوند.';

// Whether the lock screen opens the number pad: remembered on this device when the passcode is
// set here, and switchable on the lock screen itself (the server never says what it looks like).
const PAD_KEY = 'amore.teleLockPad';
const padIsNumeric = () => {
  try {
    return localStorage.getItem(PAD_KEY) === 'numeric';
  } catch {
    return false;
  }
};
const rememberPad = (numeric) => {
  try {
    localStorage.setItem(PAD_KEY, numeric ? 'numeric' : 'text');
  } catch {
    /* storage blocked: the default keyboard then */
  }
};

// Fired when any lock screen opens the lock, so the others on the page (the Telegram page behind
// a forward dialog) follow without a second passcode.
const UNLOCK_EVENT = 'amore-tele-unlocked';
const announceUnlock = () => {
  try {
    window.dispatchEvent(new CustomEvent(UNLOCK_EVENT));
  } catch {
    /* no window */
  }
};

/** Listens for any 423 heard by api.js (onLocked) and for an unlock done elsewhere (onUnlocked). */
export function useTeleLockEvent(onLocked, onUnlocked) {
  const ref = useRef({ onLocked, onUnlocked });
  ref.current = { onLocked, onUnlocked };
  useEffect(() => {
    const lock = () => ref.current.onLocked?.();
    const unlock = () => ref.current.onUnlocked?.();
    window.addEventListener(TELE_LOCK_EVENT, lock);
    window.addEventListener(UNLOCK_EVENT, unlock);
    return () => {
      window.removeEventListener(TELE_LOCK_EVENT, lock);
      window.removeEventListener(UNLOCK_EVENT, unlock);
    };
  }, []);
}

function IdleSelect({ value, onChange }) {
  return (
    <label className="tele-pass-field">
      قفل خودکار
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {IDLE_CHOICES.map((m) => (
          <option key={m} value={m}>
            {IDLE_LABEL(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Telegram passcode fields in settings: the server takes at most PASSCODE_MAX characters.
function PasscodeInput({ value, onChange, placeholder, label, autoFocus, numeric }) {
  return (
    <input
      type="password"
      className="tele-pass-input"
      placeholder={placeholder}
      aria-label={label || placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={numeric ? 'numeric' : 'text'}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      dir="ltr"
      maxLength={PASSCODE_MAX}
      autoFocus={autoFocus}
    />
  );
}

/** Settings → Security: turn the passcode on, change it, or turn it off. */
export function TelePasscodeSettings() {
  const showToast = useStore((s) => s.showToast);
  const [info, setInfo] = useState(null); // GET /tele/passcode; null until known (hidden on error)
  const [step, setStep] = useState('idle'); // idle | enable | change | disable
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [idleMin, setIdleMin] = useState(15);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('GET', '/tele/passcode')
      .then((r) => (setInfo(r), setIdleMin(r.idleMin ?? 15)))
      .catch(() => setInfo(false));
  useEffect(() => {
    load();
  }, []);

  const reset = () => {
    setStep('idle');
    setPassword('');
    setCurrent('');
    setNext('');
    setAgain('');
    setError('');
    if (info) setIdleMin(info.idleMin ?? 15);
  };
  const open = (s) => (reset(), setStep(s));
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };
  // The new passcode (and its repeat) checked here before the server checks it again.
  const newProblem = () => passcodeProblem(next) || (next !== again ? 'تکرار رمز تلگرام با خودش یکی نیست' : '');

  const enable = (e) => {
    e.preventDefault();
    const p = newProblem();
    if (p) return setError(p);
    run(async () => {
      await api('POST', '/tele/passcode', { password, passcode: next, idleMin });
      rememberPad(isNumericPasscode(next));
      showToast('رمز تلگرام روشن شد');
      reset();
      await load();
    });
  };
  const change = (e) => {
    e.preventDefault();
    if (next || again) {
      const p = newProblem();
      if (p) return setError(p);
    }
    run(async () => {
      await api('PATCH', '/tele/passcode', { current, ...(next ? { next } : {}), idleMin });
      if (next) rememberPad(isNumericPasscode(next));
      showToast(next ? 'رمز تلگرام عوض شد؛ دستگاه‌های دیگر قفل شدند' : 'تنظیم قفل خودکار ذخیره شد');
      reset();
      await load();
    });
  };
  // Locks this login's Telegram section now; the Telegram screens hear it like a 423.
  const lockNow = () =>
    run(async () => {
      setInfo(await api('POST', '/tele/passcode/lock', {}));
      try {
        window.dispatchEvent(new CustomEvent(TELE_LOCK_EVENT));
      } catch {
        /* no window */
      }
      showToast('بخش تلگرام قفل شد');
    });
  const disable = (e) => {
    e.preventDefault();
    run(async () => {
      await api('DELETE', '/tele/passcode', { current });
      showToast('رمز تلگرام خاموش شد');
      reset();
      await load();
    });
  };

  if (!info) return null;

  const note = (
    <ul className="muted tiny tele-pass-note">
      <li>محافظت می‌کند در برابر: مدیرها (از پنل مدیریت یا با ریست رمز حسابتان) و بکاپ‌ها؛ پیام‌های تلگرام در بکاپ نمی‌آید.</li>
      <li>محافظت نمی‌کند در برابر: کسی که روی خود سرور دسترسی مستقیم (shell یا root) دارد.</li>
      <li>بعد از راه‌اندازی دوباره‌ی سرور یا خروج از حساب، دوباره رمز لازم است.</li>
    </ul>
  );

  // The heading lives here so an old server (no passcode API) shows no empty section.
  const title = <h5>رمز تلگرام</h5>;
  if (step !== 'idle')
    return (
      <>
      {title}
      <form className="twofa-box" onSubmit={step === 'enable' ? enable : step === 'change' ? change : disable}>
        {step === 'enable' && (
          <input type="password" placeholder="رمز عبور حساب (همین برنامه)" aria-label="رمز عبور حساب (همین برنامه)" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" autoComplete="current-password" autoFocus />
        )}
        {step !== 'enable' && <PasscodeInput value={current} onChange={setCurrent} placeholder="رمز تلگرام فعلی" autoFocus numeric={padIsNumeric()} />}
        {step !== 'disable' && (
          <>
            <PasscodeInput value={next} onChange={setNext} placeholder={step === 'change' ? 'رمز تلگرام تازه (اگر نمی‌خواهید عوض شود، خالی بگذارید)' : `رمز تلگرام (${toFa(PASSCODE_MIN)} تا ${toFa(PASSCODE_MAX)} کاراکتر)`}
              label={step === 'change' ? 'رمز تلگرام تازه' : 'رمز تلگرام'}
            />
            {(step === 'enable' || next) && <PasscodeInput value={again} onChange={setAgain} placeholder="تکرار رمز تلگرام" />}
            <IdleSelect value={idleMin} onChange={setIdleMin} />
          </>
        )}
        {step === 'enable' && <p className="muted tiny">این رمز با رمز حساب فرق دارد و فقط بخش تلگرام را باز می‌کند. جایی امن نگهش دارید.</p>}
        {step !== 'disable' && (
          <p className="tele-pass-risk tiny">
            <TriangleAlert size={14} aria-hidden="true" /> {FORGET_RISK}
          </p>
        )}
        {step === 'enable' && note}
        {step === 'change' && <p className="muted tiny">با عوض کردن رمز، بخش تلگرام روی دستگاه‌های دیگرتان قفل می‌شود.</p>}
        {step === 'disable' && <p className="muted tiny">بعد از خاموش کردن، هر کس وارد حساب شما شود به تلگرامتان هم می‌رسد.</p>}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="row-gap">
          <button type="button" className="btn" onClick={reset}>
            انصراف
          </button>
          <button className={`btn ${step === 'disable' ? 'danger' : 'primary'}`} disabled={busy || (step === 'enable' && (!password || !next)) || (step !== 'enable' && !current)}>
            {step === 'enable' ? 'روشن کردن' : step === 'change' ? 'ذخیره' : 'خاموش کردن'}
          </button>
        </div>
      </form>
      </>
    );

  return (
    <>
      {title}
      {info.enabled ? (
        <div className="twofa-status on">
          <LockKeyhole size={22} />
          <div>
            <b>رمز تلگرام فعال است</b>
            <div className="muted tiny">قفل خودکار: {IDLE_LABEL(info.idleMin)}</div>
          </div>
          <div className="row-gap tele-pass-actions">
            {info.unlocked && (
              <button className="btn sm" disabled={busy} onClick={lockNow}>
                <Lock size={16} /> همین حالا قفل کن
              </button>
            )}
            <button className="btn sm" onClick={() => open('change')}>
              <KeyRound size={16} /> تغییر
            </button>
            <button className="btn sm" onClick={() => open('disable')}>
              <ShieldOff size={16} /> خاموش
            </button>
          </div>
        </div>
      ) : (
        <div className="twofa-status">
          <Lock size={22} />
          <div>
            <b>رمز تلگرام خاموش است</b>
            <div className="muted tiny">با روشن کردنش، بخش تلگرام فقط با رمزی که خودتان می‌دانید باز می‌شود.</div>
          </div>
          <button className="btn sm primary" onClick={() => open('enable')}>
            روشن کردن
          </button>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {note}
    </>
  );
}

/**
 * Shown instead of everything Telegram while it is locked. Clears this user's Telegram drafts on
 * this device (they are Telegram text too). compact: inside another dialog (no "forgot" there,
 * it would open a dialog over a dialog; the Telegram page has it).
 */
export function TeleLockScreen({ onUnlocked, compact = false }) {
  const uid = useStore((s) => s.me?.id || 0);
  const showToast = useStore((s) => s.showToast);
  const [passcode, setPasscode] = useState('');
  const [numeric, setNumeric] = useState(padIsNumeric);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [forgot, setForgot] = useState(false);
  const inputRef = useRef(null);
  const opened = () => {
    onUnlocked?.();
    announceUnlock();
  };

  // Runs after the open chat (if any) is gone and has written its draft; then nothing is left.
  useEffect(() => {
    if (uid) clearDrafts(uid, 'tele');
  }, [uid]);

  // Ask once whether a wrong-tries wait is running (or another tab already unlocked this login).
  useEffect(() => {
    let off = false;
    api('GET', '/tele/passcode')
      .then((r) => {
        if (off) return;
        if (!r.enabled || r.unlocked) opened();
        else setUntil(Number(r.lockedUntil) || 0);
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const wait = secondsLeft(until, now);
  useEffect(() => {
    if (!wait) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    if (!passcode || busy || wait) return;
    setBusy(true);
    setError('');
    try {
      await api('POST', '/tele/passcode/unlock', { passcode });
      setPasscode('');
      opened();
    } catch (err) {
      setPasscode('');
      if (err.status === 429) {
        // Too many wrong tries: the server says until when, or we ask it.
        let t = lockedUntilFrom(err.data);
        if (!t) t = await api('GET', '/tele/passcode').then((r) => Number(r.lockedUntil) || 0, () => 0);
        setNow(Date.now());
        setUntil(t);
        setError(t ? '' : err.message);
      } else {
        setError(err.message);
      }
      inputRef.current?.focus();
    }
    setBusy(false);
  };

  return (
    <div className={`tele-lock ${compact ? 'compact' : 'empty-pane'}`}>
      <span className="tele-lock-icon">
        <Lock size={compact ? 26 : 34} />
      </span>
      <h2>بخش تلگرام قفل است</h2>
      <p className="muted">برای دیدن پیام‌های تلگرام، رمز تلگرام را بنویسید.</p>
      <form className="form tele-lock-form" onSubmit={submit}>
        <input
          ref={inputRef}
          type="password"
          className="tele-pass-input"
          placeholder="رمز تلگرام"
          aria-label="رمز تلگرام"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          inputMode={numeric ? 'numeric' : 'text'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          dir="ltr"
          maxLength={256}
          disabled={wait > 0}
          autoFocus
        />
        {wait > 0 && (
          // The clock changes every second: hidden from screen readers, which get one fixed sentence.
          <div className="tele-block" role="status">
            <TriangleAlert size={17} aria-hidden="true" />
            <span aria-hidden="true">چند بار رمز اشتباه وارد شد. {faDigits(clockText(wait))} دیگر دوباره امتحان کنید.</span>
            <span className="sr-only">چند بار رمز اشتباه وارد شد. چند دقیقه صبر کنید و بعد دوباره امتحان کنید.</span>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn primary" disabled={busy || !passcode || wait > 0}>
          {busy ? 'در حال بررسی…' : 'باز کردن'}
        </button>
        <button
          type="button"
          className="link-btn muted tiny"
          onClick={() => {
            rememberPad(!numeric);
            setNumeric(!numeric);
            inputRef.current?.focus();
          }}
        >
          {numeric ? 'صفحه‌کلید حروف' : 'صفحه‌کلید عددی'}
        </button>
      </form>
      {compact ? (
        <p className="muted tiny">رمز را فراموش کرده‌اید؟ از صفحه‌ی تلگرام اقدام کنید.</p>
      ) : (
        <button type="button" className="link-btn tele-forgot" onClick={() => setForgot(true)}>
          رمز را فراموش کرده‌ام
        </button>
      )}
      {forgot && (
        <TeleForgot
          onClose={() => setForgot(false)}
          onDone={() => {
            setForgot(false);
            showToast('رمز تلگرام برداشته شد و حساب تلگرام قطع شد');
            opened();
          }}
        />
      )}
    </div>
  );
}

// The only way out without the passcode: disconnect the Telegram account (its stored history
// goes too). Needs the account password and an explicit "I understand".
function TeleForgot({ onClose, onDone }) {
  const [password, setPassword] = useState('');
  const [sure, setSure] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!sure || !password || busy) return;
    setBusy(true);
    setError('');
    try {
      // Logging out of Telegram goes through the server's VPN: give it time.
      await api('POST', '/tele/passcode/forgot', { password, confirm: true }, { timeout: 90000 });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="فراموشی رمز تلگرام" onClose={busy ? () => {} : onClose}>
      <form className="form" onSubmit={submit}>
        <div className="tele-block tele-forgot-warn">
          <TriangleAlert size={18} /> <span>{FORGOT_WARNING}</span>
        </div>
        <p className="hint">رمز تلگرام را نمی‌شود بازیابی کرد؛ مدیر سایت هم نمی‌تواند. اگر قطع حساب ناموفق باشد، رمز سر جایش می‌ماند.</p>
        <input type="password" placeholder="رمز عبور حساب (همین برنامه)" aria-label="رمز عبور حساب (همین برنامه)" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" autoComplete="current-password" autoFocus />
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> می‌پذیرم حساب تلگرام قطع و تاریخچه‌ی ذخیره‌شده پاک شود
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            انصراف
          </button>
          <button className="btn danger" disabled={busy || !sure || !password}>
            {busy ? 'در حال قطع حساب…' : 'قطع حساب و برداشتن رمز'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
