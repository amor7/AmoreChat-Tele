import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, upload, CANCELLED } from '../api';
import { useStore, dataSaverNow } from '../store';
import { emitTyping, resetTyping, isChatMuted } from '../socket';
import { enqueue, flushOutbox } from '../offline';
import { EmojiPicker, RichText } from './Emoji';
import PreviewIcon from './PreviewIcon';
import Avatar from './Avatar';
import { Pencil, Reply, X, Paperclip, SendHorizontal, Mic, FileText, Smile, Bell, BellOff } from 'lucide-react';
import { postBlockReason, messagePreview, compressImage, imageSize, formatSize, formatClock, toFa, computeWaveform } from '../util';

const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export default function Composer({ chat, droppedFile, onDroppedHandled }) {
  const me = useStore((s) => s.me);
  const replyTo = useStore((s) => s.replyTo);
  const editing = useStore((s) => s.editing);
  const showToast = useStore((s) => s.showToast);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [recording, setRecording] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Insert at the cursor (not just at the end) and keep typing from there.
  function insertEmoji(ch) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + ch + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + ch.length, start + ch.length);
    });
  }
  const inputRef = useRef(null);
  const sendChain = useRef(Promise.resolve());
  const fileRef = useRef(null);
  const mention = useMentions(chat, text, inputRef);

  useEffect(() => {
    if (editing) {
      setText(editing.text);
      inputRef.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);
  // Text shared into the Android app lands in the message box.
  const draft = useStore((s) => (s.draftText?.chatId === chat.id ? s.draftText.text : null));
  useEffect(() => {
    if (draft == null) return;
    setText(draft);
    useStore.setState({ draftText: null });
    inputRef.current?.focus();
  }, [draft]);
  useEffect(() => {
    if (droppedFile) {
      setPending(droppedFile);
      onDroppedHandled();
    }
  }, [droppedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-grow the textarea.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    el.style.overflowY = el.scrollHeight > 160 ? 'auto' : 'hidden';
  }, [text]);

  const blocked = postBlockReason(me, chat);
  // Channel subscribers: like Telegram, the bottom bar is one Mute / Unmute button.
  if (blocked && chat.type === 'channel') return <ChannelMuteBar chat={chat} />;
  if (blocked) return <div className="composer blocked">{blocked}</div>;

  // Like Telegram: the box empties at once (the keyboard stays open) and the chat jumps to the
  // end; sends go out one after another so quick messages keep their order.
  function send() {
    const t = text.trim();
    if (!t) return;
    const edit = editing;
    const reply = replyTo;
    if (edit && busy) return;
    setText('');
    resetTyping(chat.id);
    useStore.setState({ replyTo: null, editing: null, ...(edit ? {} : { sentAt: Date.now() }) });
    inputRef.current?.focus();
    setBusy(true);
    sendChain.current = sendChain.current.then(async () => {
      try {
        if (edit) {
          const { message } = await api('PATCH', `/messages/${edit.id}`, { text: t });
          useStore.getState().updateMessage(message);
        } else if (!useStore.getState().connected) {
          // Offline: it goes into the outbox and is sent when the connection is back.
          await enqueue(chat.id, t, reply?.id);
          flushOutbox();
        } else {
          const { message } = await api('POST', `/chats/${chat.id}/messages`, { text: t, replyTo: reply?.id });
          useStore.getState().addMessage(message);
        }
      } catch (e) {
        if (!e.status && !edit) {
          await enqueue(chat.id, t, reply?.id).catch(() => {});
        } else {
          showToast(e.message);
          // Not sent: give the text back (unless something new was typed meanwhile).
          setText((cur) => cur || t);
          if (edit || reply) useStore.setState({ editing: edit, replyTo: reply });
        }
      }
      useStore.setState({ sentAt: edit ? useStore.getState().sentAt : Date.now() });
    });
    sendChain.current.finally(() => setBusy(false));
  }

  function onKeyDown(e) {
    if (mention.onKeyDown(e, (t) => setText(t))) return;
    if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape') {
      useStore.setState({ replyTo: null, editing: null });
      if (editing) setText('');
    }
  }

  function onPaste(e) {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) {
      e.preventDefault();
      setPending(f);
    }
  }

  const bar = editing || replyTo;
  return (
    <div className="composer-wrap">
      {bar && (
        <div className="composer-bar">
          <span className="bar-icon">{editing ? <Pencil size={20} /> : <Reply size={20} />}</span>
          <span className="bar-body">
            <b>{editing ? 'ویرایش پیام' : `پاسخ به ${replyTo.sender?.displayName || ''}`}</b>
            <span className="preview">
              <PreviewIcon m={bar} />
              <RichText text={messagePreview(bar)} size={16} />
            </span>
          </span>
          <button
            className="icon-btn"
            aria-label="لغو"
            onClick={() => {
              useStore.setState({ replyTo: null, editing: null });
              if (editing) setText('');
            }}
          >
            <X size={20} />
          </button>
        </div>
      )}
      {mention.list.length > 0 && (
        <ul className="mention-list" role="listbox">
          {mention.list.map((u, i) => (
            <li key={u.id}>
              <button
                className={i === mention.index ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(mention.apply(u));
                }}
              >
                <Avatar id={u.id} name={u.displayName} file={u.avatar} size={30} />
                <b>{u.displayName}</b>
                <small dir="ltr">@{u.username}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer">
        {text.trim() || editing ? (
          <button
            className="send-btn"
            aria-label="ارسال"
            disabled={!text.trim()}
            // Keep the focus (and the phone keyboard) in the text box.
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
          >
            <SendHorizontal size={20} />
          </button>
        ) : (
          <button className="send-btn mic" aria-label="ضبط پیام صوتی" onClick={() => setRecording(true)}>
            <Mic size={21} />
          </button>
        )}
        {!editing && (
          <button className="icon-btn" aria-label="پیوست" onClick={() => fileRef.current.click()}>
            <Paperclip size={22} />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) setPending(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          dir="auto"
          placeholder="پیام…"
          value={text}
          maxLength={4000}
          onChange={(e) => {
            setText(e.target.value);
            if (!editing) emitTyping(chat.id);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="emoji-anchor">
          <button className="icon-btn" aria-label="ایموجی" onClick={() => setEmojiOpen((v) => !v)}>
            <Smile size={22} />
          </button>
          {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
        </div>
      </div>
      {recording && <VoiceRecorder chat={chat} onDone={() => setRecording(false)} />}
      {pending && <SendFileDialog file={pending} chat={chat} onClose={() => setPending(null)} />}
    </div>
  );
}

// "@na" before the cursor -> suggest chat members; Tab/Enter picks, arrows move.
const membersCache = new Map();
function useMentions(chat, text, inputRef) {
  const [members, setMembers] = useState(membersCache.get(chat.id) || null);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(null);
  const el = inputRef.current;
  const caret = el?.selectionStart ?? text.length;
  const m = /(^|\s)@([A-Za-z0-9_]{0,32})$/.exec(text.slice(0, caret));
  const query = m && closed !== text ? m[2].toLowerCase() : null;
  const enabled = chat.type === 'group' || chat.type === 'channel' || chat.type === 'voice';
  const me = useStore((s) => s.me);

  useEffect(() => {
    if (query == null || !enabled || members) return;
    api('GET', `/chats/${chat.id}`)
      .then((r) => {
        membersCache.set(chat.id, r.members);
        setMembers(r.members);
      })
      .catch(() => {});
  }, [query != null, chat.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setMembers(membersCache.get(chat.id) || null), [chat.id]);
  useEffect(() => setIndex(0), [query]);

  const list =
    query == null || !members
      ? []
      : members
          .filter((u) => u.id !== me.id && (u.username.toLowerCase().startsWith(query) || u.displayName.toLowerCase().includes(query)))
          .slice(0, 6);

  const apply = (u) => {
    const before = text.slice(0, caret).replace(/@[A-Za-z0-9_]*$/, `@${u.username} `);
    const next = before + text.slice(caret);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
    return next;
  };
  const onKeyDown = (e, set) => {
    if (!list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      set(apply(list[index] || list[0]));
      return true;
    }
    if (e.key === 'Escape') {
      setClosed(text);
      return true;
    }
    return false;
  };
  return { list, index, apply, onKeyDown };
}

function pickAudioMime() {
  const options = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  return options.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

const MAX_VOICE_SECONDS = 15 * 60;

function VoiceRecorder({ chat, onDone }) {
  const replyTo = useStore((s) => s.replyTo);
  const showToast = useStore((s) => s.showToast);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [sending, setSending] = useState(false);
  const rec = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let stream;
    let timer;
    let raf;
    let audioCtx;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('ضبط صدا فقط روی HTTPS ممکن است');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const mimeType = pickAudioMime();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
        const chunks = [];
        recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.current = { recorder, chunks, stream };
        recorder.start(250);
        const start = Date.now();
        timer = setInterval(() => {
          const s = Math.floor((Date.now() - start) / 1000);
          setSeconds(s);
          if (s >= MAX_VOICE_SECONDS) finish(true);
        }, 250);
        // Live input level meter.
        audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        audioCtx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let max = 0;
          for (const v of buf) max = Math.max(max, Math.abs(v - 128));
          setLevel(max / 128);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        showToast(e.name === 'NotAllowedError' ? 'اجازه دسترسی به میکروفون داده نشد' : e.message);
        onDone();
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      cancelAnimationFrame(raf);
      audioCtx?.close();
      rec.current?.stream.getTracks().forEach((t) => t.stop());
      if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function finish(send) {
    const r = rec.current;
    if (!r) return onDone();
    if (!send) {
      r.recorder.stop();
      return onDone();
    }
    setSending(true);
    await new Promise((ok) => {
      r.recorder.onstop = ok;
      r.recorder.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
    if (blob.size < 1000) {
      onDone();
      return;
    }
    try {
      const { waveform, duration } = await computeWaveform(blob);
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const file = await upload(blob, { name: `voice.${ext}`, meta: { voice: 1, wave: waveform, dur: duration?.toFixed(2) } });
      const { message } = await api('POST', `/chats/${chat.id}/messages`, { fileId: file.id, type: 'voice', replyTo: replyTo?.id });
      useStore.getState().addMessage(message);
      useStore.setState({ replyTo: null, sentAt: Date.now() });
    } catch (e) {
      showToast(e.message);
    }
    onDone();
  }

  return (
    <div className="recorder">
      <button className="send-btn" aria-label="ارسال پیام صوتی" onClick={() => finish(true)} disabled={sending}>
        <SendHorizontal size={20} />
      </button>
      <div className="rec-status">
        <span className="rec-dot" style={{ transform: `scale(${1 + level * 1.5})` }} />
        <span>{sending ? 'در حال ارسال…' : formatClock(seconds)}</span>
      </div>
      <button className="btn danger" onClick={() => finish(false)} disabled={sending}>
        لغو
      </button>
    </div>
  );
}

function SendFileDialog({ file, chat, onClose }) {
  const replyTo = useStore((s) => s.replyTo);
  // Check the user's own limit up front instead of after uploading the whole file.
  // (Compressed images shrink before upload, so they are not blocked here.)
  const maxBytes = (useStore((s) => s.me.limits?.uploadMb) || 100) * 1024 * 1024;
  const isImage = /^image\/(jpeg|png|webp|gif|avif)$/.test(file.type);
  const isVideo = file.type.startsWith('video/');
  const [compress, setCompress] = useState(true);
  const tooBig = file.size > maxBytes && !(isImage && compress);
  const videoProcessing = useStore((s) => s.config.videoProcessing);
  const [videoQ, setVideoQ] = useState(() => (dataSaverNow() ? '360' : '720'));
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const uploadedRef = useRef(null); // file already on the server (only the message post failed)
  useEffect(() => {
    uploadedRef.current = null;
  }, [compress, videoQ]);
  const abort = useRef(null);
  const [preview] = useState(() => (isImage || isVideo ? URL.createObjectURL(file) : null));

  useEffect(() => () => preview && URL.revokeObjectURL(preview), [preview]);
  // Closing the dialog mid-upload also cancels it.
  useEffect(() => () => abort.current?.abort(), []);

  async function send() {
    setError('');
    setProgress(0);
    abort.current = new AbortController();
    try {
      let blob = file;
      let meta = {};
      let type = 'file';
      if (isImage && compress) {
        const c = await compressImage(file);
        blob = c.blob;
        meta = { w: c.width, h: c.height };
        type = 'image';
      } else if (isImage) {
        meta = await imageSize(file);
        meta = { w: meta.width, h: meta.height };
      } else if (isVideo) {
        type = 'video';
        meta = { q: videoQ };
      }
      const name = isImage && compress ? file.name.replace(/\.\w+$/, '') + '.jpg' : file.name;
      const uploaded =
        uploadedRef.current ||
        (await upload(blob, { name, meta, onProgress: setProgress, onStatus: (st) => setWaiting(st === 'waiting'), signal: abort.current.signal }));
      uploadedRef.current = uploaded;
      const { message } = await api('POST', `/chats/${chat.id}/messages`, {
        fileId: uploaded.id,
        type,
        text: caption.trim(),
        replyTo: replyTo?.id,
      });
      useStore.getState().addMessage(message);
      useStore.setState({ replyTo: null, sentAt: Date.now() });
      onClose();
    } catch (e) {
      setProgress(null);
      setWaiting(false);
      if (e.status === CANCELLED) return;
      setError(e.message);
    } finally {
      abort.current = null;
    }
  }

  // Portal: the composer bar uses backdrop-filter, which would otherwise trap this
  // "fixed" overlay inside the bar (half of it ended up below the screen).
  return createPortal(
    <div className="modal-backdrop" onClick={() => progress === null && onClose()}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <h3>ارسال {isImage ? 'عکس' : isVideo ? 'ویدیو' : 'فایل'}</h3>
        {isImage && <img className="send-preview" src={preview} alt="" />}
        {isVideo && <video className="send-preview" src={preview} controls muted playsInline />}
        {!isImage && !isVideo && (
          <div className="file-card">
            <span className="file-icon">
              <FileText size={20} />
            </span>
            <span>
              <span className="file-name">{file.name}</span>
              <small>{formatSize(file.size)}</small>
            </span>
          </div>
        )}
        {isImage && (
          <div className="segmented">
            <button className={compress ? 'active' : ''} onClick={() => setCompress(true)}>
              فشرده (کم‌حجم)
            </button>
            <button className={!compress ? 'active' : ''} onClick={() => setCompress(false)}>
              کیفیت اصلی ({formatSize(file.size)})
            </button>
          </div>
        )}
        {isVideo && videoProcessing && (
          <>
            <div className="segmented">
              {[
                ['360', 'کم‌حجم (360p)'],
                ['720', 'متوسط (720p)'],
                ['original', 'اصلی'],
              ].map(([q, label]) => (
                <button key={q} className={videoQ === q ? 'active' : ''} onClick={() => setVideoQ(q)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="hint">
              حجم فایل: {formatSize(file.size)}. سرور نسخه‌های کم‌حجم‌تر را می‌سازد تا گیرنده هم بتواند کیفیت را انتخاب کند.
              {videoQ !== 'original' && ' نسخه اصلی نگه داشته نمی‌شود.'}
            </p>
          </>
        )}
        {isVideo && !videoProcessing && <p className="hint">حجم: {formatSize(file.size)}</p>}
        <input placeholder="توضیح (اختیاری)" value={caption} onChange={(e) => setCaption(e.target.value)} dir="auto" maxLength={4000} />
        {progress !== null && (
          <div className="progress">
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
            <span>{toFa(Math.round(progress * 100))}٪</span>
          </div>
        )}
        {waiting && <p className="hint upload-waiting">اتصال قطع شد؛ با برگشتن اینترنت ارسال از همان‌جا ادامه پیدا می‌کند…</p>}
        {error && <div className="error">{error}</div>}
        <div className="actions">
          {progress !== null ? (
            <button className="btn danger" onClick={() => abort.current?.abort()}>
              لغو ارسال
            </button>
          ) : (
            <button className="btn" onClick={onClose}>
              انصراف
            </button>
          )}
          <button className="btn primary" onClick={send} disabled={progress !== null || tooBig}>
            ارسال
          </button>
        </div>
        {tooBig && (
          <div className="error">
            حجم این فایل ({formatSize(file.size)}) از حد مجاز شما ({formatSize(maxBytes)}) بیشتر است. برای افزایش با مدیر تماس بگیرید.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ChannelMuteBar({ chat }) {
  const [busy, setBusy] = useState(false);
  const muted = isChatMuted(chat);
  async function toggle() {
    setBusy(true);
    try {
      const r = await api('PATCH', `/chats/${chat.id}/notify`, { mutedUntil: muted ? null : -1 });
      useStore.getState().upsertChat({ ...chat, notifyMutedUntil: r.notifyMutedUntil });
    } catch (e) {
      useStore.getState().showToast(e.message);
    }
    setBusy(false);
  }
  return (
    <div className="composer-wrap">
      <button className="channel-mute-bar" onClick={toggle} disabled={busy}>
        {muted ? <Bell size={19} /> : <BellOff size={19} />}
        {muted ? 'صدادار کردن' : 'بی‌صدا کردن'}
      </button>
    </div>
  );
}
