import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, isUserOnline } from '../store';
import { api } from '../api';
import { formatDay, formatLastSeen, sameDay, toFa, hasChatPerm, hasSitePerm, canPostInChannel, messagePreview, copyText, QUICK_REACTIONS } from '../util';
import Avatar from './Avatar';
import Message, { DeletedNote } from './Message';
import Composer from './Composer';
import { VoiceBanner } from './Voice';
import { isStageAdmin } from './VoiceTools';
import { EmojiImg, EmojiPicker, RichText } from './Emoji';
import PreviewIcon from './PreviewIcon';
import { ArrowLeft, ChevronDown, Timer, Phone, Video, Mic, Search, Pin, PinOff, Reply, Forward, Copy, Pencil, Flag, Trash2, Plus, Eye, BellOff, Send } from 'lucide-react';
import { startCall, joinVoice } from '../rtc';
import { isChatMuted } from '../socket';
import { outboxMessage, retryOutbox, dropFromOutbox } from '../offline';
import { useBackClose } from '../backnav';

export default function ChatView({ chatId }) {
  const chat = useStore((s) => s.chats[chatId]);
  const messages = useStore((s) => s.messages[chatId]);
  const hasMore = useStore((s) => s.hasMore[chatId]);
  const hasNewer = useStore((s) => s.hasNewer[chatId]);
  const jumpTo = useStore((s) => s.jumpTo);
  const me = useStore((s) => s.me);
  const st = useStore.getState;
  const listRef = useRef(null);
  const atBottom = useRef(true);
  const olderAnchor = useRef(null);
  const pendingFlash = useRef(null);
  const loading = useRef(false);
  const [showDown, setShowDown] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [droppedFile, setDroppedFile] = useState(null);
  // Something shared into the Android app for this chat: open it in the send dialog.
  const pendingShare = useStore((s) => (s.pendingShare?.chatId === chatId ? s.pendingShare : null));
  useEffect(() => {
    if (!pendingShare) return;
    if (pendingShare.files[0]) setDroppedFile(pendingShare.files[0]);
    if (!pendingShare.files.length && pendingShare.text) useStore.setState({ draftText: { chatId, text: pendingShare.text } });
    useStore.setState({ pendingShare: null });
  }, [pendingShare]); // eslint-disable-line react-hooks/exhaustive-deps


  // Public voice channels are open to everyone: opening one joins it (like Discord).
  const publicVoice = useStore((s) => s.voiceChannels.some((c) => c.id === chatId && c.isPublic && !c.isMember));
  useEffect(() => {
    if (chat || !publicVoice) return;
    api('POST', `/chats/${chatId}/join`)
      .then(({ chat: joined }) => {
        st().upsertChat(joined);
        useStore.setState((s) => ({ voiceChannels: s.voiceChannels.map((c) => (c.id === chatId ? { ...c, isMember: true } : c)) }));
      })
      .catch((e) => st().showToast(e.message));
  }, [chatId, !!chat, publicVoice]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chat) return;
    // A search result may have asked to open this chat at a specific message.
    const target = st().jumpTo;
    if (target?.chatId === chatId) {
      useStore.setState({ jumpTo: null });
      goTo(target.messageId);
    } else {
      st().loadMessages(chatId).catch((e) => st().showToast(e.message));
    }
  }, [chatId, !!chat]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (jumpTo?.chatId === chatId && messages) {
      useStore.setState({ jumpTo: null });
      goTo(jumpTo.messageId);
    }
  }, [jumpTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep pinned to the bottom when new messages arrive, and keep position when older ones load.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (pendingFlash.current && flash(pendingFlash.current)) {
      pendingFlash.current = null;
    } else if (olderAnchor.current != null) {
      el.scrollTop = el.scrollHeight - olderAnchor.current;
      olderAnchor.current = null;
    } else if (atBottom.current && !hasNewer) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // I sent something: go to the latest message, wherever I was reading (like Telegram).
  const sentAt = useStore((s) => s.sentAt);
  useEffect(() => {
    if (sentAt && listRef.current) toBottom();
  }, [sentAt]); // eslint-disable-line react-hooks/exhaustive-deps

  // The list got shorter (phone keyboard opened, reply bar shown): stay at the bottom if I was there.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && !st().hasNewer[chatId]) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatId, !!messages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const mark =() => !document.hidden && !st().hasNewer[chatId] && st().markRead(chatId);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [chatId, messages?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onScroll() {
    const el = listRef.current;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = fromBottom < 120;
    setShowDown(fromBottom > 600 || !!st().hasNewer[chatId]);
    if (loading.current) return;
    if (el.scrollTop < 300 && hasMore) {
      loading.current = true;
      olderAnchor.current = el.scrollHeight - el.scrollTop;
      try {
        if (!(await st().loadMessages(chatId, true))) olderAnchor.current = null;
      } catch {
        olderAnchor.current = null;
      }
      loading.current = false;
    } else if (fromBottom < 300 && hasNewer) {
      loading.current = true;
      await st()
        .loadNewer(chatId)
        .catch(() => {});
      loading.current = false;
    }
  }

  function flash(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
    return true;
  }

  async function goTo(id) {
    if (flash(id)) return;
    pendingFlash.current = id;
    atBottom.current = false;
    try {
      await st().loadAround(chatId, id);
    } catch (e) {
      pendingFlash.current = null;
      st().showToast(e.message);
    }
  }

  async function toBottom() {
    if (st().hasNewer[chatId]) await st().loadMessages(chatId);
    atBottom.current = true;
    const el = listRef.current;
    el.scrollTop = el.scrollHeight;
    setShowDown(false);
  }

  if (!chat) {
    if (publicVoice) return <div className="empty-pane">در حال ورود به کانال…</div>;
    return (
      <div className="empty-pane">
        <p>این گفتگو در دسترس نیست.</p>
        <a className="btn" href="#/">
          بازگشت
        </a>
      </div>
    );
  }

  async function act(action, m, extra) {
    setMenu(null);
    try {
      if (action === 'react') st().updateMessage((await api('POST', `/messages/${m.id}/react`, { emoji: extra })).message);
      if (action === 'reply') useStore.setState({ replyTo: m, editing: null });
      if (action === 'edit') useStore.setState({ editing: m, replyTo: null });
      if (action === 'copy') (await copyText(m.text)) && st().showToast('کپی شد');
      if (action === 'forward') st().openModal('forward', { message: m });
      if (action === 'toTele') st().openModal('chatToTele', { message: m });
      if (action === 'readers') st().openModal('readers', { message: m });
      if (action === 'pin' || action === 'unpin') await api('POST', `/messages/${m.id}/pin`, { pinned: action === 'pin' });
      if (action === 'delete' && confirm(chat.type === 'dm' || chat.type === 'saved' ? 'این پیام برای همه حذف شود؟' : 'این پیام برای همه حذف شود؟ مدیران سرور تا مدتی می‌توانند اصل آن را ببینند.')) await api('DELETE', `/messages/${m.id}`);
      if (action === 'report') {
        const reason = prompt('دلیل گزارش این پیام (اختیاری):');
        if (reason !== null) {
          await api('POST', `/messages/${m.id}/report`, { reason });
          st().showToast('گزارش برای مدیران ارسال شد');
        }
      }
    } catch (e) {
      st().showToast(e.message);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) setDroppedFile(f);
  }

  const canPin = chat.type === 'dm' || chat.type === 'saved' || hasChatPerm(me, chat, 'pin_messages');
  const canDeleteOthers = hasChatPerm(me, chat, 'delete_messages');

  // A deleted message leaves no trace, except for moderators where its content is kept.
  const moderator = hasSitePerm(me, 'manage_chats');
  const shown = messages?.filter((m) => m.type !== 'deleted' || (moderator && m.kept));

  return (
    <div
      className="chat-view"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <ChatHeader chat={chat} />
      <VoiceBanner chat={chat} />
      <PinnedBar chat={chat} messages={messages} onJump={goTo} />
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {hasMore && messages?.length > 0 && <div className="muted center pad">…</div>}
        {!messages && <div className="muted center pad">در حال بارگذاری…</div>}
        {shown?.length === 0 && <div className="muted center pad">هنوز پیامی نیست. اولین پیام را بفرستید!</div>}
        {shown?.map((m, i) => {
          const prev = shown[i - 1];
          const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
          const grouped = !newDay && prev && prev.type !== 'system' && prev.sender?.id === m.sender?.id && m.createdAt - prev.createdAt < 5 * 60000;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-sep">{formatDay(m.createdAt)}</div>}
              {m.type === 'deleted' ? (
                <DeletedNote m={m} />
              ) : (
                <Message
                  m={m}
                  chat={chat}
                  mine={m.sender?.id === me.id}
                  grouped={grouped}
                  onJump={goTo}
                  onMenu={(x, y) => setMenu({ m, x, y })}
                />
              )}
            </Fragment>
          );
        })}
      </div>
      <Outbox chat={chat} me={me} />
      {(showDown || hasNewer) && (
        <button className="to-bottom" onClick={toBottom} aria-label="رفتن به آخرین پیام">
          <ChevronDown size={22} />
          {chat.unread > 0 && <span className="badge">{toFa(chat.unread)}</span>}
        </button>
      )}
      {menu && (
        <MessageMenu
          {...menu}
          mine={menu.m.sender?.id === me.id || (chat.type === 'channel' && canPostInChannel(chat) && menu.m.type !== 'call')}
          canPin={canPin}
          canDelete={menu.m.sender?.id === me.id || canDeleteOthers}
          canReport={menu.m.sender?.id !== me.id && chat.type !== 'saved' && !(chat.type === 'channel' && (chat.myRole === 'owner' || chat.myRole === 'admin'))}
          canReaders={(chat.type === 'group' || chat.type === 'channel') && (menu.m.sender?.id === me.id || chat.myRole === 'owner' || chat.myRole === 'admin')}
          onAction={(a, extra) => act(a, menu.m, extra)}
          onClose={() => setMenu(null)}
        />
      )}
      <Composer chat={chat} droppedFile={droppedFile} onDroppedHandled={() => setDroppedFile(null)} />
      {dragOver && <div className="drop-overlay">فایل را اینجا رها کنید</div>}
    </div>
  );
}

