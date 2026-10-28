import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, formatDateTime } from '../util';
import { Cable, RefreshCw, Plus, Trash2, Activity, Power } from 'lucide-react';

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
        <Cable size={15} /> فقط ترافیک بخش Tele از این پروکسی‌ها عبور می‌کند. چت داخلی AmoreChat همیشه روی شبکه داخلی می‌ماند. اگر همه پروکسی‌ها قطع باشند، تلگرام صف می‌شود و هرگز مستقیم وصل نمی‌شود.
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
          rows={4}
          placeholder="هر خط یک لینک: socks5:// · http:// · ss:// · یا JSON outbound برای sing-box"
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
    </div>
  );
}
