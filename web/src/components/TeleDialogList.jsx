import { useState } from 'react';
import { useStore } from '../store';
import { formatListTime, formatSize, toFa } from '../util';
import { findTelegram, openTelegramChat, joinTelegramChat } from '../teleApi';
import { avatarNum } from '../tele-rules';
import Avatar from './Avatar';
import { draftPreview } from '../useDrafts';
import { EmptyState, ErrorState, SkeletonList, BusyState } from './States';
import { Check, Megaphone, MessageSquare, Plus, Users, X } from 'lucide-react';

// The Telegram side column: the user's chats (or, while adding, all their Telegram chats), the
// "find anyone" panel and the status line under the header.

const KIND_ICON = { group: Users, channel: Megaphone };

/**
 * The list itself. `picking`: every chat, each a toggle (added / not); otherwise the added chats
 * as links. `login` is what a phone shows here before an account is connected.
 */
export default function TeleDialogList({ status, loadError, onRetry, connected, picking, syncing, list, mine, dialogId, drafts, onToggle, login }) {
  return (
    <ul className="chat-list">
      {!status && <li>{loadError ? <ErrorState message={loadError} onRetry={onRetry} /> : <SkeletonList rows={6} avatar />}</li>}
      {status?.access === false && <li className="muted center pad">دسترسی شما به تلگرام بسته است.</li>}
      {status && status.access !== false && !connected && login}
      {connected &&
        list.map((d) =>
          picking ? (
            <li key={d.id}>
              <button className={`chat-item tele-pick ${d.selected ? 'active' : ''}`} onClick={() => onToggle(d)} aria-pressed={d.selected}>
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
        <li>
          {picking && syncing ? (
            <BusyState compact text="در حال دریافت گفتگوها از تلگرام…" />
          ) : picking || mine.length ? (
            <EmptyState compact hint="گفتگویی پیدا نشد" />
          ) : (
            <EmptyState compact title="هنوز گفتگویی انتخاب نکرده‌اید" hint="با دکمه‌ی «+» (افزودن گفتگو) بالای این فهرست گفتگوهای تلگرامتان را اضافه کنید." />
          )}
        </li>
      )}
    </ul>
  );
}

function DialogBody({ d, withUnread, draft }) {
  const Icon = KIND_ICON[d.kind];
  return (
    <>
      <Avatar id={avatarNum(d.tgChatId)} name={d.title} />
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
export function TeleFind({ onOpened, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const find = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      setResults((await findTelegram(q.trim())).results);
    } catch (err) {
      setResults([]);
      showToast(err.message);
    }
    setBusy(false);
  };
  const act = async (request) => {
    setBusy(true);
    try {
      const r = await request();
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
        <input className="search grow" autoFocus dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder="‎@نام‌کاربری، شماره، لینک t.me یا نام کانال…" aria-label="پیام به شخص یا عضویت در گروه و کانال" />
        <button className="btn sm primary" disabled={busy || q.trim().length < 2}>
          {busy ? '…' : 'جستجو'}
        </button>
        {/* Not «بستن جستجو»: that one is the open chat's search, and tele-e2e clicks it by name. */}
        <button type="button" className="icon-btn" aria-label="بستن پیدا کردن" title="بستن" onClick={onClose}>
          <X size={18} />
        </button>
      </form>
      {results && (
        <ul className="chat-list tele-find-list">
          {results.map((c) => {
            const canOpen = c.kind === 'private' || c.joined;
            return (
              <li key={c.tgChatId || c.invite} className="chat-item">
                <Avatar id={avatarNum(c.tgChatId)} name={c.title} />
                <div className="chat-item-body">
                  <div className="row">
                    <span className="title">{c.title || c.username || 'بدون نام'}</span>
                  </div>
                  <div className="row">
                    <span className="preview">
                      {/* «،» not «·»: a middle dot reads like the Persian zero next to digits. */}
                      {c.bot ? 'ربات' : KIND_NAME[c.kind]}
                      {c.username && (
                        <>
                          {'، '}
                          <bdi dir="ltr">@{c.username}</bdi>
                        </>
                      )}
                      {c.memberCount != null ? `، ${toFa(c.memberCount)} عضو` : ''}
                      {c.needsApproval ? '، عضویت با تأیید مدیر' : ''}
                    </span>
                  </div>
                </div>
                {canOpen ? (
                  <button className="btn sm" disabled={busy} onClick={() => act(() => openTelegramChat(c.tgChatId))}>
                    <MessageSquare size={14} /> {c.kind === 'private' ? 'پیام' : 'باز کردن'}
                  </button>
                ) : (
                  <button className="btn sm primary" disabled={busy} onClick={() => act(() => joinTelegramChat(c.invite ? { invite: c.invite } : { tgChatId: c.tgChatId }))}>
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
export function TeleStatus({ status }) {
  const u = status.usage;
  const egress = status.runtime?.egress;
  const over = u && u.quotaMb > 0 && u.used >= u.quotaMb * 1048576;
  const down = status.runtime && !egress?.running;
  const t = status.traffic;
  const [dot, label] = down ? ['off', 'اتصال سرور به تلگرام قطع است'] : over ? ['off', 'سقف مصرف این ماه تمام شده'] : status.live ? ['on', 'وصل'] : ['', 'در حالت کم‌مصرف'];
  return (
    <span className="tele-status" title={down ? egress?.lastError || '' : t ? `این اتصال: دریافت ${formatSize(t.received)}، ارسال ${formatSize(t.sent)}` : ''}>
      <span className={`tele-dot ${dot}`} />
      <span className={dot === 'off' ? 'tele-warn' : ''}>{label}</span>
      {u && (
        <small className="muted">
          {formatSize(u.used)}
          {u.quotaMb > 0 ? ` از ${formatSize(u.quotaMb * 1048576)}` : ''}
        </small>
      )}
    </span>
  );
}
