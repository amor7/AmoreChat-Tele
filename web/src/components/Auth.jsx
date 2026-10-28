import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Server, Plus, Trash2 } from 'lucide-react';
import { multiServer, appServers, switchServer, addServer, removeServer } from '../native';

export default function Auth({ invite: initialInvite }) {
  const config = useStore((s) => s.config);
  const canRegister = config.needsSetup || config.registrationMode !== 'closed';
  const needsCode = config.needsSetup || config.registrationMode === 'invite';
  const [mode, setMode] = useState(config.needsSetup || initialInvite ? 'register' : 'login');
  const [form, setForm] = useState({ username: '', password: '', displayName: '', invite: initialInvite || '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Two-step login: the password was right, now the authenticator code (or a recovery code).
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = ticket
        ? await api('POST', '/auth/2fa', { ticket, code: code.trim() })
        : await api('POST', mode === 'login' ? '/auth/login' : '/auth/register', form);
      if (res.twoFactor) {
        setTicket(res.ticket);
        setBusy(false);
        return;
      }
      const { user } = res;
      if (location.hash.startsWith('#/invite/')) history.replaceState(null, '', '/');
      useStore.setState({ me: user, config: { ...config, needsSetup: false } });
    } catch (err) {
      setError(err.message);
      if (ticket && err.status === 401 && /زمان/.test(err.message)) setTicket(null);
    }
    setBusy(false);
  }

  if (ticket) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submit}>
          <img src="/icon.svg" alt="" width="64" height="64" />
          <h1>ورود دومرحله‌ای</h1>
          <p className="hint">کد ۶ رقمی برنامهٔ احراز هویت (مثل Google Authenticator) را وارد کنید. اگر گوشی در دسترس نیست، یکی از کدهای بازیابی را بزنید.</p>
          <label>
            کد
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              dir="ltr"
              autoFocus
              autoComplete="one-time-code"
              inputMode="text"
              maxLength={20}
              className="otp-input"
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="btn primary" disabled={busy || code.trim().length < 6}>
            {busy ? '…' : 'تأیید'}
          </button>
          <button type="button" className="btn" onClick={() => (setTicket(null), setCode(''), setError(''))}>
            بازگشت
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width="64" height="64" />
        <h1>{config.siteName}</h1>
        {config.needsSetup && (
          <p className="hint">
            راه‌اندازی اولیه: اولین حساب، مالک سرور می‌شود. کد راه‌اندازی در لاگ سرور چاپ شده است.
          </p>
        )}
        {!config.needsSetup && canRegister && (
          <div className="tabs">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              ورود
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              ثبت‌نام
            </button>
          </div>
        )}
        {mode === 'register' && (
          <label>
            نام نمایشی
            <input value={form.displayName} onChange={set('displayName')} required maxLength={64} autoComplete="name" />
          </label>
        )}
        <label>
          نام کاربری
          <input
            value={form.username}
            onChange={set('username')}
            required
            dir="ltr"
            autoComplete="username"
            autoCapitalize="none"
            placeholder={mode === 'register' ? 'english_name' : ''}
          />
        </label>
        <label>
          رمز عبور
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            required
            minLength={mode === 'register' ? 8 : undefined}
            dir="ltr"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </label>
        {mode === 'register' && needsCode && (
          <label>
            {config.needsSetup ? 'کد راه‌اندازی' : 'کد دعوت'}
            <input value={form.invite} onChange={set('invite')} required dir="ltr" autoCapitalize="none" />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'ورود' : 'ساخت حساب'}
        </button>
        {!canRegister && <p className="hint">ثبت‌نام بسته است. برای ساخت حساب با مدیر تماس بگیرید.</p>}
      </form>
      <AppServers />
    </div>
  );
}

// Android app with several servers: signed out here (or not signed in yet), the others are one
// tap away - instead of a sign-in page that looks like the only way forward.
function AppServers() {
  if (!multiServer) return null;
  const servers = appServers();
  const cur = servers.find((s) => s.current);
  const others = servers.filter((s) => !s.current);
  return (
    <div className="auth-card app-servers">
      {others.length > 0 && (
        <>
          <b>سرورهای دیگر شما</b>
          {others.map((s) => (
            <button key={s.url} type="button" className="btn wide" onClick={() => switchServer(s.url)}>
              <Server size={16} />
              <span className="grow" dir="ltr">
                {s.name}
              </span>
              {s.unread > 0 && <span className="badge">{s.unread}</span>}
              <small className={s.connected ? 'ok' : 'bad'}>{s.connected ? 'متصل' : 'قطع'}</small>
            </button>
          ))}
        </>
      )}
      <button type="button" className="btn wide" onClick={addServer}>
        <Plus size={16} /> افزودن سرور دیگر
      </button>
      {cur && (
        <button
          type="button"
          className="btn wide danger-text"
          onClick={() => confirm(`«${cur.name}» از اپ حذف شود؟`) && removeServer(cur.url)}
        >
          <Trash2 size={16} /> حذف این سرور از اپ
        </button>
      )}
    </div>
  );
}
