import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { asButton } from '../a11y';
import { colorFor, formatDay, formatTime, formatSize, copyText } from '../util';
import { downloadMedia } from '../teleApi';
import { avatarNum, captionOf, clockText, mediaKind, messageActions, safeFileName } from '../tele-rules';
import Avatar from './Avatar';
import Lightbox from './Lightbox';
import { Menu, MenuItem } from './Menu';
import { MediaCard, MediaIcon, progressLine, saveUrl, useMediaDownload } from './MediaCard';
import { Copy, Download, FileText, Film, Forward, MoreVertical, Play, Reply, TextSelect, X } from 'lucide-react';

// One Telegram message in the open chat (or in search results), with its photo / voice / file
// and its actions. The actions open from a tap or a long-press on the bubble (phones), a right-
// click or the hover buttons (desktop), or the «کارهای پیام» button (keyboard).

// Taps on these open them, not the message menu.
const INTERACTIVE = 'button, a, input, textarea, select, audio, video, [role="button"]';
const LONG_PRESS_MS = 450;
const TAP_MS = 350;
const TAP_SLOP = 10;

/**
 * The download of a message's photo / voice / file. A photo, a voice and a playable video stay in
 * memory to show (until the chat closes); any other file is saved and let go at once, as before.
 * open(): what a tap does (show / play / save); save(): the menu's «دانلود» (always a file).
 */
