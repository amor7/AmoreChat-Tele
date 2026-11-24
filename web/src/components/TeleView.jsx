import { useEffect, useMemo, useRef, useState } from 'react';
import { TELE_LOCKED } from '../api';
import { useStore, useDataSaver } from '../store';
import { toFa } from '../util';
import { teleStatus, refreshDialogs, setDialogSelected, disconnectTele } from '../teleApi';
import { unreadSum } from '../tele-rules';
import { publishTeleStatus as publish } from '../useTeleEntry';
import { useDrafts } from '../useDrafts';
import { TeleLockScreen } from './TelePasscode';
import { useTeleLockEvent } from '../teleLockEvents';
import { HeaderMenu, MenuItem } from './Menu';
import { EmptyState } from './States';
import { confirmDialog } from '../confirm';
import TeleDialogList, { TeleFind, TeleStatus } from './TeleDialogList';
import TeleLogin from './TeleLogin';
import TeleChat from './TeleChat';
import { ArrowRight, ListPlus, LogOut, Plus, RefreshCw, ShieldCheck, Lock, Send, UserPlus } from 'lucide-react';

// Telegram, in the same look as the app's own chats: chat list on the side, the open chat beside it.
// Route: #/tele (list) and #/tele/<dialogId> (an open chat).
// Only the chats the user added are kept up to date: the whole Telegram chat list is fetched only
// while picking chats to add, to keep the server's VPN traffic low.
// Parts: TeleDialogList (side column), TeleChat (open chat) → TeleMessage, TeleLogin; requests
// in teleApi.js, pure rules in tele-rules.js.

const TABS = [
  ['all', 'همه'],
  ['private', 'خصوصی'],
  ['group', 'گروه‌ها'],
  ['channel', 'کانال‌ها'],
];
// Periodic checks pause while the tab is in the background (no traffic, and the idle timer runs).
const visible = () => document.visibilityState !== 'hidden';
// The sidebar's Telegram button reads the same answers (publish): no request of its own while
// this page is open.

