import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, formatDateTime } from '../util';
import { Cable, RefreshCw, Plus, Trash2, Activity, Power, Image as ImageIcon } from 'lucide-react';

export default function TeleAdmin() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [links, setLinks] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api('GET', '/admin/tele/proxies')
      .then(setData)
      .catch((e) => showToast(e.message));

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p className="muted">…</p>;

  const policy = data.policy || {};
  const proxies = data.proxies || [];
  const egress = data.egress || {};

  const savePolicy = async (patch) => {
    try {
      const r = await api('PATCH', '/admin/tele/policy', patch);
      setData((d) => ({ ...d, policy: r.policy, egress: r.egress || d.egress }));
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  };

  const addLinks = async (e) => {
    e.preventDefault();
    if (!links.trim()) return;
    setBusy(true);
    try {
      await api('POST', '/admin/tele/proxies', { links, name: name || undefined });
      setLinks('');
      setName('');
      await load();
      showToast('پروکسی اضافه شد');
    } catch (err) {
      showToast(err.message);
    }
    setBusy(false);
  };

  const probe = async (id) => {
    try {
      await api('POST', `/admin/tele/proxies/${id}/probe`);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };

  const remove = async (id) => {
    if (!confirm('حذف شود؟')) return;
    try {
      await api('DELETE', `/admin/tele/proxies/${id}`);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };

  const statusColor = (s) => (s === 'healthy' ? 'ok' : s === 'unhealthy' ? 'danger' : 'muted');

  return (
    <div className="tele-admin">
      <p className="hint with-icon">
        <Cable size={15} /> فقط ترافیک بخش Tele از این پروکسی‌ها عبور می‌کند. چت داخلی همیشه روی شبکه داخلی می‌ماند. اگر همه پروکسی‌ها قطع باشند، تلگرام صف می‌شود و هرگز مستقیم وصل نمی‌شود.
      </p>

      <div className="perm-box">
        <b>سیاست مسیریابی</b>
        <label className="check">
          <input type="checkbox" checked={!!policy.enabled} onChange={(e) => savePolicy({ enabled: e.target.checked })} />
          فعال‌سازی Tele egress
        </label>
        <div className="inline-form" style={{ marginTop: 8 }}>
          <select value={policy.mode || 'priority'} onChange={(e) => savePolicy({ mode: e.target.value })}>
            <option value="priority">اولویت (failover)</option>
            <option value="best">بهترین تأخیر</option>
            <option value="random">تصادفی بین سالم‌ها</option>
            <option value="manual">دستی</option>
          </select>
          {policy.mode === 'manual' && (
            <select
              value={policy.activeProxyId || ''}
              onChange={(e) => savePolicy({ activeProxyId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">— انتخاب —</option>
              {proxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.protocol})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={async () => {
              try {
                await api('POST', '/admin/tele/egress/restart');
                await load();
                showToast('تونل ری‌استارت شد');
              } catch (e) {
                showToast(e.message);
              }
            }}
          >
            <Power size={14} /> ری‌استارت تونل
          </button>
        </div>
        <small className="muted">
          تونل: {egress.running ? 'در حال اجرا' : 'خاموش'}
          {egress.localSocks ? ` · ${egress.localSocks}` : ''}
          {egress.lastError ? ` · خطا: ${egress.lastError}` : ''}
        </small>
      </div>

      <form className="inline-form boxed" onSubmit={addLinks}>
        <input placeholder="نام (اختیاری)" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          rows={5}
          placeholder={
            'هر خط یک کانفیگ:\n' +
            'socks5:// · http:// · ss:// · vless:// · vmess:// · trojan://\n' +
            'WireGuard: بلوک [Interface]/[Peer] یا JSON outbound\n' +
            'یا JSON کامل sing-box برای Reality'
          }
          value={links}
          onChange={(e) => setLinks(e.target.value)}
          dir="ltr"
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
        />
        <button className="btn primary sm" disabled={busy}>
          <Plus size={14} /> افزودن
        </button>
      </form>

      <ul className="user-list">
        {proxies.map((p) => (
          <li key={p.id} className="row-item">
            <span className="grow">
              <b>
                {p.name} <span className="tag">{p.protocol}</span>{' '}
                <span className={`tag ${statusColor(p.lastStatus)}`}>{p.lastStatus}</span>
                {!p.enabled && <span className="tag danger">خاموش</span>}
              </b>
              <small>
                اولویت {toFa(p.priority)}
                {p.lastLatencyMs != null ? ` · ${toFa(p.lastLatencyMs)} ms` : ''}
                {p.lastCheckedAt ? ` · ${formatDateTime(p.lastCheckedAt)}` : ''}
                {p.lastError ? ` · ${p.lastError}` : ''}
              </small>
            </span>
            <button className="btn sm" title="تست" onClick={() => probe(p.id)}>
              <Activity size={14} />
            </button>
            <button
              className="btn sm"
              onClick={() => api('PATCH', `/admin/tele/proxies/${p.id}`, { enabled: !p.enabled }).then(load)}
            >
              {p.enabled ? 'خاموش' : 'روشن'}
            </button>
            <button className="btn sm danger" onClick={() => remove(p.id)}>
              <Trash2 size={14} />
            </button>
          </li>
        ))}
        {!proxies.length && <li className="muted">هنوز پروکسی‌ای اضافه نشده</li>}
      </ul>

      <button type="button" className="btn sm" onClick={load}>
        <RefreshCw size={14} /> به‌روزرسانی
      </button>

      <TeleMediaAccess />
    </div>
  );
}

// Photos cost VPN traffic: off for everyone by default, on for the accounts chosen here.
function TeleMediaAccess() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [maxMb, setMaxMb] = useState('');
  const load = () =>
    api('GET', '/admin/tele/accounts')
      .then((r) => {
        setData(r);
        setMaxMb(String(r.mediaMaxMb));
      })
      .catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;

  const toggle = async (a) => {
    try {
      await api('PATCH', `/admin/tele/accounts/${a.id}`, { allowMedia: !a.allowMedia });
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const saveMax = async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', '/admin/tele/media', { maxMb: Number(maxMb) });
      showToast('ذخیره شد');
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };

  return (
    <div className="boxed" style={{ marginTop: 16 }}>
      <h4 className="with-icon">
        <ImageIcon size={16} /> عکس در تلگرام
      </h4>
      <p className="hint">پیش‌فرض همه فقط متن می‌بینند. برای هر کاربر جدا اجازه بدهید عکس ببیند و بفرستد؛ عکس فقط با زدن روی آن دانلود می‌شود.</p>
      <form className="inline-form" onSubmit={saveMax}>
        <label className="grow">
          حداکثر حجم هر عکس (مگابایت)
          <input type="number" min={1} max={50} dir="ltr" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
        </label>
        <button className="btn sm">ذخیره</button>
      </form>
      <ul className="user-list">
        {data.accounts.map((a) => (
          <li key={a.id} className="row-item">
            <span className="grow">
              <b>{a.name}</b> <small className="muted">@{a.username}</small>
              <br />
              <small className="muted">
                تلگرام: {a.tgName || '—'} · {a.status === 'connected' ? 'وصل' : 'وصل نیست'}
              </small>
            </span>
            <label className="check">
              <input type="checkbox" checked={a.allowMedia} onChange={() => toggle(a)} /> اجازه عکس
            </label>
          </li>
        ))}
        {!data.accounts.length && <li className="muted">هنوز کسی حساب تلگرام وصل نکرده است.</li>}
      </ul>
    </div>
  );
}
