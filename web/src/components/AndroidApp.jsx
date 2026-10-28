import { useEffect, useState } from 'react';
import { Smartphone, X, Sparkles, BatteryCharging, Bell, Server, Download, FileText, PhoneCall, Wifi, WifiOff, Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { postBlockReason, formatSize, faDigits } from '../util';
import { isAndroidApp, isAndroidBrowser, appInfo, setBackgroundConnection, openBatterySettings, openNotificationSettings, openFullScreenSettings, changeServer, installAppUpdate, multiServer, appServers, addServer, removeServer, appLockSupported, appLockOn, setAppLock } from '../native';
import { Modal } from './Modals';
import Avatar from './Avatar';

// ---------- "Share to AmoreChat" from the gallery or another app: pick the chat ----------
export function ShareTarget({ files, text, onClose }) {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const [q, setQ] = useState('');
  const list = Object.values(chats)
    .filter((c) => !postBlockReason(me, c))
    .filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.type === 'saved' ? -1 : b.type === 'saved' ? 1 : (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0)));

  const pick = (c) => {
    useStore.setState({ pendingShare: { chatId: c.id, files, text } });
    onClose();
    location.hash = `#/chat/${c.id}`;
  };

  return (
    <Modal title="ارسال به…" onClose={onClose}>
      <div className="share-preview">
        {files.map((f, i) => (
          <span key={i} className="share-file">
            <FileText size={16} /> {f.name} <small>{formatSize(f.size)}</small>
          </span>
        ))}
        {!files.length && text && <span className="share-file">{text.slice(0, 120)}</span>}
        {files.length > 1 && <p className="hint">فعلاً فقط فایل اول ارسال می‌شود.</p>}
      </div>
      <input placeholder="جستجوی گفتگو" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="user-list">
        {list.map((c) => (
          <li key={c.id}>
            <button className="row-item" onClick={() => pick(c)}>
              <Avatar id={c.id} name={c.title} file={c.avatar} saved={c.type === 'saved'} size={36} />
              <span className="grow">{c.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

// ---------- Profile section ----------
export function AndroidSettings() {
  useStore((s) => s.nativeTick);
  const [info, setInfo] = useState(() => appInfo());
  const [server, setServer] = useState(null);
  const refresh = () => setInfo(appInfo());

  useEffect(() => {
    api('GET', '/app/android')
      .then((r) => setServer(r.apk))
      .catch(() => {});
    // Coming back from the system settings screens.
    const onVis = () => !document.hidden && refresh();
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(refresh, 3000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, []);

  if (isAndroidBrowser) {
    return (
      <>
        <h4>اپ اندروید</h4>
        <a className="btn wide" href="/app">
          <Smartphone size={17} /> دانلود اپ اندروید (اعلان بدون نیاز به گوگل)
        </a>
      </>
    );
  }
  if (!isAndroidApp || !info) return null;
  const outdated = server && server.versionCode > info.versionCode;

  return (
    <>
      <h4>اپ اندروید</h4>
      {outdated && (
        <button className="btn primary wide" onClick={startAppUpdate}>
          <Download size={17} /> نسخه جدید اپ ({faDigits(server.version)}، {formatSize(server.size)}) — دانلود و نصب
        </button>
      )}
      {outdated && server.notes?.length > 0 && (
        <button className="btn wide" onClick={() => useStore.getState().openModal('appUpdate')}>
          <Sparkles size={17} /> چه چیزهایی تازه است؟
        </button>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={info.background}
          onChange={(e) => {
            setBackgroundConnection(e.target.checked);
            setTimeout(refresh, 300);
          }}
        />
        اتصال پس‌زمینه برای اعلان پیام و تماس وقتی برنامه بسته است (بدون سرویس گوگل؛ کمی باتری مصرف می‌کند)
      </label>
      {info.background && (
        <p className={`app-status ${info.connected ? 'ok' : 'bad'}`}>
          {info.connected ? <Wifi size={16} /> : <WifiOff size={16} />} اتصال اعلان‌ها: {info.status}
        </p>
      )}
      {info.fullScreen === false && (
        <button className="btn wide" onClick={openFullScreenSettings}>
          <PhoneCall size={17} /> اجازه نمایش تماس ورودی روی صفحه را بدهید
        </button>
      )}
      {!info.notifications && (
        <button className="btn wide" onClick={openNotificationSettings}>
          <Bell size={17} /> اعلان‌ها خاموش است؛ روشن کنید
        </button>
      )}
      {info.background && !info.batteryUnrestricted && (
        <button className="btn wide" onClick={openBatterySettings}>
          <BatteryCharging size={17} /> برای اعلان مطمئن: محدودیت باتری را برای اپ بردارید
        </button>
      )}
      {appLockSupported && (
        <label className="check">
          <input type="checkbox" checked={appLockOn()} onChange={(e) => setAppLock(e.target.checked)} />
          <Lock size={15} /> قفل برنامه با اثر انگشت / چهره / رمز گوشی (بعد از ۱ دقیقه بیرون بودن؛ محتوا در لیست برنامه‌های اخیر هم پنهان می‌شود)
        </label>
      )}
      {multiServer ? (
        <>
          <h5>سرورها</h5>
          <p className="muted tiny">روی چند سرور AmoreChat هم‌زمان وارد باشید؛ پیام و تماس همه می‌آید. جابه‌جایی از منوی بالای لیست گفتگوها.</p>
          <ul className="server-list">
            {appServers().map((s) => (
              <li key={s.url}>
                <Server size={16} />
                <span className="grow" dir="ltr">
                  {s.name}
                </span>
                <small className={s.connected ? 'ok' : 'bad'}>{s.connected ? 'متصل' : s.status || '…'}</small>
                <button className="icon-btn" aria-label="خروج کامل از این سرور" title="خروج کامل از این سرور" onClick={() => confirm(`از «${s.name}» کامل خارج شوید؟
ورود شما، پیام‌های ذخیره‌شده روی این گوشی و اعلان‌های این سرور پاک می‌شود.`) && removeServer(s.url)}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn wide" onClick={addServer}>
            <Plus size={17} /> افزودن سرور دیگر
          </button>
        </>
      ) : (
        <button className="btn wide" onClick={() => confirm('از این سرور خارج شوید و آدرس دیگری وارد کنید؟') && changeServer()}>
          <Server size={17} /> تغییر سرور
        </button>
      )}
      <p className="muted tiny">
        اگر بعد از بستن برنامه اعلان نمی‌آید: در تنظیمات گوشی برای AmoreChat «اجرای خودکار / Autostart» را روشن و محدودیت باتری را «بدون محدودیت» کنید (مخصوصاً شیائومی، سامسونگ و هوآوی). «توقف اجباری» (Force stop) برنامه را تا باز کردن دوباره کاملاً متوقف می‌کند.
      </p>
      <p className="muted tiny" dir="ltr">
        Android app v{info.version} · {info.server}
      </p>
    </>
  );
}

// ---------- In-app update (like Telegram): a bar under the chat list ----------
// Checks the server for a newer APK at start and when the app comes back (at most hourly).
export function useAppUpdateCheck() {
  useEffect(() => {
    if (!isAndroidApp) return;
    let last = 0;
    const check = () => {
      if (document.hidden || Date.now() - last < 3600_000) return;
      last = Date.now();
      const info = appInfo();
      api('GET', '/app/android')
        .then((r) => useStore.setState({ appUpdate: r.apk && info && r.apk.versionCode > info.versionCode ? { ...r.apk, installed: info.versionCode } : null }))
        .catch(() => {});
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);
}

// Apps before v0.8.6 don't report progress: after a while the bar points to the phone's
// notification instead of spinning forever.
function startAppUpdate() {
  useStore.setState({ appUpdateState: { state: 'progress', percent: -1, local: true } });
  installAppUpdate();
  setTimeout(() => useStore.getState().appUpdateState?.local && useStore.setState({ appUpdateState: { state: 'started' } }), 8000);
}

const DISMISS_KEY = 'amore-update-dismissed';
const DISMISS_FOR = 3 * 24 * 3600_000; // closed: comes back after 3 days, or right away for a newer version
function dismissedFor(version) {
  try {
    const d = JSON.parse(localStorage.getItem(DISMISS_KEY) || 'null');
    return d?.version === version && d.until > Date.now();
  } catch {
    return false;
  }
}

export function UpdateBar() {
  const upd = useStore((s) => s.appUpdate);
  const st = useStore((s) => s.appUpdateState);
  const [hidden, setHidden] = useState(false);
  if (!upd || hidden || (dismissedFor(upd.version) && !st)) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify({ version: upd.version, until: Date.now() + DISMISS_FOR }));
    } catch {
      /* closes for now only */
    }
    setHidden(true);
  };
  const start = () => {
    startAppUpdate();
  };
  const busy = st?.state === 'progress';
  const pct = st?.percent >= 0 ? st.percent : null;
  let line;
  if (st?.state === 'progress') line = pct != null ? `در حال دانلود… ${faDigits(pct)}٪` : 'در حال دانلود…';
  else if (st?.state === 'install') line = 'دانلود شد؛ در پنجره نصب «نصب» را بزنید';
  else if (st?.state === 'started') line = 'دانلود در نوار اعلان گوشی ادامه دارد';
  else if (st?.state === 'failed') line = 'دانلود ناموفق بود';
  else if (st?.state === 'permission') line = 'اجازه «نصب برنامه‌ها» را بدهید و دوباره بزنید';
  else line = formatSize(upd.size);

  return (
    <div className="update-bar" role="status">
      <button className="update-main" onClick={() => !busy && start()} disabled={busy}>
        <Download size={20} />
        <span className="grow">
          <b>نسخه جدید {faDigits(upd.version)}</b>
          <small>{line}</small>
        </span>
        {!busy && <span className="update-go">{st?.state === 'failed' || st?.state === 'permission' ? 'تلاش دوباره' : 'بروزرسانی'}</span>}
      </button>
      {upd.notes?.length > 0 && !busy && (
        <button className="icon-btn" aria-label="تغییرات" title="چه چیزهایی تازه است؟" onClick={() => useStore.getState().openModal('appUpdate')}>
          <Sparkles size={18} />
        </button>
      )}
      {!busy && (
        <button className="icon-btn" aria-label="بستن" onClick={dismiss}>
          <X size={18} />
        </button>
      )}
      {busy && <i className="update-progress" style={{ width: `${pct ?? 100}%` }} data-indeterminate={pct == null || undefined} />}
    </div>
  );
}

// "What's new" since the installed version.
export function AppUpdateNotes({ onClose }) {
  const upd = useStore((s) => s.appUpdate);
  const notes = (upd?.notes || []).filter((n) => !upd.installed || n.versionCode > upd.installed);
  return (
    <Modal title={`تازه‌های نسخه ${faDigits(upd?.version || '')}`} onClose={onClose} size="small">
      {notes.map((n) => (
        <section key={n.version} className="release-notes">
          <h5>نسخه {faDigits(n.version)}</h5>
          <ul>
            {n.items.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      ))}
      {!notes.length && <p className="muted">بهبودها و رفع اشکال‌ها.</p>}
      <div className="actions">
        <button
          className="btn primary"
          onClick={() => {
            onClose();
            startAppUpdate();
          }}
        >
          <Download size={17} /> دانلود و نصب
        </button>
      </div>
    </Modal>
  );
}
