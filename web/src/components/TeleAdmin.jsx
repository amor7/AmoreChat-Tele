import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, faDigits, formatDateTime } from '../util';
import TeleAddProxy from './TeleProxyForm';
import { Cable, RefreshCw, Trash2, Activity, Power, BellRing, BarChart3, Newspaper, Copy, UserCheck, FileDown, LineChart } from 'lucide-react';

export default function VpnAdmin() {
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
    </div>
  );
}

// The Telegram tab: who may use it, each user's traffic and permissions, and channel mirrors.
// The VPN tab (the default export) is only about the tunnel the Telegram part goes through.
export function TeleSection() {
  return (
    <div className="tele-admin">
      <TeleAccess />
      <TeleUsers />
      <TeleMirrors />
      <TeleAccess
        path="/admin/access/mirror-files"
        icon={FileDown}
        title="دریافت ویدیو و فایل کانال‌های منتشرشده"
        hint="ویدیو و فایل پست‌های کانال‌های منتشرشده با زدن روی آن‌ها از تلگرام گرفته می‌شود (مصرف VPN). فقط این کاربران می‌توانند اولین بار آن را بگیرند؛ بعد از آن برای همه اعضای کانال باز است. مالک همیشه می‌تواند."
        labels={FILES_LABELS}
      />
    </div>
  );
}


const mbText = (bytes) => `${toFa((bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0))} MB`;

