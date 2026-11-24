// Admin panel → Telegram → users: who may use Telegram, each user's traffic, cap and what they
// may fetch. TeleAccess is also used for «who may fetch channel videos and files».
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toFa, faDigits, formatSize } from '../util';
import { adminTeleAccounts, patchTeleAccount, teleAccountUsage, saveTeleMediaLimits, saveTeleQuota, adminAccess, saveAdminAccess } from '../teleApi';
import { BarChart3, UserCheck, LineChart, Users } from 'lucide-react';
import { Skeleton, ErrorState, EmptyState } from './States';

// Traffic in Persian units (کیلوبایت / مگابایت / گیگابایت), like every other size in the app.
export const mbText = (bytes) => (bytes > 0 ? formatSize(bytes) : '۰ مگابایت');

// Users of Telegram: this month's traffic (highest first), cap, and photo / voice permission.
export function TeleUsers() {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [fileMb, setFileMb] = useState('');
  const [quotaMb, setQuotaMb] = useState('');
  const [chartFor, setChartFor] = useState(null);
  const [q, setQ] = useState('');
  const load = () =>
    adminTeleAccounts()
      .then((r) => {
        setError('');
        setData(r);
        setMaxMb(String(r.mediaMaxMb));
        setFileMb(String(r.fileMaxMb));
        setQuotaMb(String(r.defaultQuotaMb));
      })
      .catch((e) => (data ? showToast(e.message) : setError(e.message)));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // announce off: TeleAccess above it says «loading» for the page.
  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={4} announce={false} />;

  const patch = async (a, body) => {
    try {
      await patchTeleAccount(a.id, body);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const saveMax = async (e) => {
    e.preventDefault();
    try {
      await saveTeleMediaLimits(Number(maxMb), Number(fileMb));
      showToast('ذخیره شد');
      await load();
    } catch (err) {
      showToast(err.message);
    }
  };
  const saveQuota = async (e) => {
    e.preventDefault();
    try {
      await saveTeleQuota(Number(quotaMb));
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
                        {/* Data-driven width: the one kind of inline style left here. */}
                        <span style={{ width: `${cap > 0 ? Math.min(100, (a.used / (cap * 1048576)) * 100) : top ? (a.used / top) * 100 : 0}%` }} className={over ? 'over' : ''} />
                      </span>
                      <small dir="auto">
                        {mbText(a.used)}
                        {cap > 0 ? ` از ${formatSize(cap * 1048576)}` : ''}
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
                    سقف ماهانه (مگابایت)
                    <input
                      type="number"
                      min={0}
                      dir="ltr"
                      className="num-input wide"
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
      </ul>
      {!shown.length && (data.accounts.length ? <EmptyState compact hint="کاربری پیدا نشد." /> : <EmptyState compact icon={<Users size={32} />} title="هنوز کسی حساب تلگرام وصل نکرده است." />)}
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
  const [error, setError] = useState('');
  const load = () =>
    teleAccountUsage(accountId)
      .then((r) => {
        setError('');
        setU(r);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!u) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={2} />;
  const bars = (rows, label) => {
    const max = Math.max(1, ...rows.map((r) => r.bytes));
    return (
      <div className="usage-bars" role="img" aria-label={label}>
        {rows.map((r) => (
          // Data-driven height (no class can know it).
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
export const FILES_LABELS = {
  all: 'همه کاربران',
  none: 'هیچ‌کس (جز مالک)',
  allow: 'فقط کاربرانی که انتخاب می‌کنید',
  deny: 'همه، جز کاربرانی که انتخاب می‌کنید',
};
export function TeleAccess({
  feature = 'tele',
  icon: Icon = UserCheck,
  title = 'چه کسانی تلگرام داشته باشند',
  hint = 'بستن برای کسی که وارد شده، اتصالش را همان لحظه می‌بندد؛ حسابش می‌ماند و با باز شدن دوباره کار می‌کند. مالک همیشه دسترسی دارد.',
  labels = ACCESS_LABELS,
  announce = true,
}) {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    adminAccess(feature)
      .then((r) => {
        setError('');
        setData(r);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [feature]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={2} announce={announce} />;
  const save = async (body) => {
    setBusy(true);
    try {
      setData(await saveAdminAccess(feature, body));
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
          </ul>
          {!shown.length && <EmptyState compact hint="کاربری پیدا نشد." />}
        </>
      )}
    </div>
  );
}
