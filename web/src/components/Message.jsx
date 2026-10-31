import { memo, useRef, useState } from 'react';
import { api, fileUrl } from '../api';
import { useStore } from '../store';
import { formatTime, formatDateTime, messagePreview, toFa, callSummary, formatSize, formatClock } from '../util';
import { startCall } from '../rtc';
import { EmojiImg, RichText, isBigEmoji } from './Emoji';
import PreviewIcon from './PreviewIcon';
import { Clock, AlertCircle, Hourglass, Forward, Timer, Pin, Check, CheckCheck, EllipsisVertical, PhoneMissed, PhoneOutgoing, PhoneIncoming, Phone, Video, ImageDown, Film, FileText, Download, Trash2 } from 'lucide-react';
import Avatar from './Avatar';
import { VoicePlayer, ImageMessage, VideoMessage, FileCard } from './Media';
import { MusicMessage } from './Music';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"،؛])/g;

// Links become anchors; emoji become Fluent images (large when the message is only 1-3 emoji).
function Linkify({ text, big }) {
  const parts = text.split(URL_RE);
  return parts.map((p, i) =>
    i % 2 ? (
      <a key={i} href={p} target="_blank" rel="noopener noreferrer" dir="ltr">
        {p}
      </a>
    ) : (
      <Mentions key={i} text={p} big={big} />
    ),
  );
}

const MENTION_RE = /((?<![\w@.])@[A-Za-z][A-Za-z0-9_]{2,31})/g;
function Mentions({ text, big }) {
  const parts = text.split(MENTION_RE);
  return parts.map((p, i) =>
    i % 2 ? (
      <span key={i} className="mention" dir="ltr">
        {p}
      </span>
    ) : (
      <RichText key={i} text={p} size={22} big={big} />
    ),
  );
}

// A photo of a mirrored Telegram channel not fetched yet: the first tap fetches it (through the
// server's VPN, once) and the post becomes an ordinary photo for everyone.
function PendingPhoto({ m }) {
  const [busy, setBusy] = useState(false);
  const p = m.pendingPhoto;
  const ratio = p.width && p.height ? Math.min(1.6, Math.max(0.5, p.height / p.width)) : 0.66;
  const load = async () => {
    setBusy(true);
    try {
      const r = await api('POST', `/mirror-photos/${m.id}`, {}, { timeout: 120000 });
      useStore.getState().updateMessage(r.message);
    } catch (e) {
      useStore.getState().showToast(e.message);
      setBusy(false);
    }
  };
  return (
    <button className="pending-photo" style={{ aspectRatio: `1 / ${ratio}` }} onClick={load} disabled={busy} aria-label="نمایش عکس">
      <ImageDown size={28} />
      <span>{busy ? 'در حال دریافت از تلگرام…' : `نمایش عکس${p.size ? ` (${toFa(Math.max(1, Math.round(p.size / 1024)))} KB)` : ''}`}</span>
    </button>
  );
}

// A mirrored channel's video or file not fetched yet: users the admin allowed fetch it (for everyone).
const PENDING_KIND = { video: 'ویدیو', audio: 'صدا', file: 'فایل' };
function PendingFile({ m }) {
  const [busy, setBusy] = useState(false);
  const may = useStore((s) => !!s.me?.mirrorFiles);
  const p = m.pendingFile;
  const Icon = p.kind === 'video' ? Film : FileText;
  const load = async () => {
    setBusy(true);
    try {
      const r = await api('POST', `/mirror-media/${m.id}`, {}, { timeout: 15 * 60000 });
      useStore.getState().updateMessage(r.message);
    } catch (e) {
      useStore.getState().showToast(e.message);
      setBusy(false);
    }
  };
  const info = [PENDING_KIND[p.kind] || 'فایل', p.size ? formatSize(p.size) : '', p.duration ? formatClock(p.duration) : ''].filter(Boolean).join(' · ');
  return (
    <div className="pending-file">
      <Icon size={26} />
      <span className="grow">
        <b dir="auto">{p.name || PENDING_KIND[p.kind]}</b>
        <small className="muted">{info}</small>
        {!may && <small className="muted">هنوز دریافت نشده؛ وقتی کسی که اجازه دارد آن را بگیرد، برای شما هم باز می‌شود.</small>}
      </span>
      {may && (
        <button className="btn sm" onClick={load} disabled={busy}>
          <Download size={14} /> {busy ? 'در حال دریافت…' : 'دریافت'}
        </button>
      )}
    </div>
  );
}

