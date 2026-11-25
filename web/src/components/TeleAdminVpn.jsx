// Admin panel → VPN: the tunnel the Telegram part goes through (proxies, routing, alerts).
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toFa, formatDateTime } from '../util';
import { confirmDialog } from '../confirm';
import { adminProxies, saveTelePolicy, probeProxy, deleteProxy, patchProxy as patchProxyApi, restartEgress, teleAlerts, saveTeleAlerts, testTeleAlert } from '../teleApi';
import TeleAddProxy from './TeleProxyForm';
import Segments from './Segments';
import { RefreshCw, Trash2, Activity, Power, BellRing, Plus, Network } from 'lucide-react';
import { Skeleton, ErrorState, EmptyState } from './States';

export default function VpnAdmin() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [probing, setProbing] = useState(null); // proxy id, or 'all'
  const [page, setPage] = useState('proxies');
  const [adding, setAdding] = useState(false);
  // Bumped when a proxy edit is refused, so its fields show the saved value again.
  const [rev, setRev] = useState(0);

  const load = () =>
    adminProxies()
      .then((d) => {
        setError('');
        setData(d);
      })
      .catch((e) => (data ? showToast(e.message) : setError(e.message)));

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={4} />;

  const policy = data.policy || {};
  const proxies = data.proxies || [];
  const egress = data.egress || {};

  const savePolicy = async (patch) => {
    try {
      const r = await saveTelePolicy(patch);
      setData((d) => ({ ...d, policy: r.policy, egress: r.egress || d.egress }));
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  };

  const probe = async (id) => {
    setProbing(id);
    try {
      const r = await probeProxy(id);
      await load();
      if (id !== 'all') showToast(r.proxy?.lastStatus === 'healthy' ? `سالم · ${toFa(r.proxy.lastLatencyMs)} ms` : `ناموفق: ${r.proxy?.lastError || ''}`);
    } catch (e) {
      showToast(e.message);
    }
    setProbing(null);
  };

  const remove = async (id) => {
    if (!(await confirmDialog({ title: 'این پروکسی حذف شود؟', confirmLabel: 'حذف', danger: true }))) return;
    try {
      await deleteProxy(id);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const patchProxy = async (id, patch) => {
    try {
      await patchProxyApi(id, patch);
      await load();
    } catch (e) {
      setRev((n) => n + 1);
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
      await restartEgress();
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
      {egress.running && egress.tunnelError && <small className="tele-warn">اتصال تونل به پروکسی برقرار نشد. آخرین خطای تونل: {egress.tunnelError}</small>}

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
                          className="num-input"
                          defaultValue={p.priority}
                          key={`${p.priority}-${rev}`}
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
          </ul>
          {!proxies.length && <EmptyState compact icon={<Network size={32} />} title="هنوز پروکسی‌ای اضافه نشده" hint="تلگرام فقط از راه پروکسی‌ها وصل می‌شود؛ با «افزودن پروکسی» اولی را بسازید." />}
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
                className="num-input"
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
  const [error, setError] = useState('');
  const load = () =>
    teleAlerts()
      .then((r) => {
        setError('');
        setA(r.alerts);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={3} />;
  const save = async (patch) => {
    try {
      setA((await saveTeleAlerts(patch)).alerts);
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  };
  const test = async () => {
    try {
      const r = await testTeleAlert();
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
    className: 'num-input',
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
          <div className="inline-form">
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