// Messages written offline: waiting (⏳) or refused by the server (tap to retry / delete).
function Outbox({ chat, me }) {
  const items = useStore((s) => s.outbox).filter((o) => o.chatId === chat.id);
  if (!items.length) return null;
  return (
    <div className="outbox">
      {items.map((o) => (
        <div
          key={o.tmpId}
          onClick={() => {
            if (!o.error) return;
            if (confirm(`ارسال نشد: ${o.error}\nدوباره تلاش شود؟ (لغو = حذف پیام)`)) retryOutbox(o.tmpId);
            else dropFromOutbox(o.tmpId);
          }}
        >
          <Message m={outboxMessage(o, me)} chat={chat} mine grouped={false} onJump={() => {}} onMenu={() => {}} />
        </div>
      ))}
    </div>
  );
}

function useTypers(chatId) {
  const typing = useStore((s) => s.typing[chatId]);
  const [, tick] = useState(0);
  const active = Object.values(typing || {}).filter((t) => t.until > Date.now());
  useEffect(() => {
    if (!active.length) return;
    const t = setTimeout(() => tick((n) => n + 1), 1000);
    return () => clearTimeout(t);
  });
  return active.map((t) => t.name);
}

function ChatHeader({ chat }) {
  const me = useStore((s) => s.me);
  const openModal = useStore((s) => s.openModal);
  const online = useStore((s) => isUserOnline(s, chat.peer));
  const typers = useTypers(chat.id);
  const rtcOn = useStore((s) => s.config.rtc);
  const canCall = useStore((s) => s.me.limits?.canCall);
  const inRoom = useStore((s) => s.rtc?.chatId === chat.id);
  const roomActive = useStore((s) => (s.voiceRooms[chat.id] || []).length > 0);
  const showToast = useStore((s) => s.showToast);
  const call = (video) => startCall(chat.peer, video).catch((e) => showToast(e.message));

  let subtitle = '';
  if (typers.length) subtitle = chat.type === 'dm' ? 'در حال نوشتن…' : `${typers.slice(0, 2).join('، ')} در حال نوشتن…`;
  else if (chat.type === 'dm') subtitle = online ? 'آنلاین' : formatLastSeen(chat.peer?.lastSeen);
  else if (chat.type === 'group' || chat.type === 'channel') subtitle = `${toFa(chat.memberCount)} ${chat.type === 'channel' ? 'مشترک' : 'عضو'}`;

  return (
    <header className="chat-head">
      <button className="chat-head-info" onClick={() => chat.type !== 'saved' && openModal('chatInfo', { chatId: chat.id })}>
        <Avatar id={chat.id} name={chat.title} file={chat.avatar} saved={chat.type === 'saved'} size={40} />
        <div>
          <div className="title">
            {chat.title} {chat.autoDelete > 0 && <Timer size={14} className="inline-icon" aria-label="حذف خودکار فعال است" />}
            {isChatMuted(chat) && <BellOff size={14} className="inline-icon muted-icon" aria-label="بی‌صدا" />}
          </div>
          <div className={`subtitle ${typers.length || (chat.type === 'dm' && online) ? 'accent' : ''}`}>{subtitle}</div>
        </div>
      </button>
      {rtcOn && chat.type === 'dm' && chat.peer && canCall && (
        <>
          <button className="icon-btn" aria-label="تماس صوتی" title="تماس صوتی" onClick={() => call(false)}>
            <Phone size={20} />
          </button>
          <button className="icon-btn" aria-label="تماس تصویری" title="تماس تصویری" onClick={() => call(true)}>
            <Video size={21} />
          </button>
        </>
      )}
      {rtcOn && (chat.type === 'group' || chat.type === 'channel') && !inRoom && !roomActive && (!chat.voiceStage || isStageAdmin(me, chat)) && (
        <button className="icon-btn" aria-label="شروع ویس‌چت" title="شروع ویس‌چت" onClick={() => joinVoice(chat.id).catch((e) => showToast(e.message))}>
          <Mic size={20} />
        </button>
      )}
      <button className="icon-btn" aria-label="جستجو در این گفتگو" onClick={() => openModal('search', { chatId: chat.id })}>
        <Search size={20} />
      </button>
      <a
        className="icon-btn back"
        href="#/"
        aria-label="بازگشت"
        onClick={(e) => {
          if (history.state?.fromList) {
            e.preventDefault();
            history.back();
          }
        }}
      >
        <ArrowLeft size={22} />
      </a>
    </header>
  );
}

