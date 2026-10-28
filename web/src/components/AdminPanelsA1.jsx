import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { hasSitePerm, SITE_PERM_LABELS, ROLE_LABELS, formatDateTime, formatSize, formatLastSeen, toFa } from '../util';
import Avatar from './Avatar';
import { LimitsEditor } from './AdminRtc';
import { TriangleAlert, SlidersHorizontal } from 'lucide-react';

export function useLoad(url) {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const latest = useRef(url);
  latest.current = url;
  const load = () =>
    api('GET', url)
      .then((d) => latest.current === url && setData(d))
      .catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, load];
}

export function Stats() {
  const [s, load] = useLoad('/admin/stats');
  useEffect(() => {
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <p className="muted">…</p>;
  const memUsed = s.memory.total - s.memory.free;
  const cards = [
    ['نسخه', 'v' + useStore.getState().config.version],
    ['کاربران', toFa(s.users)],
    ['آنلاین', toFa(s.online)],
    ['گروه و کانال', toFa(s.chats)],
    ['پیام‌ها', toFa(s.messages)],
    ['حجم فایل‌ها', formatSize(s.uploadsBytes)],
    ['حجم دیتابیس', formatSize(s.dbBytes)],
    ['دیسک آزاد', s.disk ? `${formatSize(s.disk.free)} از ${formatSize(s.disk.total)}` : '—'],
    ['رم سرور', `${formatSize(memUsed)} از ${formatSize(s.memory.total)}`],
    ['رم برنامه', formatSize(s.memory.process)],
    ['بار CPU', `${s.load.map((l) => l.toLocaleString('fa-IR', { maximumFractionDigits: 2 })).join(' / ')} (${toFa(s.cpus)} هسته)`],
    ['مدت روشن بودن', `${toFa(Math.floor(s.uptime / 3600))} ساعت`],
    ['پردازش ویدیو (ffmpeg)', s.ffmpeg ? 'فعال' : 'نصب نیست'],
    ['گزارش‌های باز', toFa(s.openReports)],
  ];
  const diskLow = s.disk && s.disk.free / s.disk.total < 0.1;
  return (
    <>
      {diskLow && (
        <div className="error with-icon">
          <TriangleAlert size={18} /> فضای دیسک کمتر از ۱۰٪ است!
        </div>
      )}
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div key={label} className="stat">
            <small>{label}</small>
            <b>{value}</b>
          </div>
        ))}
      </div>
    </>
  );
}

export function Users() {
  const me = useStore((s) => s.me);
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [data, load] = useLoad(`/admin/users?q=${encodeURIComponent(query)}`);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) showToast(ok);
      load();
      return r;
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <>
      <input placeholder="جستجوی کاربر…" value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="hint with-icon">
        <SlidersHorizontal size={15} /> روی هر کاربر بزنید تا نقش، حداکثر حجم آپلود، سهمیه، اجازه تماس و استریمش را تنظیم کنید.
      </p>
      <ul className="user-list">
        {data?.users.map((u) => (
          <li key={u.id} className="member">
            <button className="row-item" onClick={() => setOpen(open === u.id ? null : u.id)}>
              <Avatar id={u.id} name={u.displayName} file={u.avatar} size={38} online={u.online} />
              <span className="grow">
                <b>
                  {u.displayName} {u.banned && <span className="tag danger">مسدود</span>}
                  {u.locked && <span className="tag danger">قفل موقت</span>}
                  {u.twoFactor && <span className="tag">ورود دومرحله‌ای</span>}
                  {Object.keys(u.overrides || {}).length > 0 && <span className="tag">محدودیت سفارشی</span>}
                </b>
                <small dir="ltr">@{u.username}</small>
              </span>
              {u.role !== 'user' && <span className="role-badge">{ROLE_LABELS[u.role]}</span>}
            </button>
            {open === u.id && <UserActions u={u} me={me} run={run} />}
          </li>
        ))}
      </ul>
    </>
  );
}

