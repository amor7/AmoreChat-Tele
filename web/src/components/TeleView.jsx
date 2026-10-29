import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { colorFor, formatDay, formatListTime, formatTime, sameDay, toFa } from '../util';
import Avatar from './Avatar';
import { ArrowRight, Cable, Check, LogOut, Megaphone, Plus, RefreshCw, Search, SendHorizontal, Users, X, CircleMinus } from 'lucide-react';

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

export default function TeleView({ dialogId }) {
  const [status, setStatus] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [picking, setPicking] = useState(false);
  const showToast = useStore((s) => s.showToast);

  const load = () => api('GET', '/tele/status').then(setStatus).catch((e) => showToast(e.message));
  const account = status?.account;
  const connected = account?.status === 'connected';

  const syncList = async (all = false) => {
    setSyncing(true);
    try {
      const r = await api('POST', '/tele/dialogs/refresh', { all });
      if (r?.notice) showToast(r.notice);
      await load();
    } catch (e) {
      showToast(e.message);
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
    const fromTelegram = setInterval(() => visible() && syncList(), 60000);
    const stored = setInterval(() => visible() && load(), 10000);
    return () => {
      clearInterval(fromTelegram);
      clearInterval(stored);
    };
  }, [connected]); // eslint-disable-line

  const dialogs = status?.dialogs || [];
  const mine = useMemo(() => dialogs.filter((d) => d.selected), [dialogs]);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (picking ? dialogs : mine).filter((d) => (tab === 'all' || d.kind === tab) && (!q || `${d.title} ${d.username}`.toLowerCase().includes(q)));
  }, [dialogs, mine, picking, query, tab]);
  const unreadOf = (kind) => mine.filter((d) => (kind === 'all' || d.kind === kind) && d.unread > 0).length;
  const active = dialogs.find((d) => d.id === dialogId);

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
          <input
            className="search grow"
            placeholder={picking ? 'جستجو در همه گفتگوهای تلگرام…' : 'جستجو در گفتگوهای من…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={!connected}
          />
          {connected && !picking && (
            <>
              <button className="icon-btn" aria-label="افزودن گفتگو" title="افزودن گفتگو" onClick={startPicking}>
                <Plus size={21} />
              </button>
              <button className={`icon-btn ${syncing ? 'spin' : ''}`} aria-label="به‌روزرسانی" title="به‌روزرسانی" onClick={() => syncList()} disabled={syncing}>
                <RefreshCw size={19} />
              </button>
              <button className="icon-btn" aria-label="خروج از حساب تلگرام" title="خروج از حساب تلگرام" onClick={logout}>
                <LogOut size={19} />
              </button>
            </>
          )}
          {picking && (
            <button className="btn sm primary" onClick={stopPicking}>
              تمام
            </button>
          )}
        </header>
        <div className="site-name tele-brand">
          <Cable size={13} />
          {picking ? 'گفتگوهایی را که می‌خواهید اضافه کنید؛ فقط همین‌ها به‌روز نگه داشته می‌شوند.' : `تلگرام${account?.displayName ? ` · ${account.displayName}` : ''}`}
          {!picking && connected && <LinkState status={status} />}
          <TunnelState runtime={status?.runtime} />
        </div>
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
          {status && !connected && <li className="muted center pad">برای دیدن گفتگوها وارد حساب تلگرام شوید.</li>}
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
                    <DialogBody d={d} withUnread />
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
                <>
                  <p>هنوز گفتگویی اضافه نکرده‌اید.</p>
                  <button className="btn primary" onClick={startPicking}>
                    <Plus size={16} /> افزودن گفتگو
                  </button>
                </>
              )}
            </li>
          )}
        </ul>
      </aside>
      <main className="chat-pane">
        {!status ? null : !connected ? (
          <TeleLogin status={status} reload={load} />
        ) : active ? (
          <TeleChat key={active.id} dialog={active} onChanged={load} onRemove={() => remove(active)} />
        ) : (
          <div className="empty-pane">
            <Cable size={64} className="muted" />
            <h2>تلگرام</h2>
            <p>{mine.length ? 'یک گفتگو را از فهرست انتخاب کنید.' : 'با دکمه + گفتگوهایی را که می‌خواهید اضافه کنید.'}</p>
          </div>
        )}
      </main>
    </>
  );
}

function DialogBody({ d, withUnread }) {
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
          <span className="preview">
            {d.lastOut && d.lastText ? 'شما: ' : ''}
            {(d.lastText || '').split('\n')[0]}
          </span>
          {withUnread && d.unread > 0 && <span className="badge">{toFa(d.unread)}</span>}
        </div>
      </div>
    </>
  );
}

// Open TDLib connection (and what it moved), or closed to save traffic until a chat is opened.
function LinkState({ status }) {
  if (!status.live) return <span className="muted"> · در حالت صرفه‌جویی</span>;
  const t = status.traffic;
  return (
    <span className="muted" title="مصرف اینترنت این اتصال از زمان وصل شدن">
      {' '}
      · وصل{t ? ` · ↓${mb(t.received)} ↑${mb(t.sent)}` : ''}
    </span>
  );
}

function TunnelState({ runtime }) {
  if (!runtime || runtime.egress?.running) return null;
  return (
    <span className="tele-warn" title={runtime.egress?.lastError || ''}>
      {' '}
      · تونل خاموش{runtime.egress?.lastError ? `: ${runtime.egress.lastError}` : ''}
    </span>
  );
}

