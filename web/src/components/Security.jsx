import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Smartphone, Monitor, LogOut, ShieldCheck, ShieldOff, Copy, KeyRound } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { formatDay, formatTime, toFa, copyText } from '../util';

const when = (t) => (Date.now() - t < 2 * 60 * 1000 ? 'همین حالا' : `${formatDay(t)} ${formatTime(t)}`);

function Devices() {
  const showToast = useStore((s) => s.showToast);
  const [list, setList] = useState(null);
  const load = () =>
    api('GET', '/me/sessions')
      .then((r) => setList(r.sessions))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function revoke(id) {
    try {
      await api('DELETE', `/me/sessions/${id}`);
      load();
    } catch (e) {
      showToast(e.message);
    }
  }
  async function revokeOthers() {
    if (!confirm('از همهٔ دستگاه‌های دیگر خارج شوید؟')) return;
    const { loggedOut } = await api('POST', '/me/sessions/revoke-others');
    showToast(`${toFa(loggedOut)} دستگاه خارج شد`);
    load();
  }

  if (!list) return null;
  return (
    <>
      <ul className="device-list">
        {list.map((s) => (
          <li key={s.id}>
            {/Android|iOS|iPhone/.test(s.device) ? <Smartphone size={20} /> : <Monitor size={20} />}
            <div>
              <b>{s.device}</b>
              {s.current && <span className="badge-current">همین دستگاه</span>}
              <div className="muted tiny" dir="auto">
                {s.ip && <span dir="ltr">{s.ip}</span>} · آخرین فعالیت: {when(s.lastSeen)}
              </div>
            </div>
            {!s.current && (
              <button className="icon-btn" title="خروج این دستگاه" onClick={() => revoke(s.id)}>
                <LogOut size={18} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.length > 1 && (
        <button className="btn danger" onClick={revokeOthers}>
          <LogOut size={17} /> خروج از همهٔ دستگاه‌های دیگر
        </button>
      )}
    </>
  );
}

function RecoveryCodes({ codes, onDone }) {
  const text = codes.join('\n');
  return (
    <div className="twofa-box">
      <p>
        <b>کدهای بازیابی را جایی امن نگه دارید.</b> اگر گوشی‌تان گم شود، با هر کدام فقط یک بار می‌توانید وارد شوید. این کدها دیگر نمایش داده نمی‌شوند.
      </p>
      <pre className="recovery-codes" dir="ltr">
        {text}
      </pre>
      <div className="row-gap">
        <button className="btn" onClick={() => copyText(text)}>
          <Copy size={16} /> کپی
        </button>
        <button className="btn primary" onClick={onDone}>
          ذخیره کردم
        </button>
      </div>
    </div>
  );
}

function TwoFactor() {
  const me = useStore((s) => s.me);
  const showToast = useStore((s) => s.showToast);
  const [step, setStep] = useState('idle'); // idle | password | scan | codes | disable
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [left, setLeft] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me.twoFactor) api('GET', '/me/2fa').then((r) => setLeft(r.recoveryCodesLeft), () => {});
  }, [me.twoFactor]);

  const reset = () => (setStep('idle'), setPassword(''), setCode(''), setSetup(null));
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  };

  const start = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('POST', '/me/2fa/setup', { password });
      const qr = qrcode(0, 'M');
      qr.addData(r.uri);
      qr.make();
      setSetup({ ...r, qr: qr.createDataURL(5, 2) });
      setPassword('');
      setStep('scan');
    });
  };
  const enable = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('POST', '/me/2fa/enable', { code: code.trim() });
      useStore.setState({ me: r.user });
      setCodes(r.recoveryCodes);
      setCode('');
      setStep('codes');
    });
  };
  const disable = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('POST', '/me/2fa/disable', { password, code: code.trim() });
      useStore.setState({ me: r.user });
      showToast('ورود دومرحله‌ای خاموش شد');
      reset();
    });
  };

  if (step === 'codes') return <RecoveryCodes codes={codes} onDone={() => (setCodes(null), reset())} />;

  if (step === 'scan')
    return (
      <form className="twofa-box" onSubmit={enable}>
        <p>۱. برنامهٔ احراز هویت (Google Authenticator، Microsoft Authenticator، Aegis، …) را باز کنید و این کد QR را اسکن کنید:</p>
        <img className="qr" src={setup.qr} alt="QR" />
        <details>
          <summary>اسکن نمی‌شود؟ کلید را دستی وارد کنید</summary>
          <code className="secret" dir="ltr">
            {setup.secret.match(/.{1,4}/g).join(' ')}
          </code>
        </details>
        <p>۲. کد ۶ رقمی که برنامه نشان می‌دهد را بنویسید:</p>
        <input className="otp-input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} dir="ltr" required autoFocus />
        <div className="row-gap">
          <button type="button" className="btn" onClick={reset}>
            انصراف
          </button>
          <button className="btn primary" disabled={busy || code.trim().length !== 6}>
            فعال‌سازی
          </button>
        </div>
      </form>
    );

  if (step === 'password' || step === 'disable')
    return (
      <form className="twofa-box" onSubmit={step === 'password' ? start : disable}>
        <input type="password" placeholder="رمز عبور فعلی" value={password} onChange={(e) => setPassword(e.target.value)} required dir="ltr" autoComplete="current-password" autoFocus />
        {step === 'disable' && (
          <input className="otp-input" placeholder="کد ۶ رقمی برنامه" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} dir="ltr" required />
        )}
        <div className="row-gap">
          <button type="button" className="btn" onClick={reset}>
            انصراف
          </button>
          <button className={`btn ${step === 'disable' ? 'danger' : 'primary'}`} disabled={busy}>
            {step === 'disable' ? 'خاموش کردن' : 'ادامه'}
          </button>
        </div>
      </form>
    );

  return me.twoFactor ? (
    <div className="twofa-status on">
      <ShieldCheck size={22} />
      <div>
        <b>ورود دومرحله‌ای فعال است</b>
        {left != null && <div className="muted tiny">{toFa(left)} کد بازیابی باقی مانده</div>}
      </div>
      <button className="btn sm" onClick={() => setStep('disable')}>
        <ShieldOff size={16} /> خاموش
      </button>
    </div>
  ) : (
    <div className="twofa-status">
      <KeyRound size={22} />
      <div>
        <b>ورود دومرحله‌ای خاموش است</b>
        <div className="muted tiny">با روشن کردن آن، اگر رمزتان لو برود هم کسی بدون گوشی شما نمی‌تواند وارد شود.</div>
      </div>
      <button className="btn sm primary" onClick={() => setStep('password')}>
        روشن کردن
      </button>
    </div>
  );
}

export default function Security() {
  // Enabling two-step login signs out the other devices: reload the list when it changes.
  const twoFactor = useStore((s) => s.me.twoFactor);
  return (
    <>
      <h4>امنیت</h4>
      <TwoFactor />
      <h5>دستگاه‌های وارد شده</h5>
      <Devices key={String(twoFactor)} />
    </>
  );
}