export function UserActions({ u, me, run }) {
  const [perms, setPerms] = useState(u.adminPerms);
  const canManage = u.role === 'user' || (u.role === 'admin' && me.role === 'owner');
  const self = u.id === me.id;
  return (
    <div className="member-actions">
      <small className="muted">
        عضویت: {formatDateTime(u.createdAt)} · {u.online ? 'آنلاین' : formatLastSeen(u.lastSeen)}
      </small>
      {me.role === 'owner' && !self && (
        <div className="perm-box">
          <b>{u.role === 'admin' ? 'دسترسی‌های ادمین سرور' : 'ارتقا به ادمین سرور با دسترسی‌های:'}</b>
          {Object.entries(SITE_PERM_LABELS).map(([p, label]) => (
            <label key={p} className="check">
              <input type="checkbox" checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />
              {label}
            </label>
          ))}
          <div className="actions">
            <button className="btn primary sm" onClick={() => run(() => api('PATCH', `/admin/users/${u.id}`, { role: 'admin', adminPerms: perms }), 'ذخیره شد')}>
              {u.role === 'admin' ? 'ذخیره دسترسی‌ها' : 'ادمین کن'}
            </button>
            {u.role === 'admin' && (
              <button className="btn sm" onClick={() => run(() => api('PATCH', `/admin/users/${u.id}`, { role: 'user' }), 'برکنار شد')}>
                برکناری
              </button>
            )}
          </div>
        </div>
      )}
      {canManage && !self && u.role !== 'owner' && <LimitsEditor u={u} run={run} />}
      {u.role === 'owner' && (
        <div className="perm-box">
          <b>مالک سرور: بدون هیچ محدودیتی</b>
          <small className="muted">حجم فایل و فضای نامحدود، تماس مجاز، استریم تا 1080p و ۶۰ فریم (کیفیت را موقع شروع استریم انتخاب می‌کنید).</small>
        </div>
      )}
      {self && u.role === 'admin' && (
        <div className="perm-box">
          <b>محدودیت‌های شما</b>
          <small className="muted">
            فایل تا {u.limits?.uploadMb} مگابایت · تماس {u.limits?.canCall ? 'مجاز' : 'ممنوع'} · استریم {u.limits?.canStream ? `تا ${u.limits.streamQuality}p، ${u.limits.streamFps || 30} فریم` : 'ممنوع'} — فقط مالک سرور می‌تواند آن‌ها را تغییر دهد.
          </small>
        </div>
      )}
      {canManage && !self && (
        <div className="inline-form">
          <button
            className={`btn sm ${u.banned ? '' : 'danger'}`}
            onClick={() =>
              (u.banned || confirm(`${u.displayName} مسدود شود؟ فوراً از همه دستگاه‌ها خارج می‌شود.`)) &&
              run(() => api('POST', `/admin/users/${u.id}/ban`, { banned: !u.banned }), u.banned ? 'رفع مسدودیت شد' : 'مسدود شد')
            }
          >
            {u.banned ? 'رفع مسدودیت' : 'مسدود کردن'}
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              if (!confirm('رمز عبور این کاربر بازنشانی شود؟')) return;
              const r = await run(() => api('POST', `/admin/users/${u.id}/reset-password`));
              if (r) prompt('رمز جدید (برای کاربر بفرستید):', r.password);
            }}
          >
            بازنشانی رمز
          </button>
          <button
            className="btn sm"
            onClick={async () => {
              if (!confirm(`${u.displayName} از همهٔ دستگاه‌ها خارج شود؟`)) return;
              const r = await run(() => api('POST', `/admin/users/${u.id}/logout-all`));
              if (r) useStore.getState().showToast(`${toFa(r.loggedOut)} دستگاه خارج شد`);
            }}
          >
            خروج از همه دستگاه‌ها
          </button>
          {(u.twoFactor || u.locked) && (
            <button
              className="btn sm"
              onClick={() =>
                confirm('ورود دومرحله‌ای این کاربر خاموش و قفل حسابش باز شود؟ (برای وقتی که گوشی‌اش را گم کرده)') &&
                run(() => api('POST', `/admin/users/${u.id}/reset-2fa`), 'انجام شد')
              }
            >
              {u.twoFactor ? 'خاموش کردن ورود دومرحله‌ای' : 'باز کردن قفل'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
