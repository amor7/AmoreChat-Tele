import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modals';
import { formatDateTime } from '../util';
import { Cable, RefreshCw, Send, LogOut, MessageCircle } from 'lucide-react';

export default function TelePanel({ onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [status, setStatus] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeDialog, setActiveDialog] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');

  const load = () => api('GET', '/tele/status').then(setStatus).catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line

  const account = status?.account;
  const dialogs = status?.dialogs || [];
  const runtime = status?.runtime || {};
  const phase = account?.status || 'disconnected';

  const run = async (fn) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r?.notice) setNotice(r.notice);
      else setNotice('');
      await load();
      return r;
    } catch (e) {
      // Keep the reason on screen and show the step the server is really on (e.g. back to the phone step).
      setNotice(e.message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const cancelLogin = () =>
    run(async () => {
      setCode('');
      setPassword('');
      setNotice('');
      return api('POST', '/tele/disconnect');
    });

  const openDialog = async (d) => {
    setActiveDialog(d);
    try {
      const r = await api('GET', `/tele/dialogs/${d.id}/messages`);
      setMessages(r.messages || []);
      if (r.notice) setNotice(r.notice);
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <Modal title="Tele — تلگرام" onClose={onClose} size="large">
      <p className="hint with-icon">
        <Cable size={15} /> حساب شخصی شما؛ ترافیک فقط از پروکسی ادمین.
      </p>
      {notice && <div className="error">{notice}</div>}
      <small className="muted">
        API: {runtime.apiConfigured ? 'OK' : 'خیر'} · TDLib: {runtime.tdlAvailable ? 'OK' : 'خیر'} · تونل:{' '}
        {runtime.egress?.running ? 'روشن' : 'خاموش'}
        {!runtime.egress?.running && runtime.egress?.lastError ? ` (${runtime.egress.lastError})` : ''}
      </small>

      {(!account || phase === 'disconnected') && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api('POST', '/tele/login/phone', { phone }));
          }}
        >
          <label>
            شماره (+98…)
            <input dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+98912…" />
          </label>
          <button className="btn primary" disabled={busy}>
            دریافت کد
          </button>
        </form>
      )}

      {phase === 'awaiting_code' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api('POST', '/tele/login/code', { code }));
          }}
        >
          <p className="hint">کد را از اپ تلگرام یا پیامک بگیرید. اگر کدی نیامد، انصراف بزنید و دوباره شماره را ارسال کنید.</p>
          <label>
            کد
            <input dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy}>
              تأیید
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancelLogin}>
              انصراف / شماره جدید
            </button>
          </div>
        </form>
      )}

      {phase === 'awaiting_password' && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => api('POST', '/tele/login/password', { password }));
          }}
        >
          <label>
            رمز دو مرحله‌ای
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy}>
              ورود
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancelLogin}>
              انصراف
            </button>
          </div>
        </form>
      )}

      {account && phase === 'connected' && (
        <>
          <div className="inline-form boxed">
            <span className="grow">
              <b>{account.displayName || account.phone}</b>
            </span>
            <button type="button" className="btn sm" onClick={() => run(() => api('POST', '/tele/dialogs/refresh'))}>
              <RefreshCw size={14} /> همگام‌سازی
            </button>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => confirm('قطع اتصال تلگرام؟') && run(() => api('POST', '/tele/disconnect'))}
            >
              <LogOut size={14} />
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 12, marginTop: 12 }}>
            <ul className="user-list">
              {dialogs.map((d) => (
                <li key={d.id} className="row-item">
                  <button type="button" className="btn sm" onClick={() => openDialog(d)}>
                    <MessageCircle size={14} /> {d.title || d.tgChatId}
                  </button>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!!d.selected}
                      onChange={() => run(() => api('PATCH', `/tele/dialogs/${d.id}`, { selected: !d.selected }))}
                    />{' '}
                    نمایش
                  </label>
                </li>
              ))}
            </ul>
            <div>
              <div style={{ maxHeight: 280, overflow: 'auto' }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ textAlign: m.direction === 'out' ? 'left' : 'right', margin: '6px 0' }}>
                    <div dir="auto">{m.text}</div>
                    <small className="muted">{formatDateTime(m.createdAt)}</small>
                  </div>
                ))}
              </div>
              {activeDialog?.selected && (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!draft.trim()) return;
                    try {
                      const r = await api('POST', `/tele/dialogs/${activeDialog.id}/messages`, { text: draft });
                      setDraft('');
                      setMessages((x) => [...x, r.message]);
                    } catch (err) {
                      showToast(err.message);
                    }
                  }}
                >
                  <input className="grow" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="پیام…" />
                  <button className="btn primary sm">
                    <Send size={14} />
                  </button>
                </form>
              )}
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
