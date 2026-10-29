import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { formatDateTime, messagePreview } from '../util';
import { EmojiImg } from './Emoji';
import { RtcSettings } from './AdminRtc';
import { useLoad } from './AdminPanelsA1';

export function Settings() {
  const showToast = useStore((s) => s.showToast);
  const [data] = useLoad('/admin/settings');
  const [f, setF] = useState(null);
  useEffect(() => {
    if (data) setF(data.settings);
  }, [data]);
  if (!f) return <p className="muted">…</p>;

  async function save(e) {
    e.preventDefault();
    try {
      const { settings } = await api('PATCH', '/admin/settings', f);
      setF(settings);
      useStore.setState((s) => ({
        config: { ...s.config, siteName: settings.site_name, registrationMode: settings.registration_mode, allowUserGroups: settings.allow_user_groups === '1' },
      }));
      showToast('تنظیمات ذخیره شد');
    } catch (err) {
      showToast(err.message);
    }
  }

  return (
    <form className="form" onSubmit={save}>
      <label>
        نام سرور
        <input value={f.site_name} onChange={(e) => setF({ ...f, site_name: e.target.value })} maxLength={50} />
      </label>
      <label>
        ثبت‌نام
        <select value={f.registration_mode} onChange={(e) => setF({ ...f, registration_mode: e.target.value })}>
          <option value="open">آزاد (هر کس لینک سرور را دارد)</option>
          <option value="invite">فقط با کد دعوت</option>
          <option value="closed">بسته</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={f.allow_user_groups === '1'} onChange={(e) => setF({ ...f, allow_user_groups: e.target.checked ? '1' : '0' })} />
        کاربران عادی بتوانند گروه و کانال بسازند
      </label>
      <label className="check">
        <input type="checkbox" checked={f.discover_list !== '0'} onChange={(e) => setF({ ...f, discover_list: e.target.checked ? '1' : '0' })} />
        «کاوش» فهرست کامل گروه‌ها و کانال‌های عمومی را نشان دهد (خاموش: فقط با جستجوی نام، حداقل ۳ حرف، یا لینک دعوت)
      </label>
      <label>
        حداکثر حجم هر فایل (مگابایت)
        <input type="number" min="1" value={f.max_upload_mb} onChange={(e) => setF({ ...f, max_upload_mb: e.target.value })} />
      </label>
      <label>
        سهمیه فضای هر کاربر (مگابایت، ۰ = نامحدود)
        <input type="number" min="0" value={f.user_quota_mb} onChange={(e) => setF({ ...f, user_quota_mb: e.target.value })} />
      </label>
      <label>
        حذف خودکار عکس، ویدیو و فایل‌های قدیمی‌تر از (روز، ۰ = هرگز)
        <input type="number" min="0" value={f.media_retention_days} onChange={(e) => setF({ ...f, media_retention_days: e.target.value })} />
      </label>
      <p className="hint">برای وقتی دیسک سرور کوچک است. پیام‌ها می‌مانند، فقط فایل‌هایشان حذف می‌شود. عکس پروفایل‌ها حذف نمی‌شوند.</p>
      <RtcSettings f={f} setF={setF} />
      <button className="btn primary">ذخیره تنظیمات</button>
    </form>
  );
}

export function Reports() {
  const showToast = useStore((s) => s.showToast);
  const [status, setStatus] = useState('open');
  const [data, load] = useLoad(`/admin/reports?status=${status}`);

  const act = (id, action) =>
    api('POST', `/admin/reports/${id}`, { action })
      .then(() => {
        showToast(action === 'delete' ? 'پیام حذف شد' : 'گزارش بسته شد');
        load();
      })
      .catch((e) => showToast(e.message));

  return (
    <>
      <div className="segmented">
        <button className={status === 'open' ? 'active' : ''} onClick={() => setStatus('open')}>
          باز
        </button>
        <button className={status === 'closed' ? 'active' : ''} onClick={() => setStatus('closed')}>
          بسته‌شده
        </button>
      </div>
      {data?.reports.length === 0 && (
        <p className="muted pad with-icon">
          گزارشی وجود ندارد <EmojiImg ch="🎉" size={22} />
        </p>
      )}
      <ul className="audit">
        {data?.reports.map((r) => (
          <li key={r.id} className="report">
            <small>{formatDateTime(r.createdAt)}</small>
            <b>{r.reporter}</b> پیامی از <b>{r.message?.sender?.displayName || '?'}</b> در «{r.chat.title}» را گزارش کرد
            {r.reason && <div className="report-reason">دلیل: {r.reason}</div>}
            <blockquote className="report-msg" dir="auto">
              {r.message?.type === 'deleted' ? <i>پیام حذف شده</i> : messagePreview(r.message)}
            </blockquote>
            {status === 'open' ? (
              <div className="inline-form">
                {r.message?.type !== 'deleted' && (
                  <button className="btn sm danger" onClick={() => act(r.id, 'delete')}>
                    حذف پیام
                  </button>
                )}
                <button className="btn sm" onClick={() => act(r.id, 'dismiss')}>
                  رد گزارش
                </button>
              </div>
            ) : (
              <span className="tag">{r.status === 'deleted' ? 'پیام حذف شد' : 'رد شد'}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

const ACTION_LABELS = {
  'user.register': 'ثبت‌نام',
  'user.role': 'تغییر نقش کاربر',
  'user.ban': 'مسدود کردن کاربر',
  'user.unban': 'رفع مسدودیت کاربر',
  'user.reset_password': 'بازنشانی رمز',
  'invite.create': 'ساخت کد دعوت',
  'invite.delete': 'حذف کد دعوت',
  'settings.update': 'تغییر تنظیمات',
  'chat.edit': 'ویرایش گفتگو',
  'chat.delete': 'حذف گفتگو',
  'chat.member_role': 'تغییر نقش عضو',
  'chat.mute': 'بی‌صدا کردن',
  'chat.kick': 'حذف عضو',
  'chat.ban': 'مسدود کردن عضو',
  'chat.unban': 'رفع مسدودیت عضو',
  'message.delete': 'حذف پیام دیگران',
  'report.delete': 'حذف پیام گزارش‌شده',
  'report.dismiss': 'رد گزارش',
};

export function Audit() {
  const [entries, setEntries] = useState([]);
  const [more, setMore] = useState(true);
  const load = async (before) => {
    const r = await api('GET', `/admin/audit${before ? `?before=${before}` : ''}`);
    setEntries((e) => (before ? [...e, ...r.entries] : r.entries));
    setMore(r.entries.length === 100);
  };
  useEffect(() => {
    load().catch(() => {});
  }, []);
  return (
    <>
      <ul className="audit">
        {entries.map((a) => (
          <li key={a.id}>
            <small>{formatDateTime(a.created_at)}</small>
            <b>{a.actor_name || 'سیستم'}</b> {ACTION_LABELS[a.action] || a.action}
            {a.target && <code dir="ltr"> #{a.target}</code>}
            {a.details && <div className="audit-details" dir="ltr">{a.details}</div>}
          </li>
        ))}
      </ul>
      {more && entries.length > 0 && (
        <button className="btn wide" onClick={() => load(entries[entries.length - 1].id)}>
          موارد بیشتر
        </button>
      )}
    </>
  );
}