export default function TeleView({ dialogId }) {
  const [status, setStatus] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [finding, setFinding] = useState(false);
  const phone = usePhoneLayout();
  const showToast = useStore((s) => s.showToast);
  const drafts = useDrafts(useStore((s) => s.me?.id || 0), 'tele');

  const [loadError, setLoadError] = useState('');
  const hasStatus = useRef(false);
  // poll: an automatic check (see teleApi POLL). A TELE_LOCKED (423) is no error to show: the lock screen takes over.
  const load = (poll = false) =>
    teleStatus(poll)
      .then((s) => {
        hasStatus.current = true;
        setLoadError('');
        setStatus(s);
        publish(s);
      })
      .catch((e) => {
        if (e.status === TELE_LOCKED) return;
        // Nothing on screen yet: say so in the list, with a retry, instead of loading forever.
        if (!hasStatus.current && !poll) setLoadError(e.message);
        else showToast(e.message);
      });
  // Passcode lock: whatever request heard it, drop everything shown (dialogs here; the open chat's
  // messages and its polls go with TeleChat, which is no longer rendered).
  useTeleLockEvent(
    () => {
      setStatus((s) => ({ access: true, locked: true, passcode: s?.passcode }));
      publish({ access: true, locked: true });
    },
    () => status?.locked && load(),
  );
  const locked = !!status?.locked;
  const account = status?.account;
  const connected = account?.status === 'connected';

  const syncList = async (all = false, poll = false) => {
    setSyncing(true);
    try {
      const r = await refreshDialogs(all, poll);
      if (r?.notice) showToast(r.notice);
      await load(poll);
    } catch (e) {
      if (e.status !== TELE_LOCKED) showToast(e.message);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line
  // Connected: the user's own chats from Telegram every minute, the stored list more often.
  // Data saver: a third as often. A phone with a chat open can't see the list: every 30 s is
  // enough there (the open chat polls its own messages).
  const dataSaver = useDataSaver();
  const slow = dataSaver ? 3 : 1;
  const listMs = (phone && dialogId ? 30000 : 10000) * slow;
  const syncMs = 60000 * slow;
  useEffect(() => {
    if (!connected) return;
    const fromTelegram = setInterval(() => visible() && syncList(false, true), syncMs);
    const stored = setInterval(() => visible() && load(true), listMs);
    return () => {
      clearInterval(fromTelegram);
      clearInterval(stored);
    };
  }, [connected, listMs, syncMs]); // eslint-disable-line

  const dialogs = status?.dialogs || [];
  const mine = useMemo(() => dialogs.filter((d) => d.selected), [dialogs]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = (picking ? dialogs : mine).filter((d) => (tab === 'all' || d.kind === tab) && (!q || `${d.title} ${d.username}`.toLowerCase().includes(q)));
    // While adding: the chats already added first, so they are easy to find (and to take out again).
    return picking ? [...shown.filter((d) => d.selected), ...shown.filter((d) => !d.selected)] : shown;
  }, [dialogs, mine, picking, query, tab]);
  // Unread messages, as on the sidebar's Telegram button (not the number of chats).
  const unreadOf = (kind) => unreadSum(mine, kind);
  const active = dialogs.find((d) => d.id === dialogId);

  if (locked) {
    // On a phone with no chat open only the side column shows; elsewhere the main pane does.
    const inSide = phone && !dialogId;
    // Unlocking (here or in a dialog) reloads through the unlock event above.
    // Quarantine (unreadable passcode carry file after a restore): no passcode can open it, so
    // show the server's message instead of a field that can only fail.
    const lockScreen = status?.quarantined ? (
      <div className="tele-lock" role="status">
        <p className="error">{status.message || 'بخش تلگرام موقتاً قفل است؛ با مدیر سرور تماس بگیرید'}</p>
      </div>
    ) : (
      <TeleLockScreen />
    );
    return (
      <>
        <aside className="sidebar tele-side">
          <header className="sidebar-head">
            <a className="icon-btn" href="#/" aria-label="بازگشت به پیام‌رسان" title="بازگشت به پیام‌رسان">
              <ArrowRight size={22} />
            </a>
            <b className="grow">تلگرام</b>
          </header>
          {inSide && lockScreen}
        </aside>
        <main className="chat-pane">{!inSide && lockScreen}</main>
      </>
    );
  }

  const startPicking = () => {
    setPicking(true);
    setFinding(false);
    setQuery('');
    syncList(true);
  };
  const stopPicking = () => {
    setPicking(false);
    setQuery('');
  };
  const toggle = async (d) => {
    try {
      await setDialogSelected(d.id, !d.selected);
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const remove = async (d) => {
    await toggle(d);
    location.hash = '#/tele';
  };

  const logout = async () => {
    // «خروج»: the user's own leaving, the same word as the menu item (DECISIONS.md vocabulary).
    if (!(await confirmDialog({ title: 'از حساب تلگرام خارج شوید؟', message: 'حساب تلگرام از این برنامه جدا می‌شود؛ برای دیدن گفتگوها باید دوباره وارد شوید.', confirmLabel: 'خروج', danger: true }))) return;
    try {
      await disconnectTele();
      location.hash = '#/tele';
      await load();
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <>
      <aside className="sidebar tele-side">
        <header className="sidebar-head">
          {/* While picking, «تمام» (at the end of this row) is the one way back to the list. */}
          {!picking && (
            <a className="icon-btn" href="#/" aria-label="بازگشت به پیام‌رسان" title="بازگشت به پیام‌رسان">
              <ArrowRight size={22} />
            </a>
          )}
          {connected ? (
            <input
              className="search grow"
              placeholder={picking ? 'جستجو در همه گفتگوهای تلگرام…' : 'جستجو در گفتگوهای من…'}
              aria-label={picking ? 'جستجو در همه گفتگوهای تلگرام' : 'جستجو در گفتگوهای من'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : (
            <b className="grow">تلگرام</b>
          )}
          {connected && !picking && (
            <>
              {/* One named «+» menu for both ways of adding a chat (was two bare icons). */}
              <HeaderMenu label="افزودن گفتگو" icon={<Plus size={21} />}>
                <MenuItem icon={<ListPlus size={17} />} onClick={startPicking}>
                  انتخاب از گفتگوهای تلگرام
                </MenuItem>
                {account?.allowExplore && (
                  <MenuItem icon={<UserPlus size={17} />} onClick={() => setFinding(true)}>
                    پیام به شخص یا عضویت در گروه و کانال
                  </MenuItem>
                )}
              </HeaderMenu>
              <HeaderMenu>
                <MenuItem icon={<RefreshCw size={17} />} disabled={syncing} onClick={() => syncList()}>
                  به‌روزرسانی فهرست
                </MenuItem>
                <MenuItem icon={<ShieldCheck size={17} />} aria-label="نشست‌های فعال تلگرام" onClick={() => useStore.getState().openModal('teleSessions')}>
                  دستگاه‌های فعال تلگرام
                </MenuItem>
                <MenuItem icon={<LogOut size={17} />} danger onClick={logout}>
                  خروج از حساب تلگرام
                </MenuItem>
              </HeaderMenu>
            </>
          )}
          {picking && (
            <button className="btn sm primary" onClick={stopPicking} title="تمام: پایان انتخاب گفتگوها">
              تمام
            </button>
          )}
        </header>
        {connected && (
          <div className="site-name tele-brand">
            {picking ? (
              <span>{toFa(mine.length)} گفتگو انتخاب شده؛ فقط این‌ها به‌روز می‌مانند</span>
            ) : (
              <>
                {account?.displayName && <b>{account.displayName}</b>}
                <TeleStatus status={status} />
              </>
            )}
          </div>
        )}
        {connected && finding && !picking && (
          <TeleFind
            onClose={() => setFinding(false)}
            onOpened={async (dialogId) => {
              setFinding(false);
              await load();
              if (dialogId) location.hash = `#/tele/${dialogId}`;
            }}
          />
        )}
        {connected && (
          <div className="folder-tabs" role="group" aria-label="دسته‌ها">
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? 'active' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>
                {label}
                {!picking && unreadOf(k) > 0 && <span className="tab-badge">{toFa(unreadOf(k))}</span>}
              </button>
            ))}
          </div>
        )}
        <TeleDialogList
          status={status}
          loadError={loadError}
          onRetry={() => load()}
          connected={connected}
          picking={picking}
          syncing={syncing}
          list={list}
          mine={mine}
          dialogId={dialogId}
          drafts={drafts}
          onToggle={toggle}
          // On phones only this column is visible until a chat is open, so the login lives here.
          login={
            phone ? (
              <li>
                <TeleLogin status={status} reload={load} />
              </li>
            ) : (
              <li className="muted center pad">بعد از اتصال، گفتگوهای شما اینجا می‌آیند.</li>
            )
          }
        />
      </aside>
      <main className="chat-pane">
        {!status ? null : status.access === false ? (
          <EmptyState
            icon={<Lock size={64} className="muted" />}
            title="تلگرام"
            hint="دسترسی شما به بخش تلگرام را مدیر بسته است. اگر فکر می‌کنید اشتباه شده، به مدیر خبر دهید."
          />
        ) : !connected ? (
          <TeleLogin status={status} reload={load} />
        ) : active ? (
          <TeleChat key={active.id} dialog={active} onChanged={load} onRemove={() => remove(active)} allowMedia={!!account?.allowMedia} allowVoice={!!account?.allowVoice} allowFiles={!!account?.allowFiles} allowExplore={!!account?.allowExplore} mediaMaxMb={status?.mediaMaxMb || 5} fileMaxMb={status?.fileMaxMb || 20} />
        ) : mine.length ? (
          <EmptyState
            icon={
              <span className="tele-logo">
                <Send size={34} />
              </span>
            }
            title="یک گفتگو را انتخاب کنید"
            hint="گفتگوی تازه می‌خواهید؟ از دکمه‌ی «+» (افزودن گفتگو) بالای فهرست اضافه کنید."
          />
        ) : (
          <EmptyState
            icon={
              <span className="tele-logo">
                <Send size={34} />
              </span>
            }
            title="گفتگوهایتان را انتخاب کنید"
            hint="فقط گفتگوهایی که انتخاب می‌کنید به‌روز می‌مانند تا اینترنت کمتری مصرف شود."
            action={
              <button className="btn primary" onClick={startPicking}>
                <Plus size={16} /> انتخاب گفتگو
              </button>
            }
          />
        )}
      </main>
    </>
  );
}

// Phone layout (one column), the same breakpoint as the app's CSS.
const PHONE_QUERY = '(max-width: 767px)';
function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_QUERY);
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