// Alerts for admins in their Saved Messages: on/off, kinds, recipients, timing.
const ALERT_LABELS = {
  down: 'تلگرام برای کاربران قطع شد (هیچ پروکسی سالمی نیست یا تونل خاموش است)',
  up: 'دوباره وصل شد',
  proxy: 'یک پروکسی از کار افتاد (حتی اگر بقیه کار کنند)',
  quota80: 'کاربری ۸۰٪ سقف مصرف ماهانه را مصرف کرد',
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
  const [fileMb, setFileMb] = useState('');
  const [quotaMb, setQuotaMb] = useState('');
  const [chartFor, setChartFor] = useState(null);
  const load = () =>
    api('GET', '/admin/tele/accounts')
      .then((r) => {
        setData(r);
        setMaxMb(String(r.mediaMaxMb));
        setFileMb(String(r.fileMaxMb));
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
      await api('PATCH', '/admin/tele/media', { maxMb: Number(maxMb), fileMaxMb: Number(fileMb) });
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
      <p className="hint">مصرف اینترنت (VPN) هر کاربر در این ماه، از پرمصرف به کم‌مصرف. عکس، پیام صوتی و فایل/ویدیو پیش‌فرض برای همه خاموش است و فقط با زدن روی آن‌ها دانلود می‌شوند. «پیام/عضویت جدید» یعنی پیام دادن به هر کسی با ‎@نام‌کاربری یا شماره، و جستجو و عضویت در گروه‌ها و کانال‌ها؛ این هم پیش‌فرض خاموش است.</p>
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
        <label className="grow">
          حداکثر حجم هر فایل یا ویدیو (مگابایت)
          <input type="number" min={1} max={2000} dir="ltr" value={fileMb} onChange={(e) => setFileMb(e.target.value)} />
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
                  <button type="button" className="icon-btn sm" title="مصرف روزانه و ماهانه" aria-label="مصرف روزانه و ماهانه" onClick={() => setChartFor(chartFor === a.id ? null : a.id)}>
                    <LineChart size={15} />
                  </button>
                </span>
                {chartFor === a.id && <UsageChart accountId={a.id} />}
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
                <label className="check">
                  <input type="checkbox" checked={a.allowFiles} onChange={() => patch(a, { allowFiles: !a.allowFiles })} /> فایل
                </label>
                <label className="check" title={a.owner ? 'مالک همیشه این اجازه را دارد' : 'پیام به هر کس با ‎@نام‌کاربری یا شماره، جستجو و عضویت در گروه‌ها و کانال‌ها'}>
                  <input type="checkbox" checked={a.allowExplore} disabled={a.owner} onChange={() => patch(a, { allowExplore: !a.allowExplore })} /> پیام/عضویت جدید
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


// Traffic of one user: the last 30 days and 6 months, as bars.
function UsageChart({ accountId }) {
  const [u, setU] = useState(null);
  useEffect(() => {
    api('GET', `/admin/tele/accounts/${accountId}/usage`)
      .then(setU)
      .catch((e) => useStore.getState().showToast(e.message));
  }, [accountId]);
  if (!u) return <small className="muted">…</small>;
  const bars = (rows, label) => {
    const max = Math.max(1, ...rows.map((r) => r.bytes));
    return (
      <div className="usage-bars" role="img" aria-label={label}>
        {rows.map((r) => (
          <span key={r.day || r.month} title={`${r.day || r.month}: ${mbText(r.bytes)}`} style={{ height: `${Math.max(2, (r.bytes / max) * 100)}%` }} className={r.bytes ? '' : 'zero'} />
        ))}
      </div>
    );
  };
  const today = u.days.at(-1)?.bytes || 0;
  const avg = u.days.reduce((n, r) => n + r.bytes, 0) / u.days.length;
  return (
    <div className="usage-chart">
      <small className="muted">
        ۳۰ روز اخیر · امروز {mbText(today)} · میانگین روزانه {mbText(avg)}
        {u.quotaMb > 0 && avg > 0 ? ` · با این روند سقف ماه حدود ${toFa(Math.max(0, Math.floor((u.quotaMb * 1048576 - u.used) / avg)))} روز دیگر پر می‌شود` : ''}
      </small>
      {bars(u.days, 'مصرف روزانه')}
      <small className="muted">۶ ماه اخیر</small>
      {bars(u.months, 'مصرف ماهانه')}
      <small className="muted usage-months">{u.months.map((m) => `${faDigits(m.month)}: ${mbText(m.bytes)}`).join(' · ')}</small>
    </div>
  );
}

// Who may use a feature: everyone, nobody, only chosen users, or everyone but chosen users.
const ACCESS_LABELS = {
  all: 'برای همه باز',
  none: 'برای همه بسته (جز مالک)',
  allow: 'فقط برای کاربرانی که انتخاب می‌کنید',
  deny: 'برای همه، جز کاربرانی که انتخاب می‌کنید',
};
const FILES_LABELS = {
  all: 'همه کاربران',
  none: 'هیچ‌کس (جز مالک)',
  allow: 'فقط کاربرانی که انتخاب می‌کنید',
  deny: 'همه، جز کاربرانی که انتخاب می‌کنید',
};
function TeleAccess({
  path = '/admin/access/tele',
  icon: Icon = UserCheck,
  title = 'دسترسی به تلگرام',
  hint = 'چه کسانی بخش تلگرام را داشته باشند. بستن برای کسی که وارد شده، اتصالش را همان لحظه می‌بندد؛ حسابش می‌ماند و با باز شدن دوباره، بدون ورود دوباره کار می‌کند. مالک همیشه دسترسی دارد.',
  labels = ACCESS_LABELS,
}) {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('GET', path)
      .then(setData)
      .catch((e) => showToast(e.message));
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const save = async (body) => {
    setBusy(true);
    try {
      setData(await api('PATCH', path, body));
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  };
  const listMode = data.mode === 'allow' || data.mode === 'deny';
  const term = q.trim().toLowerCase();
  const shown = data.users.filter((u) => !u.owner && (!term || `${u.name} ${u.username}`.toLowerCase().includes(term)));
  const listed = data.users.filter((u) => u.listed).length;
  return (
    <div className="boxed" style={{ marginTop: 16 }}>
      <h4 className="with-icon">
        <Icon size={16} /> {title}
      </h4>
      <p className="hint">{hint}</p>
      <label>
        حالت
        <select value={data.mode} disabled={busy} onChange={(e) => save({ mode: e.target.value })}>
          {data.modes.map((m) => (
            <option key={m} value={m}>
              {labels[m] || m}
            </option>
          ))}
        </select>
      </label>
      {listMode && (
        <>
          <p className="hint">
            {data.mode === 'allow' ? 'تیک‌خورده‌ها اجازه دارند؛ بقیه نه.' : 'تیک‌خورده‌ها اجازه ندارند؛ بقیه دارند.'} ({toFa(listed)} نفر انتخاب شده)
          </p>
          <input className="search" placeholder="جستجوی کاربر…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="user-list tele-access-list">
            {shown.slice(0, 300).map((u) => (
              <li key={u.id} className="row-item">
                <label className="check grow">
                  <input type="checkbox" checked={u.listed} disabled={busy} onChange={() => save(u.listed ? { remove: [u.id] } : { add: [u.id] })} />
                  <span>
                    <b>{u.name}</b> <small className="muted">@{u.username}</small>
                  </span>
                </label>
                {u.teleStatus === 'connected' && <small className="muted">حساب تلگرام وصل</small>}
                <span className={`tag ${u.allowed ? '' : 'danger'}`}>{u.allowed ? 'اجازه دارد' : 'بسته'}</span>
              </li>
            ))}
            {!shown.length && <li className="muted">کاربری پیدا نشد.</li>}
          </ul>
        </>
      )}
    </div>
  );
}

// Owner: Telegram channels whose posts appear in channels of this app (read once, for everyone).
const VIS_LABELS = {
  public: 'عمومی (در «کاوش» دیده می‌شود)',
  all: 'همه کاربران خودکار عضو شوند',
  link: 'خصوصی (فقط با لینک دعوت)',
};
const inviteLink = (code) => `${location.origin}/#/join/${code}`;
function TeleMirrors() {
  const me = useStore((st) => st.me);
  const showToast = useStore((st) => st.showToast);
  const [data, setData] = useState(null);
  const [channels, setChannels] = useState(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [tgChatId, setTgChatId] = useState('');
  const [target, setTarget] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [withFiles, setWithFiles] = useState(false);
  const [visibility, setVisibility] = useState('public');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api('GET', '/admin/tele/mirrors')
      .then(setData)
      .catch((e) => showToast(e.message));
  // Live from Telegram: every channel the owner's account follows (and a public one by @name).
  const findChannels = async (term = q) => {
    setSearching(true);
    try {
      const r = await api('GET', `/admin/tele/mirrors/channels${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ''}`, undefined, { timeout: 90000 });
      setChannels(r.channels);
      if (r.channels.length === 1) setTgChatId(r.channels[0].tgChatId);
    } catch (e) {
      showToast(e.message);
    }
    setSearching(false);
  };
  useEffect(() => {
    if (me.role === 'owner') load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (data?.connected && !channels) findChannels('');
  }, [data?.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  if (me.role !== 'owner' || !data) return null;
  const act = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) showToast(ok);
      await load();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  };
  const copy = (text) =>
    navigator.clipboard?.writeText(text).then(
      () => showToast('لینک کپی شد'),
      () => prompt('لینک دعوت:', text),
    ) ?? prompt('لینک دعوت:', text);
  const used = new Set(data.mirrors.map((m) => m.tgChatId));
  const free = (channels || []).filter((c) => !used.has(c.tgChatId));
  return (
    <div className="boxed tele-mirrors" style={{ marginTop: 16 }}>
      <h4 className="with-icon">
        <Newspaper size={16} /> انتشار کانال‌ها و گروه‌های تلگرام در برنامه (فقط مالک)
      </h4>
      <p className="hint">پست‌های یک کانال (یا پیام‌های یک گروه، با نام نویسنده) خودکار در یک کانال همین برنامه منتشر می‌شوند؛ کاربران بدون تلگرام می‌خوانند و ترافیک فقط یک بار مصرف می‌شود. عکس، ویدیو و فایل فقط وقتی کسی رویشان بزند از تلگرام گرفته می‌شوند و بعد برای همه آماده‌اند؛ ویدیو و فایل را فقط کاربرانی که پایین‌تر انتخاب می‌کنید می‌گیرند.</p>
      {!data.connected ? (
        <p className="muted">اول حساب تلگرام خودتان را از منو ← تلگرام وصل کنید.</p>
      ) : (
        <>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              findChannels();
            }}
          >
            <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو در کانال‌ها و گروه‌های شما، یا ‎@نام‌کاربری / لینک t.me یک کانال یا گروه عمومی" />
            <button className={`btn sm ${searching ? 'spin' : ''}`} disabled={searching}>
              <RefreshCw size={14} /> {searching ? 'در حال دریافت…' : 'جستجو'}
            </button>
          </form>
          <form
            className="tele-mirror-form"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api('POST', '/admin/tele/mirrors', { tgChatId, ...(target ? { chatId: Number(target) } : {}), withPhotos, withFiles, visibility }, { timeout: 120000 }), 'اضافه شد').then(() => setTgChatId(''));
            }}
          >
            <select value={tgChatId} onChange={(e) => setTgChatId(e.target.value)}>
              <option value="">{channels ? `— کانال یا گروه تلگرام (${toFa(free.length)}) —` : '— در حال دریافت کانال‌ها و گروه‌ها… —'}</option>
              {free.map((c) => (
                <option key={c.tgChatId} value={c.tgChatId}>
                  {c.kind === 'group' ? '👥 ' : '📢 '}
                  {c.title}
                  {c.username ? ` (@${c.username})` : ''}
                  {c.joined ? '' : ' · عضو نیستید'}
                </option>
              ))}
            </select>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">کانال تازه در برنامه</option>
              {data.appChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="چه کسانی ببینند">
              {Object.entries(VIS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <label className="check">
              <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} /> عکس‌ها (با اولین کلیک)
            </label>
            <label className="check">
              <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> ویدیو و فایل (با اولین کلیک)
            </label>
            <button className="btn sm primary" disabled={!tgChatId || busy}>
              افزودن
            </button>
          </form>
          {channels && !channels.length && <small className="muted">چیزی پیدا نشد. برای کانال یا گروه عمومی‌ای که عضوش نیستید، ‎@نام‌کاربری آن را جستجو کنید.</small>}
          <ul className="user-list">
            {data.mirrors.map((m) => (
              <li key={m.id} className="row-item tele-mirror">
                <span className="grow">
                  {m.kind === 'group' && <span className="tag">گروه</span>} <b>{m.title}</b> ← {m.chatTitle || '—'}
                  {!m.enabled && <span className="tag">متوقف</span>}
                  <br />
                  <small className="muted">
                    {toFa(m.members)} عضو · {m.lastRunAt ? `آخرین بررسی: ${formatDateTime(m.lastRunAt)}` : 'هنوز بررسی نشده'}
                    {m.lastError ? ` · خطا: ${m.lastError}` : ''}
                  </small>
                  {m.visibility === 'link' && m.inviteCode && (
                    <span className="inline-form tele-invite">
                      <input readOnly dir="ltr" value={inviteLink(m.inviteCode)} onFocus={(e) => e.target.select()} />
                      <button type="button" className="btn sm" onClick={() => copy(inviteLink(m.inviteCode))}>
                        <Copy size={14} /> کپی
                      </button>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => confirm('لینک تازه ساخته شود؟ لینک قبلی دیگر کار نمی‌کند (کسانی که عضو شده‌اند می‌مانند).') && act(() => api('POST', `/admin/tele/mirrors/${m.id}/invite`), 'لینک تازه ساخته شد')}>
                        لینک تازه
                      </button>
                    </span>
                  )}
                </span>
                <span className="tele-user-ctl">
                  <select value={m.visibility} disabled={busy} onChange={(e) => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { visibility: e.target.value }), 'ذخیره شد')} aria-label="چه کسانی ببینند">
                    {Object.entries(VIS_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <label className="check">
                    <input type="checkbox" checked={m.withPhotos} onChange={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { withPhotos: !m.withPhotos }))} /> عکس
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={m.withFiles} onChange={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { withFiles: !m.withFiles }))} /> ویدیو/فایل
                  </label>
                  <button className="btn sm" disabled={busy} onClick={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { enabled: !m.enabled }))}>
                    {m.enabled ? 'توقف' : 'ادامه'}
                  </button>
                  <button className="btn sm danger" disabled={busy} onClick={() => confirm('انتشار این کانال متوقف و حذف شود؟ (کانال برنامه و پست‌هایش می‌مانند)') && act(() => api('DELETE', `/admin/tele/mirrors/${m.id}`))}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </li>
            ))}
            {!data.mirrors.length && <li className="muted">هنوز کانال یا گروهی منتشر نمی‌شود.</li>}
          </ul>
          <div className="inline-form">
            <label className="inline-form">
              بررسی هر
              <input
                type="number"
                min={1}
                max={1440}
                dir="ltr"
                style={{ width: 72 }}
                defaultValue={data.minutes}
                key={`m-${data.minutes}`}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(1440, Math.round(Number(e.target.value)) || 5));
                  if (n !== data.minutes) act(() => api('PATCH', '/admin/tele/mirrors-settings', { minutes: n }), 'ذخیره شد');
                }}
              />
              دقیقه
            </label>
            <button type="button" className="btn sm" disabled={busy || !data.mirrors.length} onClick={() => act(() => api('POST', '/admin/tele/mirrors/run', {}, { timeout: 180000 }), 'بررسی شد')}>
              <RefreshCw size={14} /> بررسی الان
            </button>
          </div>
        </>
      )}
    </div>
  );
}
