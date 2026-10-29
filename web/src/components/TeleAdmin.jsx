import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, formatDateTime } from '../util';
import TeleAddProxy from './TeleProxyForm';
import { Cable, RefreshCw, Trash2, Activity, Power, BellRing, BarChart3 } from 'lucide-react';

export default function TeleAdmin() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
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
          <label className="inline-form" title="برای پیدا کردن IP پروکسی‌هایی که با دامنه وارد شده‌اند">
            DNS پروکسی‌ها
            <input
              dir="ltr"
              list="tele-dns-presets"
              style={{ width: 170 }}
              placeholder="خالی = خودکار"
              defaultValue={(policy.dns || '').replace(/:53$/, '')}
              key={policy.dns || ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (policy.dns || '').replace(/:53$/, '')) savePolicy({ dns: v });
              }}
            />
            <datalist id="tele-dns-presets">
              <option value="178.22.122.100">شکن</option>
              <option value="185.51.200.2">شکن ۲</option>
              <option value="10.202.10.202">۴۰۳</option>
              <option value="78.157.42.100">الکترو</option>
              <option value="10.202.10.10">رادار</option>
            </datalist>
          </label>
        </div>
        <small className="muted">
          آدرس پروکسی‌هایی که با دامنه وارد شده‌اند خودکار هم‌زمان از DNS سرور و چند DNS داخلی (شکن، ۴۰۳، الکترو، رادار) پرسیده می‌شود و آخرین IP سالم برای زمان قطعی نگه داشته می‌شود؛ معمولاً لازم نیست چیزی بنویسید. اگر DNS دیگری دارید (مثلاً DNS دیتاسنتر) اینجا بگذارید تا آن هم پرسیده شود. فقط آدرس خود پروکسی پیدا می‌شود؛ ترافیک تلگرام از پروکسی می‌رود.
        </small>

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

      <TeleAddProxy onAdded={load} />

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

      <TeleAlerts />
      <TeleUsers />
    </div>
  );
}


const mbText = (bytes) => `${toFa((bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0))} MB`;