function Content({ m, mine }) {
  const f = m.file;
  if (!f && m.pendingPhoto && m.type !== 'deleted') return <PendingPhoto m={m} />;
  if (!f && m.pendingFile && m.type !== 'deleted') return <PendingFile m={m} />;
  if (!f) return null;
  if (f.purged)
    return (
      <div className="expired">
        <Hourglass size={16} /> این فایل منقضی و از سرور حذف شده است
      </div>
    );
  if (m.type === 'image') return <ImageMessage file={f} />;
  if (m.type === 'video') return <VideoMessage file={f} />;
  if (m.type === 'voice') return <VoicePlayer file={f} mine={mine} />;
  if (f.kind === 'audio') return <MusicMessage m={m} />;
  return <FileCard file={f} />;
}

// For moderators: where a group or channel message was deleted, and what it said.
export function DeletedNote({ m }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    try {
      setD(await api('GET', `/messages/${m.id}/deleted`));
    } catch (e) {
      useStore.getState().showToast(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="deleted-note">
      <div>
        <Trash2 size={14} /> پیام پاک شده
        {!d && (
          <button className="link" disabled={busy} onClick={show}>
            {busy ? '…' : 'نمایش'}
          </button>
        )}
      </div>
      {d && (
        <div className="deleted-body">
          <small className="muted">
            از {d.sender || '؟'}
            {d.senderUsername ? ` (@${d.senderUsername})` : ''} · پاک‌شده توسط {d.deletedBy || '؟'} · {formatDateTime(d.deletedAt)}
          </small>
          {d.text && <p dir="auto">{d.text}</p>}
          {d.file && (
            <a href={fileUrl(d.file.id)} target="_blank" rel="noreferrer" dir="auto">
              {d.file.name} ({formatSize(d.file.size)})
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Reactions({ m, meId }) {
  const showToast = useStore((s) => s.showToast);
  if (!m.reactions?.length) return null;
  const toggle = (emoji) =>
    api('POST', `/messages/${m.id}/react`, { emoji })
      .then((r) => useStore.getState().updateMessage(r.message))
      .catch((e) => showToast(e.message));
  return (
    <div className="reactions">
      {m.reactions.map((r) => (
        // Channels send anonymous counts (count + mine) instead of the list of users.
        <button key={r.emoji} className={`reaction ${(r.mine ?? r.users.includes(meId)) ? 'mine' : ''}`} onClick={() => toggle(r.emoji)}>
          <EmojiImg ch={r.emoji} size={19} />
          <span>{toFa(r.count ?? r.users.length)}</span>
        </button>
      ))}
    </div>
  );
}

function Message({ m, chat, mine, grouped, onJump, onMenu }) {
  const meId = useStore((s) => s.me.id);
  const press = useRef(null);
  const pressedAt = useRef(0);

  if (m.type === 'call') return <CallLog m={m} mine={mine} chat={chat} />;

  if (m.type === 'system') {
    return (
      <div className="system-msg" id={`msg-${m.id}`}>
        <span>{m.text}</span>
      </div>
    );
  }

  const showSender = !mine && chat.type === 'group' && !grouped;
  const showAvatar = !mine && chat.type === 'group';
  const ticks = mine && chat.type !== 'saved' && chat.type !== 'channel' ? (chat.othersRead >= m.id ? 'read' : 'sent') : '';
  const visual = ((m.type === 'image' || m.type === 'video') && !m.file?.purged) || !!m.pendingPhoto;
  const bigEmoji = m.type === 'text' && !m.replyTo && !m.forwardedFrom && isBigEmoji(m.text);

  const openMenu = (e) => {
    e.preventDefault();
    // Android fires its own contextmenu right after our long-press timer: opening the menu
    // a second time (or letting that event reach the new backdrop) made it vanish at once.
    if (e.type === 'contextmenu' && Date.now() - pressedAt.current < 1500) return;
    const p = e.touches?.[0] || e;
    onMenu(p.clientX, p.clientY);
  };
  // Long-press for touch screens.
  const touchStart = (e) => {
    const t = e.touches[0];
    clearTimeout(press.current);
    press.current = setTimeout(() => {
      pressedAt.current = Date.now();
      navigator.vibrate?.(12);
      onMenu(t.clientX, t.clientY);
    }, 450);
  };
  const touchEnd = (e) => {
    clearTimeout(press.current);
    // Lifting the finger after a long-press must not "click" whatever is under it now.
    if (e?.type === 'touchend' && Date.now() - pressedAt.current < 1500) e.preventDefault();
  };

  return (
    <div className={`msg-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`} id={`msg-${m.id}`}>
      {showAvatar && <div className="msg-avatar">{!grouped && <Avatar id={m.sender?.id} name={m.sender?.displayName} file={m.sender?.avatar} size={34} />}</div>}
      <div className="bubble-col">
        <div
          className={`bubble ${m.type === 'deleted' ? 'deleted' : ''} ${visual ? 'has-media' : ''} ${bigEmoji ? 'big-emoji' : ''} ${!mine && m.mentions?.includes(meId) ? 'mentions-me' : ''}`}
          onContextMenu={openMenu}
          onTouchStart={touchStart}
          onTouchEnd={touchEnd}
          onTouchMove={touchEnd}
          onDoubleClick={() => m.type !== 'deleted' && useStore.setState({ replyTo: m, editing: null })}
        >
          {showSender && <div className="sender">{m.sender?.displayName}</div>}
          {m.forwardedFrom && (
            <div className="forwarded">
              <Forward size={13} /> فوروارد از {m.forwardedFrom}
            </div>
          )}
          {m.replyTo && m.replyTo.type !== 'deleted' && (
            <button className="reply-quote" onClick={() => onJump(m.replyTo.id)}>
              <b>{m.replyTo.sender || 'پیام'}</b>
              <span>
                <PreviewIcon m={m.replyTo} />
                <RichText text={messagePreview(m.replyTo)} size={16} />
              </span>
            </button>
          )}
          {m.type === 'deleted' ? <i>این پیام حذف شد</i> : <Content m={m} mine={mine} />}
          {m.text && (
            <div className="text" dir="auto">
              <Linkify text={m.text} big={bigEmoji} />
            </div>
          )}
          <div className="meta">
            {m.expiresAt && <Timer size={12} aria-label="حذف خودکار" />}
            {m.pinned && <Pin size={12} />}
            {m.editedAt && <span>ویرایش‌شده</span>}
            <span>{formatTime(m.createdAt)}</span>
            {m.pending && <Clock size={13} aria-label="در صف ارسال" className="pending-icon" />}
            {m.failed && <AlertCircle size={14} aria-label="ارسال نشد" className="failed-icon" />}
            {ticks && !m.pending && !m.failed && <span className={`ticks ${ticks}`}>{ticks === 'read' ? <CheckCheck size={15} /> : <Check size={15} />}</span>}
          </div>
          <button className="msg-more" aria-label="گزینه‌ها" onClick={openMenu}>
            <EllipsisVertical size={18} />
          </button>
        </div>
        <Reactions m={m} meId={meId} />
      </div>
    </div>
  );
}

function CallLog({ m, mine, chat }) {
  const s = callSummary(m);
  const showToast = useStore((st) => st.showToast);
  return (
    <div className={`msg-row ${mine ? 'mine' : ''}`} id={`msg-${m.id}`}>
      <div className={`bubble call-log ${s.failed && !mine ? 'missed' : ''}`}>
        <span className="call-icon">{s.failed && !mine ? <PhoneMissed size={20} /> : mine ? <PhoneOutgoing size={20} /> : <PhoneIncoming size={20} />}</span>
        <span className="grow">
          <b>{s.label}</b>
          <small>{formatTime(m.createdAt)}</small>
        </span>
        {chat.peer && (
          <button className="icon-btn" title="تماس دوباره" onClick={() => startCall(chat.peer, !!s.video).catch((e) => showToast(e.message))}>
            {s.video ? <Video size={20} /> : <Phone size={20} />}
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(Message);
