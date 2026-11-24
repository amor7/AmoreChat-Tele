import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useDataSaver, dataSaverNow } from '../store';
import { formatDay, sameDay, toFa, faDigits, compressImage } from '../util';
import { chatMessages, searchChat, sendText, uploadMedia, cancelQueued as cancelQueuedApi, leaveDialog } from '../teleApi';
import { avatarNum, historyView, mergeLatest, mergeOlder } from '../tele-rules';
import Avatar from './Avatar';
import { loadDraft } from '../drafts';
import { useDraftSaver } from '../useDrafts';
import { HeaderMenu, MenuItem } from './Menu';
import TeleMessage from './TeleMessage';
import { EmptyState, ErrorState, SkeletonMessages } from './States';
import { confirmDialog, isolate } from '../confirm';
import { ArrowRight, Search, SendHorizontal, X, CircleMinus, Reply, ImagePlus, Mic, Trash2, Paperclip, DoorOpen, MessageSquare } from 'lucide-react';

// Periodic checks pause while the tab is in the background (no traffic, and the idle timer runs).
const visible = () => document.visibilityState !== 'hidden';

// ---------- An open chat ----------
export default function TeleChat({ dialog, onChanged, onRemove, allowMedia, allowVoice, allowFiles, allowExplore, mediaMaxMb, fileMaxMb }) {
  const [messages, setMessages] = useState(null);
  const [notice, setNotice] = useState('');
  // The first load failed: its reason and a retry instead of an endless "loading".
  const [loadError, setLoadError] = useState('');
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

  // One check at a time: on a slow link an answer can take longer than the interval, and
  // stacked requests only add load. The first load (and a retry) always goes.
  const fetching = useRef(false);
  const fetchLatest = async (first) => {
    if (fetching.current && !first) return;
    fetching.current = true;
    try {
      // Later checks ask TDLib for what it already received (local): no network traffic.
      const r = await chatMessages(dialog.id, { local: !first });
      setMessages((cur) => mergeLatest(first ? [] : cur, r.messages || []));
      setNotice(r.notice || '');
      setLoadError('');
      if (first) {
        setHasMore(r.hasMore !== false);
        onChanged();
      }
    } catch (e) {
      setNotice(e.message);
      // Only the first load decides what the history area shows; a failed check later keeps
      // the messages on screen (the notice line says what went wrong).
      if (first) setLoadError(e.message);
    } finally {
      fetching.current = false;
    }
  };
  const retry = () => {
    setLoadError('');
    setNotice('');
    fetchLatest(true);
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
      const r = await chatMessages(dialog.id, { before: oldest.tgMsgId });
      const older = r.messages || [];
      if (!older.length) {
        setHasMore(false);
        // Nothing added: no re-render consumes the saved scroll position, so drop it here.
        keepFrom.current = null;
      }
      setMessages((cur) => mergeOlder(cur, older));
    } catch (e) {
      keepFrom.current = null;
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
    setMessages((cur) => mergeOlder(cur, [message]));
    onChanged();
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      sent((await sendText(dialog.id, text, replyTo?.tgMsgId)).message);
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };
  const replyParam = () => (replyTo ? { replyTo: String(replyTo.tgMsgId) } : {});
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
      const body = new FormData();
      body.append('file', blob, name);
      const data = await uploadMedia(dialog.id, 'photo', body, { caption: draft.trim(), ...replyParam() }, { errorText: 'ارسال عکس ناموفق بود' });
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
      const body = new FormData();
      body.append('file', blob, `voice.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
      const data = await uploadMedia(dialog.id, 'voice', body, { duration: String(Math.max(1, Math.round(seconds))), ...replyParam() }, { errorText: 'ارسال پیام صوتی ناموفق بود' });
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
  // Stable callbacks: TeleMessage is memoized, a new function each render would re-render all.
  const forward = useCallback((m) => useStore.getState().openModal('teleToChat', { message: m }), []);
  const sendFile = async (file) => {
    if (!file) return;
    if (file.size > fileMaxMb * 1048576) return showToast(`حداکثر حجم فایل ${toFa(fileMaxMb)} مگابایت است`);
    setSending(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const data = await uploadMedia(dialog.id, 'file', body, { caption: draft.trim(), ...replyParam() }, { errorText: 'ارسال فایل ناموفق بود' });
      sent(data.message);
    } catch (e) {
      showToast(e.message);
    } finally {
      setSending(false);
    }
  };
  const cancelQueued = useCallback(
    async (m) => {
      try {
        await cancelQueuedApi(m.id);
        setMessages((cur) => (cur || []).filter((x) => x.id !== m.id));
      } catch (e) {
        showToast(e.message);
      }
    },
    [showToast],
  );

  const startReply = useCallback(
    (m) => {
      if (isChannel || !m.tgMsgId) return;
      setReplyTo(m);
      inputRef.current?.focus();
    },
    [isChannel],
  );
  const jumpTo = useCallback(
    (tgMsgId) => {
      const el = document.getElementById(`tm-${tgMsgId}`);
      if (!el) return showToast('این پیام در بخش بارگذاری‌شده نیست');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1200);
    },
    [showToast],
  );

  const search = async (e) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    try {
      setFound((await searchChat(dialog.id, q.trim())).messages || []);
    } catch (err) {
      showToast(err.message);
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQ('');
    setFound(null);
  };
  const leave = async () => {
    if (!(await confirmDialog({ title: `از ${dialog.title ? `«${isolate(dialog.title)}»` : 'این گفتگو'} در تلگرام خارج شوید؟`, message: 'عضویتتان در خود تلگرام هم برداشته می‌شود.', confirmLabel: 'خروج', danger: true }))) return;
    try {
      await leaveDialog(dialog.id);
      location.hash = '#/tele';
      onChanged?.();
    } catch (e) {
      showToast(e.message);
    }
  };

  const subtitle = isChannel ? 'کانال' : isGroup ? 'گروه' : dialog.username ? <bdi dir="ltr">@{dialog.username}</bdi> : 'گفتگوی خصوصی';
  const replyName = (m) => (m.direction === 'out' ? 'خودتان' : m.senderName || dialog.title);
  const view = historyView(messages, loadError);
  // Touch screens have no hover buttons: say once how to reach a message's actions.
  const tapHintSeen = useStore((st) => !!st.prefs.teleTapHint);
  const touch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  const showTapHint = touch && !tapHintSeen && view === 'list' && !found;

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
              <Avatar id={avatarNum(dialog.tgChatId)} name={dialog.title} size={40} />
              <div>
                <div className="title">{dialog.title || 'بدون نام'}</div>
                <div className="subtitle">{subtitle}</div>
              </div>
            </div>
            <button className="icon-btn" aria-label="جستجو در این گفتگو" title="جستجو در این گفتگو" onClick={() => setSearchOpen(true)}>
              <Search size={20} />
            </button>
            {(dialog.selected || (allowExplore && dialog.kind !== 'private')) && (
              <HeaderMenu>
                {dialog.selected && (
                  <MenuItem
                    icon={<CircleMinus size={17} />}
                    onClick={async () => (await confirmDialog({ title: `${dialog.title ? `«${isolate(dialog.title)}»` : 'این گفتگو'} از فهرست شما حذف شود؟`, message: 'در تلگرام چیزی پاک نمی‌شود.', confirmLabel: 'حذف', danger: true })) && onRemove()}
                  >
                    حذف از گفتگوهای من
                  </MenuItem>
                )}
                {allowExplore && dialog.kind !== 'private' && (
                  <MenuItem icon={<DoorOpen size={17} />} danger onClick={leave}>
                    خروج از این {dialog.kind === 'channel' ? 'کانال' : 'گروه'} در تلگرام
                  </MenuItem>
                )}
              </HeaderMenu>
            )}
          </>
        )}
        <a className="icon-btn back" href="#/tele" aria-label="بازگشت">
          <ArrowRight size={22} />
        </a>
      </header>
      {notice && view !== 'error' && <div className="tele-notice">{notice}</div>}
      {showTapHint && (
        <div className="tele-hint" role="note">
          <span className="grow">برای دیدن کارهای هر پیام، روی آن بزنید.</span>
          <button className="btn sm" onClick={() => useStore.getState().setPrefs({ teleTapHint: true })}>
            متوجه شدم
          </button>
        </div>
      )}

      {found ? (
        <div className="messages">
          <div className="day-sep">{found.length ? `${toFa(found.length)} نتیجه برای «${q.trim()}»` : `نتیجه‌ای برای «${q.trim()}» نیست`}</div>
          {found.map((m) => (
            <TeleMessage key={m.id} m={m} showSender={!isChannel} showAvatar={false} grouped={false} withDate allowMedia={allowMedia} allowVoice={allowVoice} allowFiles={allowFiles} onForward={forward} />
          ))}
        </div>
      ) : (
        <div className="messages" ref={listRef} onScroll={onScroll} aria-busy={view === 'loading' || undefined}>
          {loadingOlder && <div className="muted center pad">…</div>}
          {view === 'loading' && <SkeletonMessages />}
          {view === 'error' && <ErrorState message={loadError} onRetry={retry} />}
          {view === 'empty' && <EmptyState compact icon={<MessageSquare size={40} className="muted" />} title="هنوز پیامی نیست" hint={isChannel ? 'پست‌های تازه‌ی این کانال اینجا می‌آیند.' : 'اولین پیام را بنویسید.'} />}
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
                onClick={async () => (await confirmDialog({ title: 'این پیام صوتی حذف شود؟', confirmLabel: 'حذف', danger: true })) && setFailedVoice(null)}
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
  // The cap (maxSeconds) finishes from the timer set up at the start: through refs it sends with
  // what the chat has now (the reply chosen meanwhile), not what it had then.
  const handlers = useRef({ onSend, onCancel });
  handlers.current = { onSend, onCancel };
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
        handlers.current.onCancel();
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
    if (!r) return handlers.current.onCancel();
    await new Promise((ok) => {
      r.recorder.onstop = ok;
      if (r.recorder.state === 'recording') r.recorder.stop();
      else ok();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    if (!send) return handlers.current.onCancel();
    handlers.current.onSend(new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' }), (Date.now() - r.start) / 1000);
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
