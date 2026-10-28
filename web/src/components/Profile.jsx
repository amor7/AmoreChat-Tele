import { useEffect, useRef, useState } from 'react';
import { api, upload } from '../api';
import { useStore } from '../store';
import { APP_VERSION } from '../update';
import { Camera, Bell, RefreshCw } from 'lucide-react';
import { compressImage, formatSize, ROLE_LABELS, toFa } from '../util';
import { Modal } from './Modals';
import Avatar from './Avatar';
import Security from './Security';
import { AndroidSettings } from './AndroidApp';
import Appearance from './Appearance';

export default function Profile({ onClose }) {
  const me = useStore((s) => s.me);
  const showToast = useStore((s) => s.showToast);
  const [form, setForm] = useState({ displayName: me.displayName, bio: me.bio || '' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const [notif, setNotif] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const fileRef = useRef(null);
  const prefs = useStore((s) => s.prefs);
  const version = useStore((s) => s.config.version);
  const setPrefs = useStore((s) => s.setPrefs);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    api('GET', '/me/usage')
      .then(setUsage)
      .catch(() => {});
  }, []);

  async function save(body) {
    try {
      const { user } = await api('PATCH', '/me', body);
      useStore.setState({ me: user });
      showToast('ذخیره شد');
    } catch (e) {
      showToast(e.message);
    }
  }

  async function onAvatar(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { blob } = await compressImage(f, 512, 0.85);
      const file = await upload(blob, { name: 'avatar.jpg' });
      await save({ avatar: file.id });
    } catch (err) {
      showToast(err.message);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    try {
      const { loggedOut } = await api('POST', '/auth/password', pw);
      setPw({ current: '', next: '' });
      showToast(loggedOut ? `رمز عوض شد و ${toFa(loggedOut)} دستگاه دیگر خارج شد` : 'رمز عبور تغییر کرد');
    } catch (err) {
      showToast(err.message);
    }
  }

  return (
    <Modal title="پروفایل و تنظیمات" onClose={onClose}>
      <div className="profile-head">
        <button className="avatar-edit" onClick={() => fileRef.current.click()} aria-label="تغییر عکس">
          <Avatar id={me.id} name={me.displayName} file={me.avatar} size={80} />
          <span>
            <Camera size={15} />
          </span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAvatar} />
        <div>
          <b>{me.displayName}</b>
          <div className="muted" dir="ltr">
            @{me.username}
          </div>
          <span className="role-badge">{ROLE_LABELS[me.role]}</span>
        </div>
      </div>

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save(form);
        }}
      >
        <label>
          نام نمایشی
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={64} required />
        </label>
        <label>
          درباره من
          <textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={300} rows={2} />
        </label>
        <button className="btn primary">ذخیره</button>
      </form>

      <Appearance />

      <h4>مصرف اینترنت</h4>
      <label className="check">
        <input type="checkbox" checked={prefs.dataSaver} onChange={(e) => setPrefs({ dataSaver: e.target.checked })} />
        حالت کم‌مصرف: عکس‌ها فقط با لمس بارگذاری شوند و ویدیوها با کمترین کیفیت پخش شوند
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.autoSaver !== false} onChange={(e) => setPrefs({ autoSaver: e.target.checked })} />
        وقتی اینترنت ضعیف است، حالت کم‌مصرف خودکار روشن شود (و کیفیت تصویر تماس پایین بیاید)
      </label>
      {usage && (
        <p className="muted">
          فضای استفاده‌شده توسط شما: {formatSize(usage.usedBytes)}
          {usage.quotaMb > 0 && ` از ${formatSize(usage.quotaMb * 1024 * 1024)}`}
        </p>
      )}

      <h4>اعلان‌ها</h4>
      {notif === 'granted' && <p className="muted">اعلان‌ها فعال هستند (وقتی برنامه باز یا در پس‌زمینه است).</p>}
      {notif === 'default' && (
        <button className="btn" onClick={async () => setNotif(await Notification.requestPermission())}>
          <Bell size={17} /> فعال کردن اعلان‌ها
        </button>
      )}
      {notif === 'denied' && <p className="muted">اعلان‌ها در تنظیمات مرورگر مسدود شده‌اند.</p>}
      {notif === 'unsupported' && <p className="muted">این مرورگر از اعلان پشتیبانی نمی‌کند. برنامه را نصب کنید (افزودن به صفحه اصلی).</p>}

      <AndroidSettings />

      <Security />

      <h5>تغییر رمز عبور</h5>
      <p className="muted tiny">بعد از تغییر رمز، همهٔ دستگاه‌های دیگر خارج می‌شوند.</p>
      <form className="form" onSubmit={changePassword}>
        <input type="password" placeholder="رمز فعلی" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required dir="ltr" autoComplete="current-password" />
        <input type="password" placeholder="رمز جدید (حداقل ۸ کاراکتر، ساده نباشد)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={8} dir="ltr" autoComplete="new-password" />
        <button className="btn">تغییر رمز</button>
      </form>
      <p className="muted center version" dir="ltr">
        AmoreChat app v{APP_VERSION} · server v{version}
      </p>
      {APP_VERSION !== version && (
        <button className="btn wide" onClick={() => location.reload()}>
          <RefreshCw size={17} /> نسخه برنامه با سرور فرق دارد؛ به‌روزرسانی
        </button>
      )}
    </Modal>
  );
}
