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
  const [probing, setProbing] = useState(null); // proxy id, or 'all'

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
      const r = await api('POST', '/admin/tele/proxies', { links, name: name || undefined });
      setLinks('');
      setName('');
      await load();
      const n = r.proxies?.length || 0;
      showToast(r.errors?.length ? `${toFa(n)} پروکسی اضافه شد؛ ${toFa(r.errors.length)} مورد خطا داشت: ${r.errors.join(' · ')}` : `${toFa(n)} پروکسی اضافه شد؛ حالا تستش کنید`);
    } catch (err) {
      showToast(err.message);
    }
    setBusy(false);
  };

  const probe = async (id) => {
    setProbing(id);
    try {
      const r = await api('POST', id === 'all' ? '/admin/tele/proxies/probe-all' : `/admin/tele/proxies/${id}/probe`, {}, { timeout: 180000 });
      await load();
      if (id !== 'all') showToast(r.proxy?.lastStatus === 'healthy' ? `سالم · ${toFa(r.proxy.lastLatencyMs)} ms` : `ناموفق: ${r.proxy?.lastError || ''}`);
    } catch (e) {
      showToast(e.message);
    }
    setProbing(null);
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
  const patchProxy = async (id, patch) => {
    try {
      await api('PATCH', `/admin/tele/proxies/${id}`, patch);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };

  const STATUS = { healthy: ['سالم', 'ok'], unhealthy: ['خراب', 'danger'], unknown: ['تست نشده', 'muted'] };
  const minutes = Math.round((policy.healthIntervalSec || 600) / 60);
  const active = proxies.find((p) => p.id === egress.proxyId);
  const health = egress.health || {};

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
            <option value="priority">اولویت (اولین سالم)</option>
            <option value="best">بهترین تأخیر</option>
            <option value="random">تصادفی بین سالم‌ها</option>
            <option value="manual">دستی</option>
          </select>
          {policy.mode === 'manual' && (
            <select value={policy.activeProxyId || ''} onChange={(e) => savePolicy({ activeProxyId: e.target.value ? Number(e.target.value) : null })}>
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
                await load();
              }
            }}
          >
            <Power size={14} /> ری‌استارت تونل
          </button>
        </div>
        <small className="muted">
          تونل: {egress.running ? `در حال اجرا${active ? ` با «${active.name}»` : ''}` : 'خاموش'}
          {egress.singBoxVersion ? ` · sing-box ${egress.singBoxVersion}` : ''}
          {egress.lastError ? ` · خطا: ${egress.lastError}` : ''}
        </small>
        {egress.running && egress.tunnelError && <small className="tele-warn">آخرین خطای تونل: {egress.tunnelError}</small>}

        <div className="tele-health">
          <label className="check">
            <input type="checkbox" checked={!!policy.autoHealth} onChange={(e) => savePolicy({ autoHealth: e.target.checked })} />
            تست خودکار همه پروکسی‌ها
          </label>
          <label className="inline-form">
            هر
            <input
              type="number"
              min={1}
              max={1440}
              dir="ltr"
              style={{ width: 72 }}
              defaultValue={minutes}
              key={minutes}
              onBlur={(e) => {
                const m = Math.max(1, Math.min(1440, Math.round(Number(e.target.value)) || 10));
                if (m !== minutes) savePolicy({ healthIntervalSec: m * 60 });
              }}
            />
            دقیقه
          </label>
          <button type="button" className="btn sm" disabled={probing === 'all'} onClick={() => probe('all')}>
            <Activity size={14} /> {probing === 'all' ? 'در حال تست…' : 'تست همه الان'}
          </button>
        </div>
        <small className="muted">
          هر پروکسی واقعاً تا سرور تلگرام تست می‌شود؛ بعد طبق سیاست بالا بهترین سالم انتخاب می‌شود و اگر پروکسی فعلی خراب شده باشد، تونل خودش عوض می‌شود.
          {health.lastRunAt ? ` آخرین تست: ${formatDateTime(health.lastRunAt)}.` : ''}
          {policy.autoHealth && health.nextRunAt ? ` تست بعدی: ${formatDateTime(health.nextRunAt)}.` : ''}
        </small>
      </div>

      <form className="inline-form boxed" onSubmit={addLinks}>
        <input placeholder="نام (اختیاری؛ وگرنه از خود کانفیگ)" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          rows={7}
          placeholder={
            'لینک‌ها هر کدام در یک خط:\n' +
            'socks5:// · http:// · ss:// · vless:// · vmess:// · trojan:// · hy2:// · tuic://\n' +
            'یا لینک اشتراک (subscription) base64\n\n' +
            'WireGuard: کل فایل .conf را همان‌طور بچسبانید ([Interface] … [Peer] …)؛ چند فایل هم با هم می‌شود\n' +
            'یا JSON خروجی/کامل sing-box'
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
        {proxies.map((p) => {
          const [label, color] = STATUS[p.lastStatus] || STATUS.unknown;
          return (
            <li key={p.id} className="row-item">
              <span className="grow">
                <b>
                  {p.name} <span className="tag">{p.protocol}</span> <span className={`tag ${color}`}>{label}</span>
                  {p.id === egress.proxyId && egress.running && <span className="tag ok">در حال استفاده</span>}
                  {!p.enabled && <span className="tag danger">خاموش</span>}
                </b>
                <small>
                  {p.lastLatencyMs != null ? `${toFa(p.lastLatencyMs)} ms` : ''}
                  {p.lastCheckedAt ? ` · ${formatDateTime(p.lastCheckedAt)}` : ''}
                  {p.lastError ? ` · ${p.lastError}` : ''}
                </small>
              </span>
              <label className="inline-form" title="عدد کمتر = اولویت بالاتر">
                <small>اولویت</small>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  dir="ltr"
                  style={{ width: 64 }}
                  defaultValue={p.priority}
                  key={p.priority}
                  onBlur={(e) => Number(e.target.value) !== p.priority && patchProxy(p.id, { priority: Number(e.target.value) })}
                />
              </label>
              <button className="btn sm" title="تست واقعی تا تلگرام" disabled={probing != null} onClick={() => probe(p.id)}>
                <Activity size={14} /> {probing === p.id ? '…' : ''}
              </button>
              <button className="btn sm" onClick={() => patchProxy(p.id, { enabled: !p.enabled })}>
                {p.enabled ? 'خاموش' : 'روشن'}
              </button>
              <button className="btn sm danger" onClick={() => remove(p.id)}>
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
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
