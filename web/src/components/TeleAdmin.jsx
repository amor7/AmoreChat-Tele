import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, faDigits, formatDateTime } from '../util';
import TeleAddProxy from './TeleProxyForm';
import { QrButton } from './QrCode';
import { RefreshCw, Trash2, Activity, Power, BellRing, BarChart3, Copy, UserCheck, FileDown, LineChart, Plus, CircleCheck, Circle, TriangleAlert, ChevronLeft } from 'lucide-react';

// Sub-pages of the Telegram and VPN tabs, so each shows one thing at a time.
function Segments({ items, value, onChange }) {
  return (
    <div className="tele-seg" role="tablist">
      {items.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function VpnAdmin() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [probing, setProbing] = useState(null); // proxy id, or 'all'
  const [page, setPage] = useState('proxies');
  const [adding, setAdding] = useState(false);

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

  const healthy = proxies.filter((p) => p.enabled && p.lastStatus === 'healthy').length;
  const restart = async () => {
    try {
      await api('POST', '/admin/tele/egress/restart');
      await load();
      showToast('تونل ری‌استارت شد');
    } catch (e) {
      showToast(e.message);
      await load();
    }
  };

  return (
    <div className="tele-admin">
      <div className={`tele-hero ${egress.running ? 'ok' : 'bad'}`}>
        <span className="tele-dot" />
        <span className="grow">
          <b>{egress.running ? 'تونل تلگرام وصل است' : 'تونل تلگرام خاموش است'}</b>
          <small>
            {egress.running && active ? `از طریق «${active.name}»` : policy.enabled ? 'پروکسی سالمی پیدا نشده' : 'مسیر تلگرام در تنظیمات خاموش است'} · {toFa(healthy)} از {toFa(proxies.length)} پروکسی سالم
          </small>
        </span>
        <button type="button" className="btn sm" onClick={restart}>
          <Power size={14} /> ری‌استارت
        </button>
      </div>
      {egress.lastError && <small className="tele-warn">{egress.lastError}</small>}
      {egress.running && egress.tunnelError && <small className="tele-warn">آخرین خطای تونل: {egress.tunnelError}</small>}

      <Segments
        value={page}
        onChange={setPage}
        items={[
          ['proxies', `پروکسی‌ها (${toFa(proxies.length)})`],
          ['settings', 'تنظیمات'],
          ['alerts', 'هشدارها'],
        ]}
      />

      {page === 'proxies' && (
        <>
          <div className="tele-actions">
            <button type="button" className="btn sm primary" onClick={() => setAdding(!adding)}>
              <Plus size={14} /> افزودن پروکسی
            </button>
            <button type="button" className="btn sm" disabled={probing != null} onClick={() => probe('all')}>
              <Activity size={14} /> {probing === 'all' ? 'در حال تست…' : 'تست همه'}
            </button>
            <button type="button" className="btn sm" onClick={load}>
              <RefreshCw size={14} /> به‌روزرسانی
            </button>
          </div>
          {adding && (
            <TeleAddProxy
              onAdded={() => {
                setAdding(false);
                load();
              }}
            />
          )}
          <ul className="tele-list">
            {proxies.map((p) => {
              const [label, color] = STATUS[p.lastStatus] || STATUS.unknown;
              return (
                <li key={p.id}>
                  <details className="tele-card">
                    <summary>
                      <span className={`tele-dot ${p.enabled && p.lastStatus === 'healthy' ? 'on' : p.lastStatus === 'unhealthy' ? 'off' : ''}`} />
                      <span className="grow">
                        <b>{p.name}</b>
                        <small>
                          {p.protocol} · {label}
                          {p.lastLatencyMs != null ? ` · ${toFa(p.lastLatencyMs)} ms` : ''}
                        </small>
                      </span>
                      {p.id === egress.proxyId && egress.running && <span className="tag ok">در حال استفاده</span>}
                      {!p.enabled && <span className={`tag ${color === 'danger' ? 'danger' : ''}`}>خاموش</span>}
                    </summary>
                    <div className="tele-card-body">
                      {p.lastError && <small className="tele-warn">{p.lastError}</small>}
                      {p.lastCheckedAt && <small className="muted">آخرین تست: {formatDateTime(p.lastCheckedAt)}</small>}
                      <label className="inline-form" title="عدد کمتر = اولویت بالاتر">
                        اولویت
                        <input
                          type="number"
                          min={0}
                          max={9999}
                          dir="ltr"
                          style={{ width: 80 }}
                          defaultValue={p.priority}
                          key={p.priority}
                          onBlur={(e) => Number(e.target.value) !== p.priority && patchProxy(p.id, { priority: Number(e.target.value) })}
                        />
                      </label>
                      <div className="tele-actions">
                        <button className="btn sm" disabled={probing != null} onClick={() => probe(p.id)}>
                          <Activity size={14} /> {probing === p.id ? 'در حال تست…' : 'تست تا تلگرام'}
                        </button>
                        <button className="btn sm" onClick={() => patchProxy(p.id, { enabled: !p.enabled })}>
                          {p.enabled ? 'خاموش کردن' : 'روشن کردن'}
                        </button>
                        <button className="btn sm danger" onClick={() => remove(p.id)}>
                          <Trash2 size={14} /> حذف
                        </button>
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
            {!proxies.length && <li className="muted center">هنوز پروکسی‌ای اضافه نشده</li>}
          </ul>
        </>
      )}

      {page === 'settings' && (
        <>
          <div className="tele-group">
            <h4>مسیر تلگرام</h4>
            <p className="hint">فقط ترافیک تلگرام از پروکسی‌ها رد می‌شود و چت داخلی همیشه روی شبکه داخلی می‌ماند. اگر همه قطع باشند، تلگرام در صف می‌ماند و هرگز مستقیم وصل نمی‌شود.</p>
            <label className="check">
              <input type="checkbox" checked={!!policy.enabled} onChange={(e) => savePolicy({ enabled: e.target.checked })} />
              تلگرام از طریق پروکسی‌ها فعال باشد
            </label>
            <label>
              انتخاب پروکسی
              <select value={policy.mode || 'priority'} onChange={(e) => savePolicy({ mode: e.target.value })}>
                <option value="priority">اولویت (اولین سالم)</option>
                <option value="best">کمترین تأخیر</option>
                <option value="random">تصادفی بین سالم‌ها</option>
                <option value="manual">دستی</option>
              </select>
            </label>
            {policy.mode === 'manual' && (
              <label>
                پروکسی ثابت
                <select value={policy.activeProxyId || ''} onChange={(e) => savePolicy({ activeProxyId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— انتخاب —</option>
                  {proxies.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.protocol})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="tele-group">
            <h4>تست خودکار</h4>
            <label className="check">
              <input type="checkbox" checked={!!policy.autoHealth} onChange={(e) => savePolicy({ autoHealth: e.target.checked })} />
              پروکسی‌ها مرتب تا سرور تلگرام تست شوند و پروکسی خراب خودکار عوض شود
            </label>
            <label className="inline-form">
              هر
              <input
                type="number"
                min={1}
                max={1440}
                dir="ltr"
                style={{ width: 80 }}
                defaultValue={minutes}
                key={minutes}
                onBlur={(e) => {
                  const m = Math.max(1, Math.min(1440, Math.round(Number(e.target.value)) || 10));
                  if (m !== minutes) savePolicy({ healthIntervalSec: m * 60 });
                }}
              />
              دقیقه
            </label>
            <small className="muted">
              {health.lastRunAt ? `آخرین تست: ${formatDateTime(health.lastRunAt)}. ` : ''}
              {policy.autoHealth && health.nextRunAt ? `تست بعدی: ${formatDateTime(health.nextRunAt)}.` : ''}
            </small>
          </div>

          <details className="tele-group">
            <summary>DNS پروکسی‌ها (پیشرفته)</summary>
            <p className="hint">معمولاً لازم نیست چیزی بنویسید: آدرس پروکسی‌های دامنه‌دار خودکار از چند DNS داخلی پرسیده می‌شود و آخرین IP سالم برای زمان قطعی می‌ماند. فقط اگر DNS دیگری مثل DNS دیتاسنتر دارید، اینجا بگذارید.</p>
            <input
              dir="ltr"
              list="tele-dns-presets"
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
          </details>
          {egress.singBoxVersion && <small className="muted">sing-box {egress.singBoxVersion}</small>}
        </>
      )}

      {page === 'alerts' && <TeleAlerts />}
    </div>
  );
}

// The Telegram tab: an overview, the users, and the channels copied into the app.
// The VPN tab (the default export) is only about the tunnel the Telegram part goes through.
export function TeleSection({ onVpn }) {
  const me = useStore((s) => s.me);
  const [page, setPage] = useState('overview');
  return (
    <div className="tele-admin">
      <Segments
        value={page}
        onChange={setPage}
        items={[
          ['overview', 'نمای کلی'],
          ['users', 'کاربران'],
          ...(me.role === 'owner' ? [['channels', 'کانال‌های منتشرشده']] : []),
        ]}
      />
      {page === 'overview' && <TeleOverview go={setPage} onVpn={onVpn} />}
      {page === 'users' && (
        <>
          <TeleAccess />
          <TeleUsers />
        </>
      )}
      {page === 'channels' && (
        <>
          <TeleMirrors />
          <TeleAccess
            path="/admin/access/mirror-files"
            icon={FileDown}
            title="چه کسانی ویدیو و فایل کانال را بگیرند"
            hint="اولین باز کردن ویدیو یا فایل از تلگرام گرفته می‌شود و VPN مصرف می‌کند. فقط این کاربران می‌توانند آن را بگیرند؛ بعد از آن برای همه اعضا باز است."
            labels={FILES_LABELS}
          />
        </>
      )}
    </div>
  );
}

// What is working and what needs attention, each with a way to it.
function TeleOverview({ go, onVpn }) {
  const me = useStore((s) => s.me);
  const [d, setD] = useState(null);
  useEffect(() => {
    const quiet = (url) => api('GET', url).catch(() => null);
    Promise.all([quiet('/admin/tele/accounts'), quiet('/admin/tele/proxies'), me.role === 'owner' ? quiet('/admin/tele/mirrors') : null]).then(([accounts, net, mirrors]) => setD({ accounts, net, mirrors }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <p className="muted">…</p>;

  const users = d.accounts?.accounts || [];
  const proxies = d.net?.proxies || [];
  const mirrors = d.mirrors?.mirrors || [];
  const running = !!d.net?.egress?.running;
  const connected = users.filter((a) => a.status === 'connected').length;
  const usage = users.reduce((n, a) => n + a.used, 0);
  const capped = users.filter((a) => a.effectiveQuotaMb > 0 && a.used >= a.effectiveQuotaMb * 1048576);
  const broken = mirrors.filter((m) => m.lastError);
  const ownerReady = d.mirrors ? !!d.mirrors.connected : true;

  const steps = [
    ['پروکسی اضافه کنید', proxies.length > 0, onVpn],
    ['در VPN ← تنظیمات، مسیر تلگرام را روشن کنید', !!d.net?.policy?.enabled, onVpn],
    ...(me.role === 'owner' ? [['حساب تلگرام خودتان را از منو ← تلگرام وصل کنید', ownerReady, null]] : []),
  ];
  const issues = [
    !running && d.net?.policy?.enabled && ['تونل قطع است؛ کاربران به تلگرام وصل نمی‌شوند', onVpn],
    broken.length > 0 && [`${toFa(broken.length)} کانال منتشرشده خطا دارد`, () => go('channels')],
    capped.length > 0 && [`${toFa(capped.length)} کاربر به سقف مصرف رسیده`, () => go('users')],
  ].filter(Boolean);
  const ready = steps.every(([, done]) => done);
  const cards = [
    ['تونل', running ? 'وصل' : 'خاموش'],
    ['کاربران وصل', `${toFa(connected)} از ${toFa(users.length)}`],
    ['مصرف این ماه', mbText(usage)],
    ...(d.mirrors ? [['کانال‌های منتشرشده', toFa(mirrors.filter((m) => m.enabled).length)]] : []),
  ];

  return (
    <>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div key={label} className="stat">
            <small>{label}</small>
            <b>{value}</b>
          </div>
        ))}
      </div>
      {!ready && (
        <div className="tele-group">
          <h4>راه‌اندازی</h4>
          <ol className="tele-steps">
            {steps.map(([label, done, action]) => (
              <li key={label} className={done ? 'done' : ''}>
                {done ? <CircleCheck size={18} /> : <Circle size={18} />}
                {action && !done ? (
                  <button type="button" className="tele-link" onClick={action}>
                    {label} <ChevronLeft size={14} />
                  </button>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {issues.map(([text, action]) => (
        <button key={text} type="button" className="tele-issue" onClick={action}>
          <TriangleAlert size={17} />
          <span className="grow">{text}</span>
          <ChevronLeft size={16} />
        </button>
      ))}
      {ready && !issues.length && (
        <p className="tele-fine">
          <CircleCheck size={18} /> همه‌چیز سالم است.
        </p>
      )}
      {users.length > 0 && (
        <div className="tele-group">
          <h4>پرمصرف‌ترین کاربران این ماه</h4>
          <ul className="tele-top">
            {users.slice(0, 5).map((a) => (
              <li key={a.id}>
                <span className="grow">{a.name}</span>
                <small dir="auto">{mbText(a.used)}</small>
                <span className="tele-usage-bar">
                  <span style={{ width: `${users[0].used ? (a.used / users[0].used) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="tele-link" onClick={() => go('users')}>
            همه کاربران <ChevronLeft size={14} />
          </button>
        </div>
      )}
    </>
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
    <div className="tele-group tele-alerts">
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
  const [q, setQ] = useState('');
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
  const term = q.trim().toLowerCase();
  const shown = data.accounts.filter((a) => !term || `${a.name} ${a.username} ${a.tgName || ''}`.toLowerCase().includes(term));
  const top = data.accounts[0]?.used || 0;

  return (
    <div className="tele-group">
      <h4 className="with-icon">
        <BarChart3 size={16} /> کاربران و مصرف این ماه
      </h4>
      <input className="search" placeholder="جستجوی کاربر…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="tele-list tele-users">
        {shown.map((a) => {
          const cap = a.effectiveQuotaMb;
          const over = cap > 0 && a.used >= cap * 1048576;
          return (
            <li key={a.id}>
              <details className="tele-card">
                <summary>
                  <span className={`tele-dot ${a.status === 'connected' ? 'on' : ''}`} />
                  <span className="grow">
                    <b>{a.name}</b> {over && <span className="tag danger">به سقف رسید</span>}
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
                </summary>
                <div className="tele-card-body">
                  <small className="muted">
                    @{a.username} · تلگرام: {a.tgName || '—'} · {a.status === 'connected' ? (a.live ? 'وصل' : 'وصل (در حالت صرفه‌جویی)') : 'وصل نیست'}
                  </small>
                  <b>چه چیزهایی را بگیرد</b>
                  <div className="tele-perms">
                    <label className="check">
                      <input type="checkbox" checked={a.allowMedia} onChange={() => patch(a, { allowMedia: !a.allowMedia })} /> عکس
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={a.allowVoice} onChange={() => patch(a, { allowVoice: !a.allowVoice })} /> صوت
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={a.allowFiles} onChange={() => patch(a, { allowFiles: !a.allowFiles })} /> فایل و ویدیو
                    </label>
                  </div>
                  <label className="check" title={a.owner ? 'مالک همیشه این اجازه را دارد' : ''}>
                    <input type="checkbox" checked={a.allowExplore} disabled={a.owner} onChange={() => patch(a, { allowExplore: !a.allowExplore })} /> پیام به هر کس و عضویت در گروه و کانال جدید
                  </label>
                  <label className="inline-form">
                    سقف ماهانه (MB)
                    <input
                      type="number"
                      min={0}
                      dir="ltr"
                      style={{ width: 96 }}
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
                  <small className="muted">خالی = سقف پیش‌فرض · ۰ = بدون سقف</small>
                  <button type="button" className="btn sm" onClick={() => setChartFor(chartFor === a.id ? null : a.id)}>
                    <LineChart size={14} /> نمودار مصرف
                  </button>
                  {chartFor === a.id && <UsageChart accountId={a.id} />}
                </div>
              </details>
            </li>
          );
        })}
        {!shown.length && <li className="muted center">{data.accounts.length ? 'کاربری پیدا نشد.' : 'هنوز کسی حساب تلگرام وصل نکرده است.'}</li>}
      </ul>
      <details className="tele-group">
        <summary>تنظیمات پیش‌فرض همه کاربران</summary>
        <p className="hint">عکس، صوت و فایل پیش‌فرض برای همه خاموش است و فقط با زدن روی آن‌ها دانلود می‌شوند.</p>
        <form className="inline-form" onSubmit={saveQuota}>
          <label className="grow">
            سقف مصرف ماهانه (مگابایت، ۰ = بدون سقف)
            <input type="number" min={0} dir="ltr" value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} />
          </label>
          <button className="btn sm">ذخیره</button>
        </form>
        <form className="inline-form" onSubmit={saveMax}>
          <label className="grow">
            حداکثر عکس یا صوت (مگابایت)
            <input type="number" min={1} max={50} dir="ltr" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
          </label>
          <label className="grow">
            حداکثر فایل یا ویدیو (مگابایت)
            <input type="number" min={1} max={2000} dir="ltr" value={fileMb} onChange={(e) => setFileMb(e.target.value)} />
          </label>
          <button className="btn sm">ذخیره</button>
        </form>
      </details>
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
  title = 'چه کسانی تلگرام داشته باشند',
  hint = 'بستن برای کسی که وارد شده، اتصالش را همان لحظه می‌بندد؛ حسابش می‌ماند و با باز شدن دوباره کار می‌کند. مالک همیشه دسترسی دارد.',
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
    <div className="tele-group">
      <h4 className="with-icon">
        <Icon size={16} /> {title}
      </h4>
      <p className="hint">{hint}</p>
      <label>
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
  const [adding, setAdding] = useState(false);
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
  const addForm = (
    <form
      className="tele-group"
      onSubmit={(e) => {
        e.preventDefault();
        act(() => api('POST', '/admin/tele/mirrors', { tgChatId, ...(target ? { chatId: Number(target) } : {}), withPhotos, withFiles, visibility }, { timeout: 120000 }), 'اضافه شد').then(() => {
          setTgChatId('');
          setAdding(false);
        });
      }}
    >
      <label>
        ۱. کانال یا گروه تلگرام
        <span className="inline-form">
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو، ‎@نام‌کاربری یا لینک t.me" />
          <button type="button" className={`btn sm ${searching ? 'spin' : ''}`} disabled={searching} onClick={() => findChannels()}>
            <RefreshCw size={14} /> {searching ? 'در حال دریافت…' : 'جستجو'}
          </button>
        </span>
      </label>
      <select value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} aria-label="کانال تلگرام">
        <option value="">{channels ? `— انتخاب کنید (${toFa(free.length)}) —` : '— در حال دریافت… —'}</option>
        {free.map((c) => (
          <option key={c.tgChatId} value={c.tgChatId}>
            {c.kind === 'group' ? '👥 ' : '📢 '}
            {c.title}
            {c.username ? ` (@${c.username})` : ''}
            {c.joined ? '' : ' · عضو نیستید'}
          </option>
        ))}
      </select>
      {channels && !channels.length && <small className="muted">چیزی پیدا نشد. برای کانال عمومی‌ای که عضوش نیستید، ‎@نام‌کاربری آن را جستجو کنید.</small>}
      <label>
        ۲. کجا منتشر شود
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">کانال تازه در برنامه</option>
          {data.appChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        ۳. چه کسانی ببینند
        <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          {Object.entries(VIS_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} /> عکس‌ها را هم بیاور (با اولین باز کردن)
      </label>
      <label className="check">
        <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> ویدیو و فایل را هم بیاور (با اولین باز کردن)
      </label>
      <button className="btn sm primary" disabled={!tgChatId || busy}>
        افزودن
      </button>
    </form>
  );

  return (
    <div className="tele-mirrors">
      <p className="hint">پست‌های تلگرام خودکار در یک کانال همین برنامه منتشر می‌شوند؛ کاربران بدون تلگرام می‌خوانند و ترافیک فقط یک بار مصرف می‌شود.</p>
      {!data.connected ? (
        <p className="muted">اول حساب تلگرام خودتان را از منو ← تلگرام وصل کنید.</p>
      ) : (
        <>
          <div className="tele-actions">
            <button type="button" className="btn sm primary" onClick={() => setAdding(!adding)}>
              <Plus size={14} /> افزودن کانال
            </button>
            <button type="button" className="btn sm" disabled={busy || !data.mirrors.length} onClick={() => act(() => api('POST', '/admin/tele/mirrors/run', {}, { timeout: 180000 }), 'بررسی شد')}>
              <RefreshCw size={14} /> بررسی الان
            </button>
          </div>
          {adding && addForm}
          <ul className="tele-list">
            {data.mirrors.map((m) => (
              <li key={m.id}>
                <details className="tele-card tele-mirror">
                  <summary>
                    <span className={`tele-dot ${m.lastError ? 'off' : m.enabled ? 'on' : ''}`} />
                    <span className="grow">
                      <b>{m.chatTitle || m.title}</b>
                      <small>
                        {m.handle && <span dir="ltr">@{m.handle}</span>} {m.kind === 'group' ? '· گروه ' : ''}· {toFa(m.members)} عضو
                        {m.enabled ? '' : ' · متوقف'}
                      </small>
                    </span>
                  </summary>
                  <div className="tele-card-body">
                    <small className="muted">
                      از تلگرام: {m.title} · {m.lastRunAt ? `آخرین بررسی: ${formatDateTime(m.lastRunAt)}` : 'هنوز بررسی نشده'}
                    </small>
                    {m.lastError && <small className="tele-warn">{m.lastError}</small>}
                    <label>
                      چه کسانی ببینند
                      <select value={m.visibility} disabled={busy} onChange={(e) => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { visibility: e.target.value }), 'ذخیره شد')}>
                        {Object.entries(VIS_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {m.visibility === 'link' && m.inviteCode && (
                      <span className="inline-form tele-invite">
                        <input readOnly dir="ltr" value={inviteLink(m.inviteCode)} onFocus={(e) => e.target.select()} />
                        <button type="button" className="btn sm" onClick={() => copy(inviteLink(m.inviteCode))}>
                          <Copy size={14} /> کپی
                        </button>
                        <QrButton value={inviteLink(m.inviteCode)} title="کد QR لینک دعوت" />
                        <button type="button" className="btn sm" disabled={busy} onClick={() => confirm('لینک تازه ساخته شود؟ لینک قبلی دیگر کار نمی‌کند (کسانی که عضو شده‌اند می‌مانند).') && act(() => api('POST', `/admin/tele/mirrors/${m.id}/invite`), 'لینک تازه ساخته شد')}>
                          لینک تازه
                        </button>
                      </span>
                    )}
                    <div className="tele-perms">
                      <label className="check">
                        <input type="checkbox" checked={m.withPhotos} onChange={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { withPhotos: !m.withPhotos }))} /> عکس
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={m.withFiles} onChange={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { withFiles: !m.withFiles }))} /> ویدیو و فایل
                      </label>
                    </div>
                    <div className="tele-actions">
                      <button className="btn sm" disabled={busy} onClick={() => act(() => api('PATCH', `/admin/tele/mirrors/${m.id}`, { enabled: !m.enabled }))}>
                        {m.enabled ? 'توقف' : 'ادامه'}
                      </button>
                      <button className="btn sm danger" disabled={busy} onClick={() => confirm('انتشار این کانال متوقف و حذف شود؟ (کانال برنامه و پست‌هایش می‌مانند)') && act(() => api('DELETE', `/admin/tele/mirrors/${m.id}`))}>
                        <Trash2 size={14} /> حذف انتشار
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            ))}
            {!data.mirrors.length && <li className="muted center">هنوز کانال یا گروهی منتشر نمی‌شود.</li>}
          </ul>
          <details className="tele-group">
            <summary>تنظیمات انتشار</summary>
            <label className="inline-form">
              بررسی پست‌های جدید هر
              <input
                type="number"
                min={1}
                max={1440}
                dir="ltr"
                style={{ width: 80 }}
                defaultValue={data.minutes}
                key={`m-${data.minutes}`}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(1440, Math.round(Number(e.target.value)) || 5));
                  if (n !== data.minutes) act(() => api('PATCH', '/admin/tele/mirrors-settings', { minutes: n }), 'ذخیره شد');
                }}
              />
              دقیقه
            </label>
          </details>
        </>
      )}
    </div>
  );
}