// ---------- Login (phone → code → two-step password) ----------
function TeleLogin({ status, reload }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phase = status.account?.status || 'disconnected';
  const runtime = status.runtime || {};

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
      <Cable size={56} className="muted" />
      <h2>ورود به تلگرام</h2>
      <p className="muted">حساب شخصی شما؛ ترافیک فقط از پروکسی سرور می‌گذرد.</p>
      <small className="muted">
        API: {runtime.apiConfigured ? 'OK' : 'خیر'} · TDLib: {runtime.tdlAvailable ? 'OK' : 'خیر'} · تونل: {runtime.egress?.running ? 'روشن' : 'خاموش'}
        {!runtime.egress?.running && runtime.egress?.lastError ? ` (${runtime.egress.lastError})` : ''}
      </small>
      {error && <div className="error">{error}</div>}

      {phase === 'disconnected' && (
        <form className="form" onSubmit={submit('/tele/login/phone', { phone })}>
          <label>
            شماره موبایل
            <input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+98912…" autoFocus />
          </label>
          <button className="btn primary" disabled={busy || !phone.trim()}>
            {busy ? 'در حال ارسال…' : 'دریافت کد'}
          </button>
        </form>
      )}
      {phase === 'awaiting_code' && (
        <form className="form" onSubmit={submit('/tele/login/code', { code })}>
          <p className="hint">کد را از اپ تلگرام یا پیامک بگیرید.</p>
          <label>
            کد ورود
            <input dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </label>
          <div className="inline-form">
            <button className="btn primary" disabled={busy || !code.trim()}>
              تأیید
            </button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>
              شماره دیگر
            </button>
          </div>
        </form>
      )}
      {phase === 'awaiting_password' && (
        <form className="form" onSubmit={submit('/tele/login/password', { password })}>
          <label>
            رمز دومرحله‌ای
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
function TeleChat({ dialog, onChanged, onRemove }) {
  const [messages, setMessages] = useState(null);
  const [notice, setNotice] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const listRef = useRef(null);
  const stick = useRef(true); // keep the view at the newest message while the user is there
  const keepFrom = useRef(null); // scroll height before older messages were added on top
  const showToast = useStore((s) => s.showToast);
  const isGroup = dialog.kind === 'group';
  const isChannel = dialog.kind === 'channel';

  // Merge by Telegram id: polling returns the latest page, which overlaps what is shown.
  const merge = (older, newer) => {
    const map = new Map();
    for (const m of [...(older || []), ...newer]) map.set(m.tgMsgId ?? `r${m.id}`, m);
    return [...map.values()].sort((a, b) => (a.tgMsgId ?? 0) - (b.tgMsgId ?? 0) || a.id - b.id);
  };

  const fetchLatest = async (first) => {
    try {
      // Later checks ask TDLib for what it already received (local=1): no network traffic.
      const r = await api('GET', `/tele/dialogs/${dialog.id}/messages${first ? '' : '?local=1'}`);
      setMessages((cur) => merge(first ? [] : cur, r.messages || []));
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
    const t = setInterval(() => visible() && fetchLatest(false), 5000);
    return () => clearInterval(t);
  }, [dialog.id]); // eslint-disable-line

  const loadOlder = async () => {
    const oldest = messages?.find((m) => m.tgMsgId);
    if (!oldest || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    keepFrom.current = listRef.current.scrollHeight - listRef.current.scrollTop;
    try {
      const r = await api('GET', `/tele/dialogs/${dialog.id}/messages?before=${oldest.tgMsgId}`);
      const older = r.messages || [];
      if (!older.length) setHasMore(false);
      setMessages((cur) => merge(older, cur || []));
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

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await api('POST', `/tele/dialogs/${dialog.id}/messages`, { text });
      setDraft('');
      stick.current = true;
      setMessages((cur) => merge(cur, [r.message]));
      onChanged();
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
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
            <button
              className="icon-btn"
              aria-label="حذف از گفتگوهای من"
              title="حذف از گفتگوهای من (دیگر به‌روز نمی‌شود)"
              onClick={() => confirm(`«${dialog.title || 'این گفتگو'}» از فهرست شما حذف شود؟ در تلگرام چیزی پاک نمی‌شود.`) && onRemove()}
            >
              <CircleMinus size={20} />
            </button>
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
            <TeleMessage key={m.id} m={m} showSender={!isChannel} showAvatar={false} grouped={false} withDate />
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
              <Fragment key={m.tgMsgId ?? `r${m.id}`}>
                {newDay && <div className="day-sep">{formatDay(m.createdAt)}</div>}
                <TeleMessage m={m} grouped={grouped} showSender={isGroup && !mine && !grouped} showAvatar={isGroup && !mine} />
              </Fragment>
            );
          })}
        </div>
      )}

      {!isChannel && !found && (
        <div className="composer-wrap">
          <div className="composer">
            <button className="send-btn" aria-label="ارسال" disabled={!draft.trim() || sending} onMouseDown={(e) => e.preventDefault()} onClick={send}>
              <SendHorizontal size={20} />
            </button>
            <textarea
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
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TeleMessage({ m, grouped, showSender, showAvatar, withDate }) {
  const mine = m.direction === 'out';
  return (
    <div className={`msg-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`}>
      {showAvatar && <div className="msg-avatar">{!grouped && <Avatar id={num(m.senderId)} name={m.senderName} size={34} />}</div>}
      <div className="bubble-col">
        <div className="bubble">
          {showSender && m.senderName && (
            <div className="sender" style={{ color: colorFor(num(m.senderId)) }}>
              {m.senderName}
            </div>
          )}
          <div className={`text ${m.kind !== 'text' ? 'tele-media' : ''}`} dir="auto">
            {m.text}
          </div>
          <div className="meta">
            <span>{withDate ? `${formatDay(m.createdAt)} ${formatTime(m.createdAt)}` : formatTime(m.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