function useTeleMedia(m, kind) {
  const f = m.file;
  const playable = kind === 'file' && !!f.video && /^video\/(mp4|webm)$/.test(f.mime || '');
  const size = (kind === 'photo' ? m.photo.size : kind === 'voice' ? m.voice.size : kind === 'file' ? f.size : 0) || 0;
  const dl = useMediaDownload((o) => downloadMedia(m.id, kind, { ...o, inline: playable }), size);
  const [src, setSrc] = useState(null);
  const [autoPlay, setAutoPlay] = useState(false);
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  const ref = m.tgMsgId || m.id;
  // Telegram's file name is the sender's choice: no folders or hidden-file dots when saving it.
  const name = kind === 'photo' ? `telegram-${ref}.jpg` : kind === 'voice' ? `telegram-voice-${ref}.ogg` : safeFileName(f?.name);
  const keeps = kind === 'photo' || kind === 'voice' || playable;
  const open = async ({ save = false } = {}) => {
    if (src) {
      if (save) saveUrl(src, name);
      return;
    }
    const blob = await dl.start();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    if (keeps) {
      // A tap plays the voice at once; a download from the menu only saves it.
      setAutoPlay(!save);
      setSrc(url);
    }
    if (save || !keeps) saveUrl(url, name);
    if (!keeps) setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  return { ...dl, src, autoPlay, open, save: () => open({ save: true }), playable, name, size };
}

function TeleMessage({ m, grouped, showSender, showAvatar, withDate, allowMedia, allowVoice, allowFiles, onReply, onJump, onForward, onCancel }) {
  const mine = m.direction === 'out';
  const queued = m.kind === 'queued';
  const allow = { allowMedia, allowVoice, allowFiles };
  const kind = mediaKind(m, allow);
  const media = useTeleMedia(m, kind);
  const [menu, setMenu] = useState(null); // { x, y }
  const [viewing, setViewing] = useState(false);
  const showToast = useStore((s) => s.showToast);
  // Not sent yet: no reply or forward (it has no Telegram id).
  if (queued) {
    onReply = null;
    onForward = null;
  }
  const has = { reply: !!onReply, forward: !!onForward, copy: true, select: true, download: true, cancel: !!onCancel };
  const actions = messageActions(m, { canReply: !!onReply, ...allow }).filter((a) => has[a]);
  const text = captionOf(m, allow);

  // ---- Opening the menu: tap / long-press (touch), right-click, the menu button ----
  const press = useRef(null);
  const touch = useRef(null); // { x, y, at } of the finger, while it may still be a tap
  const pressedAt = useRef(0);
  const touchedAt = useRef(0); // the last raw touch: its click is not a screen reader's
  const textRef = useRef(null);
  const [selecting, setSelecting] = useState(false);
  const own = (e) => e.currentTarget.contains(e.target); // not from the lightbox (a portal)
  const onControl = (e) => !!e.target.closest?.(INTERACTIVE);
  const hasSelection = () => !!String(window.getSelection?.() || '');
  // The user is selecting text (natively, or after «انتخاب متن»): no long-press menu over it.
  // Listening only while a press is pending: one listener per bubble on a long chat costs a
  // getSelection() per bubble on every selection change.
  useEffect(() => () => {
    clearTimeout(press.current);
    if (press.stop) document.removeEventListener('selectionchange', press.stop);
  }, []);
  const endPress = () => {
    clearTimeout(press.current);
    if (press.stop) document.removeEventListener('selectionchange', press.stop);
  };
  const openAt = (x, y) => actions.length && setMenu({ x, y });
  const onContextMenu = (e) => {
    if (!own(e) || !actions.length) return;
    e.preventDefault();
    // Android fires its own contextmenu right after our long-press timer: once is enough.
    if (Date.now() - pressedAt.current < 1500) return;
    openAt(e.clientX, e.clientY);
  };
  const onTouchStart = (e) => {
    if (!own(e) || e.touches.length > 1) return;
    const t = e.touches[0];
    touchedAt.current = Date.now();
    touch.current = onControl(e) ? null : { x: t.clientX, y: t.clientY, at: Date.now() };
    clearTimeout(press.current);
    // A selection is active (handles showing): the finger is adjusting it, not asking for the menu.
    if (selecting || hasSelection()) {
      touch.current = null;
      return;
    }
    if (!press.stop) press.stop = () => hasSelection() && endPress();
    document.addEventListener('selectionchange', press.stop);
    press.current = setTimeout(() => {
      document.removeEventListener('selectionchange', press.stop);
      pressedAt.current = Date.now();
      touch.current = null;
      navigator.vibrate?.(12);
      openAt(t.clientX, t.clientY);
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e) => {
    const t = e.touches[0];
    const start = touch.current;
    if (start && t && Math.abs(t.clientX - start.x) < TAP_SLOP && Math.abs(t.clientY - start.y) < TAP_SLOP) return;
    endPress();
    touch.current = null;
  };
  const onTouchEnd = (e) => {
    endPress();
    // Lifting the finger after a long-press must not "click" whatever is under it now.
    if (Date.now() - pressedAt.current < 1500) {
      e.preventDefault();
      return;
    }
    const start = touch.current;
    touch.current = null;
    // A short tap on the bubble itself (not its photo, player or buttons), like Telegram.
    touchedAt.current = Date.now();
    if (!start || !own(e) || Date.now() - start.at > TAP_MS) return;
    if (hasSelection()) return;
    e.preventDefault();
    openAt(start.x, start.y);
  };
  // A click that came from neither a finger nor a mouse: a screen reader (TalkBack, VoiceOver)
  // activating the bubble, or a switch device. Mouse clicks (detail >= 1) select text as usual.
  const onClick = (e) => {
    if (!own(e) || onControl(e) || e.detail > 0 || Date.now() - touchedAt.current < 800) return;
    const r = e.currentTarget.getBoundingClientRect();
    openAt(r.left, r.bottom);
  };
  // Double-click replies, but not on the photo, a player or a button (a double tap there would
  // start and cancel a download, or reply by accident).
  const onDoubleClick = (e) => {
    if (!own(e) || onControl(e)) return;
    onReply?.(m);
  };
  // «انتخاب متن»: make the text selectable and select all of it; the handles adjust it.
  const selectText = () => {
    setSelecting(true);
    requestAnimationFrame(() => {
      const el = textRef.current;
      const sel = window.getSelection?.();
      if (!el || !sel) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    });
  };
  useEffect(() => {
    if (!selecting) return;
    // Done once the selection is gone (a tap elsewhere, or copied and dismissed).
    const end = () => !hasSelection() && setSelecting(false);
    const t = setTimeout(() => document.addEventListener('selectionchange', end), 300);
    return () => {
      clearTimeout(t);
      document.removeEventListener('selectionchange', end);
    };
  }, [selecting]);
  const fromButton = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openAt(r.left, r.bottom);
  };

  const act = async (a) => {
    setMenu(null);
    if (a === 'reply') onReply(m);
    else if (a === 'forward') onForward(m);
    else if (a === 'copy') (await copyText(text)) && showToast('کپی شد');
    else if (a === 'select') selectText();
    else if (a === 'download') media.save();
    else if (a === 'cancel') onCancel(m);
  };

  return (
    <div className={`msg-row ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`} id={m.tgMsgId ? `tm-${m.tgMsgId}` : undefined}>
      {showAvatar && <div className="msg-avatar">{!grouped && <Avatar id={avatarNum(m.senderId)} name={m.senderName} size={34} />}</div>}
      <div className="bubble-col">
        <div
          className={`bubble ${kind === 'photo' ? 'has-media' : ''} ${selecting ? 'selecting' : ''}`}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchMove}
        >
          {showSender && m.senderName && (
            <div className="sender" style={{ color: colorFor(avatarNum(m.senderId)) }}>
              {m.senderName}
            </div>
          )}
          {m.replyTo && (
            <button className="reply-quote" onClick={() => onJump?.(m.replyTo.tgMsgId)}>
              <b>{m.replyTo.senderName || 'پیام'}</b>
              <span>{m.replyTo.text || '…'}</span>
            </button>
          )}
          {kind === 'photo' && <TelePhoto m={m} media={media} onView={() => setViewing(true)} />}
          {kind === 'voice' && <TeleVoice m={m} media={media} />}
          {kind === 'file' && <TeleFile m={m} media={media} />}
          {text && (
            <div ref={textRef} className={`text ${m.kind !== 'text' && kind !== 'photo' ? 'tele-media' : ''}`} dir="auto">
              {text}
            </div>
          )}
          <div className="meta">
            <span>{withDate ? `${formatDay(m.createdAt)} ${formatTime(m.createdAt)}` : formatTime(m.createdAt)}</span>
          </div>
          {/* Not sent: why, and what can be done. The server has no retry or delete for a failed
              message (DELETE only takes back a queued one), so it says what to do instead. */}
          {m.kind === 'failed' && (
            <div className="tele-msg-state failed">
              <b>ارسال نشد</b>
              <span>این پیام به تلگرام نرسید. متن را کپی کنید و دوباره بفرستید.</span>
            </div>
          )}
          {queued && (
            <div className="tele-msg-state queued">
              <b>در صف ارسال</b>
              <span>تلگرام الان وصل نیست؛ با وصل شدن خودش فرستاده می‌شود.</span>
              {onCancel && (
                <button className="link-btn" onClick={() => onCancel(m)}>
                  لغو ارسال
                </button>
              )}
            </div>
          )}
          {/* Hover buttons (desktop). The reply button stays the first .msg-more: tele-e2e uses it. */}
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
          {actions.length > 0 && (
            <button className={`msg-more msg-menu-btn ${onForward ? '' : 'alone'}`} aria-label="کارهای پیام" aria-haspopup="menu" aria-expanded={!!menu} title="کارهای پیام" onClick={fromButton}>
              <MoreVertical size={17} />
            </button>
          )}
        </div>
      </div>
      {menu && <MessageMenu x={menu.x} y={menu.y} actions={actions} media={kind} downloading={media.state.status === 'loading'} onAction={act} onClose={() => setMenu(null)} />}
      {viewing && media.src && (
        <Lightbox
          src={media.src}
          portal
          onClose={() => setViewing(false)}
          download={
            <button
              className="dl-btn lightbox-dl"
              aria-label="دانلود"
              title="دانلود"
              onClick={(e) => {
                e.stopPropagation();
                saveUrl(media.src, media.name);
              }}
            >
              <span className="dl-icon">
                <Download size={18} />
              </span>
            </button>
          }
        />
      )}
    </div>
  );
}

// Memoized: a chat re-renders every few seconds (its check), its messages only when they change
// (mergeLatest keeps unchanged message objects; TeleChat's callbacks are stable).
export default memo(TeleMessage);

const DOWNLOAD_LABEL = { photo: 'دانلود عکس', voice: 'دانلود پیام صوتی', file: 'دانلود فایل' };
const ACTION = {
  reply: [Reply, 'پاسخ'],
  forward: [Forward, 'ارسال به چت داخلی'],
  copy: [Copy, 'کپی متن'],
  select: [TextSelect, 'انتخاب متن'],
  download: [Download, ''],
  cancel: [X, 'لغو ارسال'],
};

// The same floating menu as the app's own messages (ChatView's MessageMenu), at the finger.
function MessageMenu({ x, y, actions, media, downloading, onAction, onClose }) {
  // Ignore the touch that opened it (the finger lifting on the new backdrop).
  const openedAt = useRef(Date.now());
  const onBackdrop = (e) => {
    e?.preventDefault?.();
    if (Date.now() - openedAt.current > 450) onClose();
  };
  return (
    <Menu label="کارهای پیام" className="menu floating" anchor={{ x, y }} onClose={onClose} onBackdrop={onBackdrop} onContextMenu={(e) => e.preventDefault()}>
      {actions.map((a) => {
        const [Icon, label] = ACTION[a];
        return (
          // A download already running: shown, but not started twice.
          <MenuItem key={a} icon={<Icon size={17} />} danger={a === 'cancel'} disabled={a === 'download' && downloading} onClick={() => onAction(a)}>
            {a === 'download' ? (downloading ? 'در حال دانلود…' : DOWNLOAD_LABEL[media]) : label}
          </MenuItem>
        );
      })}
    </Menu>
  );
}

// The blurred preview Telegram sends with every photo; the full photo only when tapped (VPN
// traffic). Once loaded it shows in the bubble, and a tap opens it full screen.
function TelePhoto({ m, media, onView }) {
  const s = media.state;
  const ratio = m.photo.w && m.photo.h ? Math.min(Math.max(m.photo.h / m.photo.w, 0.4), 1.6) : 0.75;
  const tap = media.src ? onView : s.status === 'loading' ? media.cancel : () => media.open();
  const line =
    s.status === 'loading' ? (
      <>
        {progressLine(s)} — لغو
      </>
    ) : s.status === 'error' ? (
      <>
        {s.error} — <u>تلاش دوباره</u>
      </>
    ) : (
      `دانلود عکس${media.size ? ` (${formatSize(media.size)})` : ''}`
    );
  return (
    <div className={`tele-photo is-${s.status}`} style={{ aspectRatio: `1 / ${ratio}` }} {...asButton(tap)} aria-label={media.src ? 'باز کردن عکس' : undefined} aria-busy={s.status === 'loading' || undefined}>
      {media.src ? (
        <img src={media.src} alt="عکس" />
      ) : (
        <>
          {m.photo.mini ? <img className="blur" src={`data:image/jpeg;base64,${m.photo.mini}`} alt="" /> : <span className="tele-photo-empty" />}
          <span className="tele-photo-cta">
            <MediaIcon state={s} />
            <span>{line}</span>
          </span>
        </>
      )}
    </div>
  );
}

function TeleVoice({ m, media }) {
  if (media.src) return <audio className="tele-voice-audio" src={media.src} controls autoPlay={media.autoPlay} preload="auto" />;
  const d = m.voice.duration || 0;
  return (
    <MediaCard
      className="tele-voice"
      state={media.state}
      onStart={() => media.open()}
      onCancel={media.cancel}
      icon={<Play size={18} />}
      title="پیام صوتی"
      info={`${clockText(d)}${media.size ? `، ${formatSize(media.size)}` : ''}`}
      label="دانلود و پخش"
      doneText="آماده‌ی پخش"
    />
  );
}

function TeleFile({ m, media }) {
  const f = m.file;
  if (media.src) return <video className="tele-video" src={media.src} controls autoPlay={!!f.gif} loop={!!f.gif} muted={!!f.gif} playsInline />;
  const Icon = f.video ? Film : FileText;
  return (
    <MediaCard
      className="tele-file"
      state={media.state}
      onStart={() => media.open()}
      onCancel={media.cancel}
      icon={<Icon size={18} />}
      title={f.name}
      info={`${formatSize(f.size || 0)}${f.duration ? `، ${clockText(f.duration)}` : ''}`}
      label={media.playable ? 'دانلود و پخش' : 'دانلود'}
    />
  );
}
