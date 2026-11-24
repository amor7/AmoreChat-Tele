import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, teleUpload, teleDownload, TELE_LOCKED } from '../api';
import { useStore, useDataSaver, dataSaverNow } from '../store';
import { colorFor, formatDay, formatListTime, formatTime, sameDay, toFa, faDigits, compressImage, formatSize } from '../util';
import Avatar from './Avatar';
import { loadDraft } from '../drafts';
import { useDrafts, useDraftSaver, draftPreview } from '../useDrafts';
import { TeleLockScreen, useTeleLockEvent } from './TelePasscode';
import { ArrowRight, Check, LogOut, Megaphone, Plus, RefreshCw, Search, SendHorizontal, Users, X, CircleMinus, Reply, ImagePlus, Mic, Play, Forward, Trash2, ShieldCheck, Paperclip, FileText, Film, Download, UserPlus, Lock, MessageSquare, DoorOpen, MoreVertical, Send, TriangleAlert } from 'lucide-react';

// Telegram, in the same look as the app's own chats: chat list on the side, the open chat beside it.
// Route: #/tele (list) and #/tele/<dialogId> (an open chat).
// Only the chats the user added are kept up to date: the whole Telegram chat list is fetched only
// while picking chats to add, to keep the server's VPN traffic low.

const KIND_ICON = { group: Users, channel: Megaphone };
const TABS = [
  ['all', 'همه'],
  ['private', 'خصوصی'],
  ['group', 'گروه‌ها'],
  ['channel', 'کانال‌ها'],
];
// Avatar colors need a number: Telegram ids (and "u123" / "c-100…" sender ids) give a stable one.
const num = (id) => Math.abs(Number(String(id || '').replace(/^[uc]/, '')) || 0);
const mb = (n) => `${toFa((n / 1048576).toFixed(n < 10485760 ? 1 : 0))} MB`;
// Periodic checks pause while the tab is in the background (no traffic, and the idle timer runs).
const visible = () => document.visibilityState !== 'hidden';
// Marks the automatic checks: they must not keep the Telegram passcode lock from timing out.
const POLL = { headers: { 'x-amore-poll': '1' } };

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

  // poll: an automatic check (see POLL). A TELE_LOCKED (423) is no error to show: the lock screen takes over.
  const load = (poll = false) =>
    api('GET', '/tele/status', undefined, poll ? POLL : undefined)
      .then(setStatus)
      .catch((e) => e.status !== TELE_LOCKED && showToast(e.message));
  // Passcode lock: whatever request heard it, drop everything shown (dialogs here; the open chat's
  // messages and its polls go with TeleChat, which is no longer rendered).
  useTeleLockEvent(
    () => setStatus((s) => ({ access: true, locked: true, passcode: s?.passcode })),
    () => status?.locked && load(),
  );
  const locked = !!status?.locked;
  const account = status?.account;
  const connected = account?.status === 'connected';

  const syncList = async (all = false, poll = false) => {
    setSyncing(true);
    try {
      const r = await api('POST', '/tele/dialogs/refresh', { all }, poll ? POLL : undefined);
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
  useEffect(() => {
    if (!connected) return;
    const fromTelegram = setInterval(() => visible() && syncList(false, true), 60000);
    const stored = setInterval(() => visible() && load(true), 10000);
    return () => {
      clearInterval(fromTelegram);
      clearInterval(stored);
    };
  }, [connected]); // eslint-disable-line

  const dialogs = status?.dialogs || [];
  const mine = useMemo(() => dialogs.filter((d) => d.selected), [dialogs]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = (picking ? dialogs : mine).filter((d) => (tab === 'all' || d.kind === tab) && (!q || `${d.title} ${d.username}`.toLowerCase().includes(q)));
    // While adding: the chats already added first, so they are easy to find (and to take out again).
    return picking ? [...shown.filter((d) => d.selected), ...shown.filter((d) => !d.selected)] : shown;
  }, [dialogs, mine, picking, query, tab]);
  const unreadOf = (kind) => mine.filter((d) => (kind === 'all' || d.kind === kind) && d.unread > 0).length;
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
    setQuery('');
    syncList(true);
  };
  const stopPicking = () => {
    setPicking(false);
    setQuery('');
  };
  const toggle = async (d) => {
    try {
      await api('PATCH', `/tele/dialogs/${d.id}`, { selected: !d.selected });
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
    if (!confirm('اتصال حساب تلگرام قطع شود؟')) return;
    try {
      await api('POST', '/tele/disconnect');
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
          {picking ? (
            <button className="icon-btn" aria-label="پایان انتخاب" title="پایان انتخاب" onClick={stopPicking}>
              <ArrowRight size={22} />
            </button>
          ) : (
            <a className="icon-btn" href="#/" aria-label="بازگشت به پیام‌رسان" title="بازگشت به پیام‌رسان">
              <ArrowRight size={22} />
            </a>
          )}
          {connected ? (
            <input className="search grow" placeholder={picking ? 'جستجو در همه گفتگوهای تلگرام…' : 'جستجو در گفتگوهای من…'} value={query} onChange={(e) => setQuery(e.target.value)} />
          ) : (
            <b className="grow">تلگرام</b>
          )}
          {connected && !picking && (
            <>
              {account?.allowExplore && (
                <button className={`icon-btn ${finding ? 'active' : ''}`} aria-label="پیام به کسی / عضویت در کانال" title="پیام به هر کس (‎@نام‌کاربری یا شماره)، جستجو و عضویت در گروه و کانال" onClick={() => setFinding((v) => !v)}>
                  <UserPlus size={20} />
                </button>
              )}
              <button className="icon-btn" aria-label="افزودن گفتگو" title="افزودن گفتگو" onClick={startPicking}>
                <Plus size={21} />
              </button>
              <TeleMore>
                <button role="menuitem" disabled={syncing} onClick={() => syncList()}>
                  <RefreshCw size={17} /> به‌روزرسانی فهرست
                </button>
                <button role="menuitem" aria-label="نشست‌های فعال تلگرام" onClick={() => useStore.getState().openModal('teleSessions')}>
                  <ShieldCheck size={17} /> دستگاه‌های فعال تلگرام
                </button>
                <button role="menuitem" className="danger" onClick={logout}>
                  <LogOut size={17} /> خروج از حساب تلگرام
                </button>
              </TeleMore>
            </>
          )}
          {picking && (
            <button className="btn sm primary" onClick={stopPicking}>
              تمام
            </button>
          )}
        </header>
        {connected && (
          <div className="site-name tele-brand">
            {picking ? (
              <span>{toFa(mine.length)} گفتگو انتخاب شده · فقط این‌ها به‌روز می‌مانند</span>
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
            onOpened={async (dialogId) => {
              setFinding(false);
              await load();
              if (dialogId) location.hash = `#/tele/${dialogId}`;
            }}
          />
        )}
        {connected && (
          <div className="folder-tabs">
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {label}
                {!picking && unreadOf(k) > 0 && <span className="tab-badge">{toFa(unreadOf(k))}</span>}
              </button>
            ))}
          </div>
        )}
        <ul className="chat-list">
          {!status && <li className="muted center pad">در حال بارگذاری…</li>}
          {status?.access === false && <li className="muted center pad">دسترسی شما به تلگرام بسته است.</li>}
          {/* On phones only this column is visible until a chat is open, so the login lives here. */}
          {status && status.access !== false && !connected && (phone ? <li><TeleLogin status={status} reload={load} /></li> : <li className="muted center pad">بعد از اتصال، گفتگوهای شما اینجا می‌آیند.</li>)}
          {connected &&
            list.map((d) =>
              picking ? (
                <li key={d.id}>
                  <button className={`chat-item tele-pick ${d.selected ? 'active' : ''}`} onClick={() => toggle(d)} aria-pressed={d.selected}>
                    <DialogBody d={d} />
                    <span className={`tele-check ${d.selected ? 'on' : ''}`}>{d.selected ? <Check size={16} /> : <Plus size={16} />}</span>
                  </button>
                </li>
              ) : (
                <li key={d.id}>
                  <a href={`#/tele/${d.id}`} className={`chat-item ${d.id === dialogId ? 'active' : ''}`}>
                    <DialogBody d={d} withUnread draft={d.id !== dialogId && drafts[d.id]} />
                  </a>
                </li>
              ),
            )}
          {connected && !list.length && (
            <li className="muted center pad">
              {picking ? (
                syncing ? 'در حال دریافت گفتگوها از تلگرام…' : 'گفتگویی پیدا نشد'
              ) : mine.length ? (
                'گفتگویی پیدا نشد'
              ) : (
                'هنوز گفتگویی انتخاب نکرده‌اید.'
              )}
            </li>
          )}
        </ul>
      </aside>
      <main className="chat-pane">
        {!status ? null : status.access === false ? (
          <div className="empty-pane">
            <Lock size={64} className="muted" />
            <h2>تلگرام</h2>
            <p>دسترسی شما به بخش تلگرام را مدیر بسته است. اگر فکر می‌کنید اشتباه شده، به مدیر خبر دهید.</p>
          </div>
        ) : !connected ? (
          <TeleLogin status={status} reload={load} />
        ) : active ? (
          <TeleChat key={active.id} dialog={active} onChanged={load} onRemove={() => remove(active)} allowMedia={!!account?.allowMedia} allowVoice={!!account?.allowVoice} allowFiles={!!account?.allowFiles} allowExplore={!!account?.allowExplore} mediaMaxMb={status?.mediaMaxMb || 5} fileMaxMb={status?.fileMaxMb || 20} />
        ) : (
          <div className="empty-pane">
            <span className="tele-logo">
              <Send size={34} />
            </span>
            {mine.length ? (
              <>
                <h2>یک گفتگو را انتخاب کنید</h2>
                <p>گفتگوی تازه می‌خواهید؟ با دکمه + از فهرست تلگرامتان اضافه کنید.</p>
              </>
            ) : (
              <>
                <h2>گفتگوهایتان را انتخاب کنید</h2>
                <p>فقط گفتگوهایی که انتخاب می‌کنید به‌روز می‌مانند تا اینترنت کمتری مصرف شود.</p>
                <button className="btn primary" onClick={startPicking}>
                  <Plus size={16} /> انتخاب گفتگو
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </>
  );
}

function DialogBody({ d, withUnread, draft }) {
  const Icon = KIND_ICON[d.kind];
  return (
    <>
      <Avatar id={num(d.tgChatId)} name={d.title} />
      <div className="chat-item-body">
        <div className="row">
          <span className="title">
            {Icon && <Icon size={15} className="type-icon" />}
            {d.title || d.username || 'بدون نام'}
          </span>
          {d.lastAt && <span className="time">{formatListTime(d.lastAt)}</span>}
        </div>
        <div className="row">
          {draft ? (
            <span className="preview">
              <span className="draft-label">پیش‌نویس: </span>
              {draftPreview(draft)}
            </span>
          ) : (
            <span className="preview">
              {d.lastOut && d.lastText ? 'شما: ' : ''}
              {(d.lastText || '').split('\n')[0]}
            </span>
          )}
          {withUnread && d.unread > 0 && <span className="badge">{toFa(d.unread)}</span>}
        </div>
      </div>
    </>
  );
}

// Message anyone (@username or phone), find a bot, a public group or channel (by @username, t.me
// link, invite link or name) and join it. Each search goes through the server's VPN.
const KIND_NAME = { private: 'شخص', group: 'گروه', channel: 'کانال' };
function TeleFind({ onOpened }) {
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const find = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      setResults((await api('GET', `/tele/find?q=${encodeURIComponent(q.trim())}`, undefined, { timeout: 60000 })).results);
    } catch (err) {
      setResults([]);
      showToast(err.message);
    }
    setBusy(false);
  };
  const act = async (path, body) => {
    setBusy(true);
    try {
      const r = await api('POST', path, body, { timeout: 60000 });
      if (r.notice) showToast(r.notice);
      await onOpened(r.dialogId);
    } catch (err) {
      showToast(err.message);
    }
    setBusy(false);
  };
  return (
    <div className="tele-find">
      <form className="inline-form" onSubmit={find}>
        <input className="search grow" autoFocus dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder="‎@نام‌کاربری، شماره، لینک t.me یا نام کانال…" />
        <button className="btn sm primary" disabled={busy || q.trim().length < 2}>
          {busy ? '…' : 'جستجو'}
        </button>
      </form>
      {results && (
        <ul className="chat-list tele-find-list">
          {results.map((c) => {
            const canOpen = c.kind === 'private' || c.joined;
            return (
              <li key={c.tgChatId || c.invite} className="chat-item">
                <Avatar id={num(c.tgChatId)} name={c.title} />
                <div className="chat-item-body">
                  <div className="row">
                    <span className="title">{c.title || c.username || 'بدون نام'}</span>
                  </div>
                  <div className="row">
                    <span className="preview">
                      {c.bot ? 'ربات' : KIND_NAME[c.kind]}
                      {c.username ? ` · @${c.username}` : ''}
                      {c.memberCount != null ? ` · ${toFa(c.memberCount)} عضو` : ''}
                      {c.needsApproval ? ' · عضویت با تأیید مدیر' : ''}
                    </span>
                  </div>
                </div>
                {canOpen ? (
                  <button className="btn sm" disabled={busy} onClick={() => act('/tele/open', { tgChatId: c.tgChatId })}>
                    <MessageSquare size={14} /> {c.kind === 'private' ? 'پیام' : 'باز کردن'}
                  </button>
                ) : (
                  <button className="btn sm primary" disabled={busy} onClick={() => act('/tele/join', c.invite ? { invite: c.invite } : { tgChatId: c.tgChatId })}>
                    <Plus size={14} /> عضویت
                  </button>
                )}
              </li>
            );
          })}
          {!results.length && <li className="muted center pad">چیزی پیدا نشد.</li>}
        </ul>
      )}
    </div>
  );
}

// One line under the search box: is Telegram reachable, and how much of this month is used.
function TeleStatus({ status }) {
  const u = status.usage;
  const egress = status.runtime?.egress;
  const over = u && u.quotaMb > 0 && u.used >= u.quotaMb * 1048576;
  const down = status.runtime && !egress?.running;
  const t = status.traffic;
  const [dot, label] = down ? ['off', 'اتصال سرور به تلگرام قطع است'] : over ? ['off', 'سقف مصرف این ماه تمام شده'] : status.live ? ['on', 'وصل'] : ['', 'در حالت کم‌مصرف'];
  return (
    <span className="tele-status" title={down ? egress?.lastError || '' : t ? `این اتصال: ↓${mb(t.received)} ↑${mb(t.sent)}` : ''}>
      <span className={`tele-dot ${dot}`} />
      <span className={dot === 'off' ? 'tele-warn' : ''}>{label}</span>
      {u && (
        <small className="muted">
          {mb(u.used)}
          {u.quotaMb > 0 ? ` از ${toFa(u.quotaMb)} MB` : ''}
        </small>
      )}
    </span>
  );
}

// The less common actions of a header, behind one button.
function TeleMore({ children }) {
  const [open, setOpen] = useState(false);
  // A tap anywhere closes it, the menu's own buttons included.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => document.addEventListener('click', close));
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', close);
    };
  }, [open]);
  return (
    <span className="tele-more">
      <button className="icon-btn" aria-label="بیشتر" aria-expanded={open} title="بیشتر" onClick={() => setOpen(!open)}>
        <MoreVertical size={20} />
      </button>
      {open && (
        <div className="tele-more-menu" role="menu">
          {children}
        </div>
      )}
    </span>
  );
}