// Alerts for admins in their Saved Messages: on/off, kinds, recipients, timing.
const ALERT_LABELS = {
  down: 'تلگرام برای کاربران قطع شد (هیچ پروکسی سالمی نیست یا تونل خاموش است)',
  up: 'دوباره وصل شد',
  proxy: 'یک پروکسی از کار افتاد (حتی اگر بقیه کار کنند)',
  quota: 'کاربری به سقف مصرف ماهانه رسید',
};
function TeleAlerts() {
  const showToast = useStore((s) => s.showToast);
  const [a, setA] = useState(null);
  useEffect(() => {
    api('GET', '/admin/tele/alerts')
      .then((r) => setA(r.alerts))
      .catch((e) => showToast(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return null;
  const save = async (patch) => {
    try {
      setA((await api('PATCH', '/admin/tele/alerts', patch)).alerts);
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  };
  const test = async () => {
    try {
      const r = await api('POST', '/admin/tele/alerts/test', {});
      showToast(`پیام آزمایشی برای ${toFa(r.recipients)} نفر در «پیام‌های ذخیره‌شده» فرستاده شد`);
    } catch (e) {
      showToast(e.message);
    }
  };
  const num = (field, max) => ({
    type: 'number',
    min: 0,
    max,
    dir: 'ltr',
    style: { width: 72 },
    defaultValue: a[field],
    key: `${field}-${a[field]}`,
    onBlur: (e) => {
      const n = Math.max(0, Math.min(max, Math.round(Number(e.target.value)) || 0));
      if (n !== a[field]) save({ [field]: n });
    },
  });
  return (
    <div className="boxed tele-alerts" style={{ marginTop: 16 }}>
      <h4 className="with-icon">
        <BellRing size={16} /> هشدارها
      </h4>
      <label className="check">
        <input type="checkbox" checked={a.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        هشدار در «پیام‌های ذخیره‌شده» مدیران (با اعلان معمول برنامه)
      </label>
      {a.enabled && (
        <>
          {Object.entries(ALERT_LABELS).map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={a.events.includes(k)} onChange={(e) => save({ events: e.target.checked ? [...a.events, k] : a.events.filter((x) => x !== k) })} />
              {label}
            </label>
          ))}
          <div className="inline-form" style={{ marginTop: 8 }}>
            <label className="inline-form">
              گیرنده
              <select value={a.to} onChange={(e) => save({ to: e.target.value })}>
                <option value="admins">همه مدیرانی که تنظیمات را مدیریت می‌کنند</option>
                <option value="owner">فقط مالک</option>
              </select>
            </label>
          </div>
          <div className="inline-form">
            <label className="inline-form">
              هشدار قطعی بعد از
              <input {...num('delayMin', 1440)} />
              دقیقه
            </label>
            <label className="inline-form">
              یادآوری تا وصل شدن، هر
              <input {...num('repeatMin', 10080)} />
              دقیقه (۰ = یک بار)
            </label>
          </div>
          <small className="muted">کمی صبر قبل از هشدار از پیام‌های بی‌مورد هنگام عوض شدن پروکسی جلوگیری می‌کند.</small>
          <div>
            <button type="button" className="btn sm" onClick={test}>
              <BellRing size={14} /> ارسال پیام آزمایشی
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Users of Telegram: this month's traffic (highest first), cap, and photo / voice permission.
function TeleUsers() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [maxMb, setMaxMb] = useState('');
  const [quotaMb, setQuotaMb] = useState('');
  const load = () =>
    api('GET', '/admin/tele/accounts')
      .then((r) => {
        setData(r);
        setMaxMb(String(r.mediaMaxMb));
        setQuotaMb(String(r.defaultQuotaMb));
      })
      .catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;

  const patch = async (a, body) => {
    try {
      await api('PATCH', `/admin/tele/accounts/${a.id}`, body);
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
  const saveQuota = async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', '/admin/tele/quota', { defaultMb: Number(quotaMb) });
      showToast('ذخیره شد');
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };
  const top = data.accounts[0]?.used || 0;

  return (
    <div className="boxed" style={{ marginTop: 16 }}>
      <h4 className="with-icon">
        <BarChart3 size={16} /> کاربران تلگرام
      </h4>
      <p className="hint">مصرف اینترنت (VPN) هر کاربر در این ماه، از پرمصرف به کم‌مصرف. عکس و پیام صوتی پیش‌فرض برای همه خاموش است و فقط با زدن روی آن‌ها دانلود می‌شوند.</p>
      <form className="inline-form" onSubmit={saveQuota}>
        <label className="grow">
          سقف مصرف ماهانه هر کاربر (مگابایت، ۰ = بدون سقف)
          <input type="number" min={0} dir="ltr" value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} />
        </label>
        <button className="btn sm">ذخیره</button>
      </form>
      <form className="inline-form" onSubmit={saveMax}>
        <label className="grow">
          حداکثر حجم هر عکس یا پیام صوتی (مگابایت)
          <input type="number" min={1} max={50} dir="ltr" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
        </label>
        <button className="btn sm">ذخیره</button>
      </form>
      <ul className="user-list tele-users">
        {data.accounts.map((a) => {
          const cap = a.effectiveQuotaMb;
          const over = cap > 0 && a.used >= cap * 1048576;
          return (
            <li key={a.id} className="row-item tele-user">
              <span className="grow">
                <b>{a.name}</b> <small className="muted">@{a.username}</small>
                {over && <span className="tag danger">به سقف رسید</span>}
                <br />
                <small className="muted">
                  تلگرام: {a.tgName || '—'} · {a.status === 'connected' ? (a.live ? 'وصل' : 'وصل (در حالت صرفه‌جویی)') : 'وصل نیست'}
                </small>
                <span className="tele-usage">
                  <span className="tele-usage-bar">
                    <span style={{ width: `${cap > 0 ? Math.min(100, (a.used / (cap * 1048576)) * 100) : top ? (a.used / top) * 100 : 0}%` }} className={over ? 'over' : ''} />
                  </span>
                  <small dir="auto">
                    {mbText(a.used)}
                    {cap > 0 ? ` از ${toFa(cap)} MB` : ''}
                  </small>
                </span>
              </span>
              <span className="tele-user-ctl">
                <label className="inline-form" title="خالی = سقف پیش‌فرض؛ ۰ = بدون سقف">
                  <small>سقف (MB)</small>
                  <input
                    type="number"
                    min={0}
                    dir="ltr"
                    style={{ width: 76 }}
                    placeholder={data.defaultQuotaMb ? toFa(data.defaultQuotaMb) : '∞'}
                    defaultValue={a.quotaMb ?? ''}
                    key={`q-${a.id}-${a.quotaMb}`}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      const next = v === '' ? null : Number(v);
                      if (next !== (a.quotaMb ?? null)) patch(a, { quotaMb: next });
                    }}
                  />
                </label>
                <label className="check">
                  <input type="checkbox" checked={a.allowMedia} onChange={() => patch(a, { allowMedia: !a.allowMedia })} /> عکس
                </label>
                <label className="check">
                  <input type="checkbox" checked={a.allowVoice} onChange={() => patch(a, { allowVoice: !a.allowVoice })} /> صوت
                </label>
              </span>
            </li>
          );
        })}
        {!data.accounts.length && <li className="muted">هنوز کسی حساب تلگرام وصل نکرده است.</li>}
      </ul>
    </div>
  );
}
