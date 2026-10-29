import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, formatDateTime } from '../util';
import { ShieldAlert, Ban, BellRing } from 'lucide-react';

// Failed logins per IP, banned IPs (ban / unban), and the owner's security alerts.
export default function AdminSecurity() {
  const me = useStore((s) => s.me);
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  const [ip, setIp] = useState('');
  const [minutes, setMinutes] = useState('');
  const [reason, setReason] = useState('');
  const owner = me.role === 'owner';

  const load = () =>
    api('GET', '/admin/security')
      .then(setData)
      .catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <p className="muted">…</p>;

  const ban = async (target, extra = {}) => {
    try {
      await api('POST', '/admin/security/bans', { ip: target, ...extra });
      showToast(`${target} بن شد`);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const unban = async (target) => {
    try {
      await api('DELETE', `/admin/security/bans/${encodeURIComponent(target)}`);
      showToast(`بن ${target} برداشته شد`);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const save = async (patch) => {
    try {
      setData({ ...data, settings: (await api('PATCH', '/admin/security', patch)).settings });
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  };
  const s = data.settings;

  return (
    <div className="admin-security">
      <div className="boxed">
        <h4 className="with-icon">
          <ShieldAlert size={16} /> تلاش‌های ناموفق ورود (۷ روز اخیر)
        </h4>
        <p className="hint">آی‌پی شما: <span dir="ltr">{data.myIp || '—'}</span></p>
        <ul className="user-list sec-failures">
          {data.failures.map((f) => (
            <li key={f.ip} className="row-item">
              <span className="grow">
                <b dir="ltr">{f.ip}</b> <span className="tag danger">{toFa(f.count)} بار</span>
                {f.banned && <span className="tag">بن شده</span>}
                <br />
                <small className="muted">
                  آخرین: {formatDateTime(f.last)}
                  {f.usernames.length ? ` · نام‌ها: ${f.usernames.join('، ')}` : ''}
                </small>
              </span>
              {f.banned ? (
                <button className="btn sm" onClick={() => unban(f.ip)}>
                  برداشتن بن
                </button>
              ) : (
                <button className="btn sm danger" disabled={f.ip === data.myIp} onClick={() => ban(f.ip, { reason: `${f.count} تلاش ناموفق` })}>
                  <Ban size={14} /> بن
                </button>
              )}
            </li>
          ))}
          {!data.failures.length && <li className="muted">تلاش ناموفقی ثبت نشده است.</li>}
        </ul>
      </div>

      <div className="boxed" style={{ marginTop: 16 }}>
        <h4 className="with-icon">
          <Ban size={16} /> آی‌پی‌های بن‌شده
        </h4>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            ban(ip.trim(), { minutes: minutes === '' ? 0 : Number(minutes), reason }).then(() => {
              setIp('');
              setReason('');
            });
          }}
        >
          <input dir="ltr" placeholder="1.2.3.4" value={ip} onChange={(e) => setIp(e.target.value)} style={{ width: 150 }} />
          <input type="number" min={0} dir="ltr" placeholder="دقیقه (خالی = دائم)" value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 150 }} />
          <input placeholder="دلیل (اختیاری)" value={reason} onChange={(e) => setReason(e.target.value)} className="grow" />
          <button className="btn sm danger" disabled={!ip.trim()}>
            بن
          </button>
        </form>
        <ul className="user-list sec-bans">
          {data.bans.map((b) => (
            <li key={b.ip} className="row-item">
              <span className="grow">
                <b dir="ltr">{b.ip}</b>
                <br />
                <small className="muted">
                  {b.by} · {formatDateTime(b.createdAt)} · {b.expiresAt ? `تا ${formatDateTime(b.expiresAt)}` : 'دائم'}
                  {b.reason ? ` · ${b.reason}` : ''}
                </small>
              </span>
              <button className="btn sm" onClick={() => unban(b.ip)}>
                برداشتن بن
              </button>
            </li>
          ))}
          {!data.bans.length && <li className="muted">آی‌پی بن‌شده‌ای نیست.</li>}
        </ul>
      </div>

      {owner && (
        <div className="boxed" style={{ marginTop: 16 }}>
          <h4 className="with-icon">
            <BellRing size={16} /> هشدارهای امنیتی (برای مالک)
          </h4>
          <label className="check">
            <input type="checkbox" checked={s.alerts} onChange={(e) => save({ alerts: e.target.checked })} />
            هشدار در «پیام‌های ذخیره‌شده»: تلاش‌های ناموفق زیاد از یک آی‌پی، ورود مدیر از آی‌پی جدید، تغییر نقش و دسترسی، قفل شدن حساب، بازنشانی رمز توسط مدیر
          </label>
          <div className="inline-form">
            <label className="inline-form">
              حمله یعنی
              <input
                type="number"
                min={3}
                max={1000}
                dir="ltr"
                style={{ width: 72 }}
                defaultValue={s.threshold}
                key={`t-${s.threshold}`}
                onBlur={(e) => Number(e.target.value) !== s.threshold && save({ threshold: Math.round(Number(e.target.value)) })}
              />
              رمز اشتباه از یک آی‌پی در ۱۵ دقیقه
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.autoBan} onChange={(e) => save({ autoBan: e.target.checked })} />
            چنین آی‌پی‌ای خودکار بن شود
          </label>
          {s.autoBan && (
            <label className="inline-form">
              مدت بن خودکار
              <input
                type="number"
                min={0}
                dir="ltr"
                style={{ width: 90 }}
                defaultValue={s.autoBanMinutes}
                key={`m-${s.autoBanMinutes}`}
                onBlur={(e) => Number(e.target.value) !== s.autoBanMinutes && save({ autoBanMinutes: Math.round(Number(e.target.value)) || 0 })}
              />
              دقیقه (۰ = تا وقتی دستی برداشته شود)
            </label>
          )}
          <div>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                api('POST', '/admin/security/test', {})
                  .then(() => showToast('پیام آزمایشی در «پیام‌های ذخیره‌شده» فرستاده شد'))
                  .catch((e) => showToast(e.message))
              }
            >
              <BellRing size={14} /> ارسال پیام آزمایشی
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