// ---------- Login (phone → code → two-step password) ----------
const CODE_WHERE = {
  app: 'کد به اپ تلگرام شما (روی دستگاه دیگری که وارد هستید) فرستاده شد.',
  sms: 'کد با پیامک فرستاده شد.',
  call: 'کد با تماس تلفنی گفته می‌شود.',
  flash: 'تلگرام با شما تماس می‌گیرد؛ کد، رقم‌های آخر شماره تماس‌گیرنده است.',
  missed: 'تلگرام یک تماس بی‌پاسخ می‌دهد؛ کد، رقم‌های آخر شماره تماس‌گیرنده است.',
  fragment: 'کد در Fragment فرستاده شد.',
};
const CODE_NEXT = { sms: 'ارسال کد با پیامک', call: 'دریافت کد با تماس تلفنی', flash: 'دریافت کد با تماس', missed: 'دریافت کد با تماس بی‌پاسخ', fragment: 'ارسال کد در Fragment' };
const LOGIN_STEPS = ['شماره', 'کد', 'رمز'];
const LOGIN_TITLE = { disconnected: 'اتصال به تلگرام', awaiting_code: 'کد ورود را بنویسید', awaiting_password: 'رمز تلگرامتان را بنویسید' };
function TeleLogin({ status, reload }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phase = status.account?.status || 'disconnected';
  const runtime = status.runtime || {};
  const ready = runtime.apiConfigured && runtime.tdlAvailable;
  const step = Math.max(0, ['disconnected', 'awaiting_code', 'awaiting_password'].indexOf(phase));
  const info = status.codeInfo;
  // Telegram offers the other way (SMS, a call) only after its timeout.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase !== 'awaiting_code') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const wait = info?.timeout ? Math.max(0, Math.ceil((info.at + info.timeout * 1000 - now) / 1000)) : 0;

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      // Keep the reason on screen and show the step the server is really on.
      setError(e.message);
    } finally {
      await reload();
      setBusy(false);
    }
  };
  const cancel = () =>
    run(async () => {
      setCode('');
      setPassword('');
      await api('POST', '/tele/disconnect');
    });
  const submit = (path, body) => (e) => {
    e.preventDefault();
    run(() => api('POST', path, body));
  };

  return (
    <div className="empty-pane tele-login">
      <span className="tele-logo">
        <Send size={34} />
      </span>
      <h2>{LOGIN_TITLE[phase] || LOGIN_TITLE.disconnected}</h2>
      <ol className="tele-login-steps" aria-label={`مرحله ${toFa(step + 1)} از ${toFa(LOGIN_STEPS.length)}`}>
        {LOGIN_STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'now' : i < step ? 'done' : ''}>
            <span>{i < step ? <Check size={13} /> : toFa(i + 1)}</span>
            {label}
          </li>
        ))}
      </ol>
      {!ready && (
        <div className="tele-block">
          <TriangleAlert size={17} /> تلگرام هنوز روی این سرور راه‌اندازی نشده است. به مدیر خبر دهید.
        </div>
      )}
      {ready && !runtime.egress?.running && runtime.egress?.lastError && (
        <div className="tele-block" title={runtime.egress.lastError}>
          <TriangleAlert size={17} /> اتصال سرور به تلگرام الان قطع است؛ ممکن است ورود انجام نشود.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {phase === 'disconnected' && ready && (
        <>
          <form className="form" onSubmit={submit('/tele/login/phone', { phone })}>
            <label>
              شماره موبایل تلگرام
              <input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+98912…" autoFocus />
            </label>
            <button className="btn primary" disabled={busy || !phone.trim()}>
              {busy ? 'در حال ارسال…' : 'دریافت کد'}
            </button>
          </form>
          <ul className="tele-perks">
            <li>
              <ShieldCheck size={16} /> پیام‌های تلگرام شما فقط برای خودتان است
            </li>
            <li>
              <Check size={16} /> روی گوشی به VPN نیاز ندارید
            </li>
            <li>
              <LogOut size={16} /> هر وقت بخواهید با یک دکمه خارج می‌شوید
            </li>
          </ul>
        </>
      )}
      {phase === 'awaiting_code' && (
        <form className="form" onSubmit={submit('/tele/login/code', { code })}>
          <p className="hint">{CODE_WHERE[info?.via] || 'کد را از اپ تلگرام یا پیامک بگیرید.'}</p>
          {info?.via === 'app' && <p className="hint">اگر اینترنت گوشی قطع است و کد به اپ تلگرام نمی‌رسد، کد را با پیامک یا تماس بخواهید (پیامک و تماس اینترنت لازم ندارد).</p>}
          <label>
            کد ورود
            <input className="tele-code" dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy || !code.trim()}>
              تأیید
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              شماره دیگر
            </button>
          </div>
          {info?.next ? (
            <button type="button" className="btn tele-resend" disabled={busy || wait > 0} onClick={() => run(() => api('POST', '/tele/login/resend'))}>
              {CODE_NEXT[info.next] || 'ارسال دوباره کد از راه دیگر'}
              {wait > 0 ? ` (${faDigits(String(Math.floor(wait / 60)))}:${faDigits(String(wait % 60).padStart(2, '0'))})` : ''}
            </button>
          ) : (
            info && <small className="muted">تلگرام فعلاً راه دیگری برای فرستادن کد پیشنهاد نمی‌کند؛ اگر نرسید، چند دقیقه بعد با «شماره دیگر» دوباره شماره را بفرستید.</small>
          )}
        </form>
      )}
      {phase === 'awaiting_password' && (
        <form className="form" onSubmit={submit('/tele/login/password', { password })}>
          <label>
            رمز تأیید دومرحله‌ای تلگرام
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy || !password}>
              ورود
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              انصراف
            </button>
          </div>
        </form>
      )}
    </div>
  );
}