function PinnedBar({ chat, messages, onJump }) {
  const version = useStore((s) => s.chatVersion[chat.id]);
  const [serverPinned, setServerPinned] = useState([]);

  useEffect(() => {
    api('GET', `/chats/${chat.id}/pinned`)
      .then((r) => setServerPinned(r.messages))
      .catch(() => {});
  }, [chat.id, version]);

  // Loaded messages are fresher than the initial fetch (they receive edit/pin events).
  const pinned = useMemo(() => {
    const byId = new Map(serverPinned.map((m) => [m.id, m]));
    for (const m of messages || []) byId.set(m.id, m);
    return [...byId.values()].filter((m) => m.pinned).sort((a, b) => b.id - a.id);
  }, [serverPinned, messages]);

  if (!pinned.length) return null;
  const top = pinned[0];
  return (
    <button className="pinned-bar" onClick={() => onJump(top.id)}>
      <span className="pin-icon">
        <Pin size={18} />
      </span>
      <span>
        <b>پیام سنجاق‌شده{pinned.length > 1 ? ` (${toFa(pinned.length)})` : ''}</b>
        <span className="preview">
          <PreviewIcon m={top} />
              <RichText text={messagePreview(top)} size={16} />
        </span>
      </span>
    </button>
  );
}

function MessageMenu({ m, x, y, mine, canPin, canDelete, canReport, canReaders, onAction, onClose: close }) {
  const ref = useRef(null);
  useBackClose(true, close);
  // Ignore the touch events that opened the menu (finger lifting, Android's own contextmenu).
  const openedAt = useRef(Date.now());
  const onClose = (e) => {
    e?.preventDefault?.();
    if (Date.now() - openedAt.current > 450) close();
  };
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    // Keep it on screen, also when it grows after opening (emoji images, the emoji picker).
    const place = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setPos({
        left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
      });
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    ro?.observe(ref.current);
    return () => ro?.disconnect();
  }, [x, y]);

  const [picker, setPicker] = useState(false);
  const deleted = m.type === 'deleted';
  if (picker) {
    return (
      <>
        <div className="menu-backdrop" onClick={onClose} />
        <div className="menu floating picker-host" ref={ref} style={pos}>
          <EmojiPicker onPick={(ch) => onAction('react', ch)} onClose={close} />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} onContextMenu={onClose} />
      <div className="menu floating" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
        {!deleted && (
          <div className="quick-reactions">
            {QUICK_REACTIONS.map((e) => (
              <button key={e} onClick={() => onAction('react', e)} aria-label={e}>
                <EmojiImg ch={e} size={28} />
              </button>
            ))}
            <button className="more-reactions" onClick={() => setPicker(true)} aria-label="ایموجی‌های بیشتر">
              <Plus size={20} />
            </button>
          </div>
        )}
        {!deleted && (
          <button onClick={() => onAction('reply')}>
            <Reply size={17} /> پاسخ
          </button>
        )}
        {!deleted && (
          <button onClick={() => onAction('forward')}>
            <Forward size={17} /> فوروارد
          </button>
        )}
        {!deleted && m.type !== 'call' && (
          <button onClick={() => onAction('toTele')}>
            <Send size={17} /> ارسال به تلگرام
          </button>
        )}
        {!deleted && m.text && (
          <button onClick={() => onAction('copy')}>
            <Copy size={17} /> کپی متن
          </button>
        )}
        {!deleted && canReaders && (
          <button onClick={() => onAction('readers')}>
            <Eye size={17} /> دیده‌شده توسط
          </button>
        )}
        {!deleted && mine && (
          <button onClick={() => onAction('edit')}>
            <Pencil size={17} /> ویرایش
          </button>
        )}
        {!deleted && canPin && (
          <button onClick={() => onAction(m.pinned ? 'unpin' : 'pin')}>
            {m.pinned ? <PinOff size={17} /> : <Pin size={17} />} {m.pinned ? 'برداشتن سنجاق' : 'سنجاق کردن'}
          </button>
        )}
        {!deleted && canReport && (
          <button onClick={() => onAction('report')}>
            <Flag size={17} /> گزارش
          </button>
        )}
        {!deleted && canDelete && (
          <button className="danger" onClick={() => onAction('delete')}>
            <Trash2 size={17} /> حذف
          </button>
        )}
      </div>
    </>
  );
}