// ---------- An open chat ----------
function TeleChat({ dialog, onChanged, onRemove, allowMedia, allowVoice, allowFiles, allowExplore, mediaMaxMb, fileMaxMb }) {
  const [messages, setMessages] = useState(null);
  const [notice, setNotice] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const uid = useStore((s) => s.me?.id || 0);
  // Unsent text survives a reload or switching chats (see drafts.js); cleared once sent.
  const [draft, setDraft] = useState(() => loadDraft(uid, 'tele', dialog.id));
  const saver = useDraftSaver(uid, 'tele', dialog.id);
  useEffect(() => saver.set(draft), [draft, saver]);
  const [sending, setSending] = useState(false);
  // A voice whose send failed: kept here (memory only) to send again or delete.
  const [failedVoice, setFailedVoice] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [recording, setRecording] = useState(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const anyFileRef = useRef(null);
  const stick = useRef(true); // keep the view at the newest message while the user is there
  const keepFrom = useRef(null); // scroll height before older messages were added on top
  const showToast = useStore((s) => s.showToast);
  const isGroup = dialog.kind === 'group';
  const isChannel = dialog.kind === 'channel';

  const byTg = (a, b) => (a.tgMsgId ?? Infinity) - (b.tgMsgId ?? Infinity) || a.id - b.id;
  // The server's latest page replaces everything shown from its oldest message on: a message sent
  // from here moves from its temporary id to its final one, and must not stay twice on screen.
  const withLatest = (cur, page) => {
    if (!page.length) return cur || [];
    const from = Math.min(...page.map((m) => m.tgMsgId ?? Infinity));
    const ids = new Set(page.map((m) => m.id));
    return [...(cur || []).filter((m) => (m.tgMsgId ?? Infinity) < from && !ids.has(m.id)), ...page].sort(byTg);
  };
  const withOlder = (cur, older) => {
    const ids = new Set((cur || []).map((m) => m.id));
    return [...older.filter((m) => !ids.has(m.id)), ...(cur || [])].sort(byTg);
  };

  const fetchLatest = async (first) => {
    try {
      // Later checks ask TDLib for what it already received (local=1): no network traffic.
      const r = await api('GET', `/tele/dialogs/${dialog.id}/messages${first ? '' : '?local=1'}`, undefined, first ? undefined : POLL);
      setMessages((cur) => withLatest(first ? [] : cur, r.messages || []));
      setNotice(r.notice || '');
      if (first) {
        setHasMore(r.hasMore !== false);
        onChanged();
      }
    } catch (e) {
      setNotice(e.message);
      if (first) setMessages([]);
    }
  };

  useEffect(() => {
    fetchLatest(true);
  }, [dialog.id]); // eslint-disable-line
  // Data saver: check a third as often (each check is a request on a slow or metered link).
  const dataSaver = useDataSaver();
  useEffect(() => {
    const t = setInterval(() => visible() && fetchLatest(false), dataSaver ? 15000 : 5000);
    return () => clearInterval(t);
  }, [dialog.id, dataSaver]); // eslint-disable-line

  const loadOlder = async () => {
    const oldest = messages?.find((m) => m.tgMsgId);
    if (!oldest || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    keepFrom.current = listRef.current.scrollHeight - listRef.current.scrollTop;
    try {
      const r = await api('GET', `/tele/dialogs/${dialog.id}/messages?before=${oldest.tgMsgId}`);
      const older = r.messages || [];
      if (!older.length) setHasMore(false);
      setMessages((cur) => withOlder(cur, older));
    } catch (e) {
      showToast(e.message);
    } finally {
      setLoadingOlder(false);
    }
  };

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !messages) return;
    if (keepFrom.current != null) {
      el.scrollTop = el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = listRef.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60) loadOlder();
  };

  const sent = (message, { keepDraft = false } = {}) => {
    if (message?.kind === 'queued') showToast('تلگرام الان وصل نیست؛ پیام در صف است و با وصل شدن خودش فرستاده می‌شود');
    if (!keepDraft) setDraft('');
    setReplyTo(null);
    stick.current = true;
    setMessages((cur) => withOlder(cur, [message]));
    onChanged();
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      sent((await api('POST', `/tele/dialogs/${dialog.id}/messages`, { text, replyTo: replyTo?.tgMsgId || null })).message);
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };
  // A photo, with the text box as its caption.
  const sendPhoto = async (file) => {
    if (!file) return;
    setSending(true);
    try {
      // Smaller photo = less to push over a slow link and through the server's tunnel. The
      // original is sent when the browser can't decode it (HEIC) or runs out of memory; a GIF
      // stays untouched to keep its animation.
      let blob = file;
      let name = file.name || 'photo.jpg';
      if (file.type !== 'image/gif') {
        try {
          const c = dataSaverNow() ? await compressImage(file, 1280, 0.7) : await compressImage(file);
          if (c.blob && c.blob.size < file.size) {
            blob = c.blob;
            name = (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg';
          }
        } catch {}
      }
      if (blob.size > mediaMaxMb * 1048576) return showToast(`حداکثر حجم عکس ${toFa(mediaMaxMb)} مگابایت است`);
      const qs = new URLSearchParams({ caption: draft.trim(), ...(replyTo ? { replyTo: String(replyTo.tgMsgId) } : {}) });
      const body = new FormData();
      body.append('file', blob, name);
      const data = await teleUpload(`/tele/dialogs/${dialog.id}/photo?${qs}`, body, { errorText: 'ارسال عکس ناموفق بود' });
      sent(data.message);
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };

  // A recorded voice message (converted to Telegram's format on the server).
  const sendVoice = async (blob, seconds) => {
    setRecording(false);
    if (!blob || blob.size < 1000) return;
    if (blob.size > mediaMaxMb * 1048576) return showToast(`حداکثر حجم پیام صوتی ${toFa(mediaMaxMb)} مگابایت است`);
    setSending(true);
    try {
      const qs = new URLSearchParams({ duration: String(Math.max(1, Math.round(seconds))), ...(replyTo ? { replyTo: String(replyTo.tgMsgId) } : {}) });
      const body = new FormData();
      body.append('file', blob, `voice.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
      const data = await teleUpload(`/tele/dialogs/${dialog.id}/voice?${qs}`, body, { errorText: 'ارسال پیام صوتی ناموفق بود' });
      setFailedVoice(null);
      // A voice has no caption: what is in the text box (typed before a retry) stays.
      sent(data.message, { keepDraft: true });
    } catch (e) {
      // Kept to send again: re-recording a lost voice is worse than a retry button.
      setFailedVoice({ blob, seconds, error: e.message });
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };
  const forward = (m) => useStore.getState().openModal('teleToChat', { message: m });
  const sendFile = async (file) => {
    if (!file) return;
    if (file.size > fileMaxMb * 1048576) return showToast(`حداکثر حجم فایل ${toFa(fileMaxMb)} مگابایت است`);
    setSending(true);
    try {
      const qs = new URLSearchParams({ caption: draft.trim(), ...(replyTo ? { replyTo: String(replyTo.tgMsgId) } : {}) });
      const body = new FormData();
      body.append('file', file);
      const data = await teleUpload(`/tele/dialogs/${dialog.id}/file?${qs}`, body, { errorText: 'ارسال فایل ناموفق بود' });
      sent(data.message);
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };
  const cancelQueued = async (m) => {
    try {
      await api('DELETE', `/tele/messages/${m.id}`);
      setMessages((cur) => (cur || []).filter((x) => x.id !== m.id));
    } catch (e) {
      showToast(e.message);
    }
  };

  const startReply = (m) => {
    if (isChannel || !m.tgMsgId) return;
    setReplyTo(m);
    inputRef.current?.focus();
  };
  const jumpTo = (tgMsgId) => {
    const el = document.getElementById(`tm-${tgMsgId}`);
    if (!el) return showToast('این پیام در بخش بارگذاری‌شده نیست');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  };

  const search = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try {
      setFound((await api('GET', `/tele/dialogs/${dialog.id}/search?q=${encodeURIComponent(q.trim())}`)).messages || []);
    } catch (err) {
      showToast(err.message);
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQ('');
    setFound(null);
  };

  const subtitle = isChannel ? 'کانال' : isGroup ? 'گروه' : dialog.username ? `@${dialog.username}` : 'گفتگوی خصوصی';
  const replyName = (m) => (m.direction === 'out' ? 'خودتان' : m.senderName || dialog.title);

  return (
    <div className="chat-view tele-chat">
      <header className="chat-head">
        {searchOpen ? (
          <form className="tele-search" onSubmit={search}>
            <input className="search grow" autoFocus placeholder="جستجو در این گفتگو…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="icon-btn" aria-label="جستجو">
              <Search size={20} />
            </button>
            <button type="button" className="icon-btn" aria-label="بستن جستجو" onClick={closeSearch}>
              <X size={20} />
            </button>
          </form>
        ) : (
          <>
            <div className="chat-head-info">
              <Avatar id={num(dialog.tgChatId)} name={dialog.title} size={40} />
              <div>
                <div className="title">{dialog.title || 'بدون نام'}</div>
                <div className="subtitle">{subtitle}</div>
              </div>
            </div>
            <button className="icon-btn" aria-label="جستجو در این گفتگو" title="جستجو در این گفتگو" onClick={() => setSearchOpen(true)}>
              <Search size={20} />
            </button>
            {(dialog.selected || (allowExplore && dialog.kind !== 'private')) && (
              <TeleMore>
                {dialog.selected && (
                  <button role="menuitem" onClick={() => confirm(`«${dialog.title || 'این گفتگو'}» از فهرست شما حذف شود؟ در تلگرام چیزی پاک نمی‌شود.`) && onRemove()}>
                    <CircleMinus size={17} /> حذف از گفتگوهای من
                  </button>
                )}
                {allowExplore && dialog.kind !== 'private' && (
                  <button
                    role="menuitem"
                    className="danger"
                    onClick={async () => {
                      if (!confirm(`از «${dialog.title || 'این گفتگو'}» در تلگرام خارج می‌شوید (عضویتتان در خود تلگرام هم برداشته می‌شود). ادامه؟`)) return;
                      try {
                        await api('POST', `/tele/dialogs/${dialog.id}/leave`);
                        location.hash = '#/tele';
                        onChanged?.();
                      } catch (e) {
                        useStore.getState().showToast(e.message);
                      }
                    }}
                  >
                    <DoorOpen size={17} /> خروج از این {dialog.kind === 'channel' ? 'کانال' : 'گروه'} در تلگرام
                  </button>
                )}
              </TeleMore>
            )}
          </>
        )}
        <a className="icon-btn back" href="#/tele" aria-label="بازگشت">
          <ArrowRight size={22} />
        </a>
      </header>
      {notice && <div className="tele-notice">{notice}</div>}

      {found ? (
        <div className="messages">
          <div className="day-sep">{found.length ? `${toFa(found.length)} نتیجه برای «${q.trim()}»` : `نتیجه‌ای برای «${q.trim()}» نیست`}</div>
          {found.map((m) => (
            <TeleMessage key={m.id} m={m} showSender={!isChannel} showAvatar={false} grouped={false} withDate allowMedia={allowMedia} allowVoice={allowVoice} allowFiles={allowFiles} onForward={forward} />
          ))}
        </div>
      ) : (
        <div className="messages" ref={listRef} onScroll={onScroll}>
          {loadingOlder && <div className="muted center pad">…</div>}
          {!messages && <div className="muted center pad">در حال بارگذاری…</div>}
          {messages?.length === 0 && <div className="muted center pad">پیامی نیست.</div>}
          {messages?.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
            const grouped = !newDay && prev && prev.direction === m.direction && prev.senderId === m.senderId && m.createdAt - prev.createdAt < 5 * 60000;
            const mine = m.direction === 'out';
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day-sep">{formatDay(m.createdAt)}</div>}
                <TeleMessage
                  m={m}
                  grouped={grouped}
                  showSender={isGroup && !mine && !grouped}
                  showAvatar={isGroup && !mine}
                  allowMedia={allowMedia}
                  allowVoice={allowVoice}
                  allowFiles={allowFiles}
                  onForward={forward}
                  onCancel={cancelQueued}
                  onReply={isChannel ? null : startReply}
                  onJump={jumpTo}
                />
              </Fragment>
            );
          })}
        </div>
      )}

      {!isChannel && !found && (
        <div className="composer-wrap">
          {replyTo && (
            <div className="composer-bar">
              <span className="bar-icon">
                <Reply size={20} />
              </span>
              <span className="bar-body">
                <b>پاسخ به {replyName(replyTo)}</b>
                <span className="preview">{(replyTo.text || '').split('\n')[0]}</span>
              </span>
              <button className="icon-btn" aria-label="لغو پاسخ" onClick={() => setReplyTo(null)}>
                <X size={20} />
              </button>
            </div>
          )}
          {failedVoice && (
            <div className="composer-bar voice-retry">
              <span className="bar-icon">
                <Mic size={20} />
              </span>
              <span className="bar-body">
                <b>{sending ? 'در حال ارسال پیام صوتی…' : 'پیام صوتی ارسال نشد'}</b>
                {failedVoice.error && <span className="preview">{failedVoice.error}</span>}
              </span>
              <button className="btn sm" disabled={sending} onClick={() => sendVoice(failedVoice.blob, failedVoice.seconds)}>
                ارسال دوباره
              </button>
              <button
                className="icon-btn"
                aria-label="حذف پیام صوتی"
                disabled={sending}
                onClick={() => confirm('این پیام صوتی حذف شود؟') && setFailedVoice(null)}
              >
                <X size={20} />
              </button>
            </div>
          )}
          {recording ? (
            <TeleRecorder onSend={sendVoice} onCancel={() => setRecording(false)} maxSeconds={600} />
          ) : (
          <div className="composer">
            {allowVoice && !draft.trim() ? (
              <button className="send-btn" aria-label="ضبط پیام صوتی" title="ضبط پیام صوتی" disabled={sending || !!failedVoice} onClick={() => setRecording(true)}>
                <Mic size={20} />
              </button>
            ) : (
              <button className="send-btn" aria-label="ارسال" disabled={!draft.trim() || sending} onMouseDown={(e) => e.preventDefault()} onClick={send}>
                <SendHorizontal size={20} />
              </button>
            )}
            {allowFiles && (
              <>
                <button className="icon-btn" aria-label="ارسال فایل" title={`ارسال فایل یا ویدیو (تا ${toFa(fileMaxMb)} مگابایت؛ متن بالا توضیح فایل می‌شود)`} disabled={sending} onClick={() => anyFileRef.current.click()}>
                  <Paperclip size={21} />
                </button>
                <input
                  ref={anyFileRef}
                  type="file"
                  hidden
                  onChange={(e) => {
                    sendFile(e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </>
            )}
            {allowMedia && (
              <>
                <button className="icon-btn" aria-label="ارسال عکس" title={`ارسال عکس (تا ${toFa(mediaMaxMb)} مگابایت؛ متن بالا توضیح عکس می‌شود)`} disabled={sending} onClick={() => fileRef.current.click()}>
                  <ImagePlus size={22} />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    sendPhoto(e.target.files[0]);
                    e.target.value = '';
                  }}
                />
              </>
            )}
            <textarea
              ref={inputRef}
              rows={1}
              dir="auto"
              placeholder="پیام…"
              value={draft}
              maxLength={4000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                } else if (e.key === 'Escape' && replyTo) {
                  setReplyTo(null);
                }
              }}
            />
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// Recording a voice message: time, cancel, send.
function TeleRecorder({ onSend, onCancel, maxSeconds }) {
  const showToast = useStore((s) => s.showToast);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef(null);
  const done = useRef(false);
  useEffect(() => {
    let cancelled = false;
    let timer;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('ضبط صدا فقط روی HTTPS ممکن است');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.current = { recorder, chunks, stream, start: Date.now() };
        recorder.start(250);
        timer = setInterval(() => {
          const s = Math.floor((Date.now() - rec.current.start) / 1000);
          setSeconds(s);
          if (s >= maxSeconds) finish(true);
        }, 250);
      } catch (e) {
        showToast(e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد' : e.message);
        onCancel();
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish(send) {
    const r = rec.current;
    if (done.current) return;
    done.current = true;
    if (!r) return onCancel();
    await new Promise((ok) => {
      r.recorder.onstop = ok;
      if (r.recorder.state === 'recording') r.recorder.stop();
      else ok();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    if (!send) return onCancel();
    onSend(new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' }), (Date.now() - r.start) / 1000);
  }
  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="composer tele-recorder">
      <button className="send-btn" aria-label="ارسال پیام صوتی" onClick={() => finish(true)}>
        <SendHorizontal size={20} />
      </button>
      <span className="grow tele-rec-time">
        <span className="tele-rec-dot" /> {faDigits(mmss)}
      </span>
      <button className="icon-btn" aria-label="لغو ضبط" onClick={() => finish(false)}>
        <Trash2 size={20} />
      </button>
    </div>
  );
}

function TeleMessage({ m, grouped, showSender, showAvatar, withDate, allowMedia, allowVoice, allowFiles, onReply, onJump, onForward, onCancel }) {
  const mine = m.direction === 'out';
  const [menu, setMenu] = useState(false);
  const queued = m.kind === 'queued';
  // Not sent yet: no reply or forward (it has no Telegram id).
  if (queued) {
    onReply = null;
    onForward = null;
  }
  const showVoice = m.voice && allowVoice;
  const showFile = m.file && allowFiles;
  // Without a photo / player shown, the text keeps its "📷 عکس" / "🎤 پیام صوتی" label; with it, only the caption.
  const text = m.photo && allowMedia ? m.text.replace(/^📷 عکس\n?/, '') : showVoice ? m.text.replace(/^🎤 پیام صوتی\n?/, '') : showFile ? m.text.replace(/^(📎|🎬|🎵|GIF)[^\n]*\n?/, '') : m.text;
  return (
    <div className={`msg-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`} id={m.tgMsgId ? `tm-${m.tgMsgId}` : undefined}>
      {showAvatar && <div className="msg-avatar">{!grouped && <Avatar id={num(m.senderId)} name={m.senderName} size={34} />}</div>}
      <div className="bubble-col">
        <div
          className={`bubble ${m.photo && allowMedia ? 'has-media' : ''}`}
          onDoubleClick={() => onReply?.(m)}
          onContextMenu={(e) => {
            if (!onReply && !onForward) return;
            e.preventDefault();
            setMenu(true);
          }}
        >
          {showSender && m.senderName && (
            <div className="sender" style={{ color: colorFor(num(m.senderId)) }}>
              {m.senderName}
            </div>
          )}
          {m.replyTo && (
            <button className="reply-quote" onClick={() => onJump?.(m.replyTo.tgMsgId)}>
              <b>{m.replyTo.senderName || 'پیام'}</b>
              <span>{m.replyTo.text || '…'}</span>
            </button>
          )}
          {m.photo && allowMedia && <TelePhoto m={m} />}
          {showVoice && <TeleVoice m={m} />}
          {showFile && <TeleFile m={m} />}
          {text && (
            <div className={`text ${m.kind !== 'text' && !(m.photo && allowMedia) ? 'tele-media' : ''}`} dir="auto">
              {text}
            </div>
          )}
          <div className="meta">
            {m.kind === 'failed' && <span className="tele-warn">ارسال نشد</span>}
            {queued && (
              <span className="tele-queued" title="تلگرام الان وصل نیست؛ با وصل شدن خودش فرستاده می‌شود">
                ⏳ در صف
                {onCancel && (
                  <button className="link-btn" onClick={() => onCancel(m)}>
                    لغو
                  </button>
                )}
              </span>
            )}
            <span>{withDate ? `${formatDay(m.createdAt)} ${formatTime(m.createdAt)}` : formatTime(m.createdAt)}</span>
          </div>
          {onReply && (
            <button className="msg-more" aria-label="پاسخ" title="پاسخ" onClick={() => onReply(m)}>
              <Reply size={17} />
            </button>
          )}
          {onForward && (
            <button className="msg-more msg-fwd" aria-label="ارسال به چت داخلی" title="ارسال به چت داخلی" onClick={() => onForward(m)}>
              <Forward size={17} />
            </button>
          )}
          {menu && (
            <div className="tele-msg-menu" onClick={(e) => e.stopPropagation()}>
              {onReply && (
                <button
                  onClick={() => {
                    setMenu(false);
                    onReply(m);
                  }}
                >
                  <Reply size={16} /> پاسخ
                </button>
              )}
              {onForward && (
                <button
                  onClick={() => {
                    setMenu(false);
                    onForward(m);
                  }}
                >
                  <Forward size={16} /> ارسال به چت داخلی
                </button>
              )}
              <button onClick={() => setMenu(false)}>
                <X size={16} /> بستن
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The blurred preview Telegram sends with every photo; the full photo only when tapped (VPN traffic).
function TelePhoto({ m }) {
  const [src, setSrc] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  const ratio = m.photo.w && m.photo.h ? Math.min(Math.max(m.photo.h / m.photo.w, 0.4), 1.6) : 0.75;
  const load = async () => {
    if (state === 'loading' || src) return;
    setState('loading');
    try {
      setSrc(URL.createObjectURL(await teleDownload(`/tele/messages/${m.id}/photo`, { errorText: 'دانلود عکس ناموفق بود' })));
      setState('idle');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  };
  return (
    <button className="tele-photo" style={{ aspectRatio: `1 / ${ratio}` }} onClick={src ? () => window.open(src, '_blank') : load} title={src ? 'باز کردن عکس' : 'دانلود عکس'}>
      {src ? (
        <img src={src} alt="" />
      ) : (
        <>
          {m.photo.mini ? <img className="blur" src={`data:image/jpeg;base64,${m.photo.mini}`} alt="" /> : <span className="tele-photo-empty" />}
          <span className="tele-photo-cta">{state === 'loading' ? 'در حال دانلود…' : state === 'error' ? error : `📷 دانلود عکس${m.photo.size ? ` (${formatSize(m.photo.size)})` : ''}`}</span>
        </>
      )}
    </button>
  );
}

function TeleVoice({ m }) {
  const [src, setSrc] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  const d = m.voice.duration || 0;
  const len = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
  const load = async () => {
    if (state === 'loading') return;
    setState('loading');
    try {
      setSrc(URL.createObjectURL(await teleDownload(`/tele/messages/${m.id}/voice`, { errorText: 'دانلود پیام صوتی ناموفق بود' })));
      setState('idle');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  };
  if (src) return <audio className="tele-voice-audio" src={src} controls autoPlay preload="auto" />;
  return (
    <button className="tele-voice" onClick={load} title="دانلود و پخش">
      <span className="tele-voice-play">
        <Play size={18} />
      </span>
      <span className="grow">{state === 'loading' ? 'در حال دانلود…' : state === 'error' ? error : `پیام صوتی · ${faDigits(len)}`}</span>
    </button>
  );
}

function TeleFile({ m }) {
  const [src, setSrc] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | error
  const [error, setError] = useState('');
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  const f = m.file;
  const playable = f.video && /^video\/(mp4|webm)$/.test(f.mime || '');
  const load = async () => {
    if (state === 'loading') return;
    setState('loading');
    try {
      const url = URL.createObjectURL(await teleDownload(`/tele/messages/${m.id}/file${playable ? '?inline=1' : ''}`, { errorText: 'دانلود فایل ناموفق بود' }));
      if (playable) {
        setSrc(url);
      } else {
        // Saved, never opened in the page.
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name || 'file';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      setState('done');
    } catch (e) {
      setError(e.message);
      setState('error');
    }
  };
  if (src) return <video className="tele-video" src={src} controls autoPlay={!!f.gif} loop={!!f.gif} muted={!!f.gif} playsInline />;
  const Icon = f.video ? Film : FileText;
  return (
    <button className="tele-file" onClick={load} title={playable ? 'دانلود و پخش' : 'دانلود'}>
      <span className="tele-file-icon">{state === 'loading' ? <Download size={18} /> : <Icon size={18} />}</span>
      <span className="grow">
        <span className="tele-file-name" dir="auto">
          {f.name}
        </span>
        <small className="muted">
          {state === 'loading' ? 'در حال دانلود…' : state === 'error' ? error : state === 'done' ? 'ذخیره شد' : `${mb(f.size || 0)}${f.duration ? ` · ${faDigits(`${Math.floor(f.duration / 60)}:${String(f.duration % 60).padStart(2, '0')}`)}` : ''}`}
        </small>
      </span>
    </button>
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
