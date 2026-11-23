import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { api, upload, CANCELLED, LATE } from '../api';
import { useStore, dataSaverNow } from '../store';
import { emitTyping, resetTyping, isChatMuted } from '../socket';
import { enqueue, enqueueVoice, flushOutbox, newClientId } from '../offline';
import { loadDraft, clearDraft } from '../drafts';
import { useDraftSaver } from '../useDrafts';
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
  const uid = me?.id || 0;
  // What was being written here last time (kept on this device, see drafts.js).
  const [text, setText] = useState(() => loadDraft(uid, 'chat', chat.id));
  const saver = useDraftSaver(uid, 'chat', chat.id);
  const editMode = useRef(false); // the box holds a message being edited, not the draft
  const sendsInFlight = useRef(0); // sent text stays the draft until the server (or outbox) has it
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

  // Keep the draft. Declared before the editing effect on purpose (effects run in order): on the
  // render that leaves edit mode the box is still empty, and that must not erase the draft.
  useEffect(() => {
    if (editing || editMode.current) return;
    if (!text.trim() && sendsInFlight.current) return saver.cancel();
    saver.set(text);
  }, [text, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editing) {
      // The draft being typed is saved as is; the box shows the message being edited.
      if (!editMode.current) saver.flush();
      editMode.current = true;
      setText(editing.text);
      inputRef.current?.focus();
    } else if (editMode.current) {
      // Edit finished or cancelled: the draft comes back.
      editMode.current = false;
      setText(loadDraft(uid, 'chat', chat.id));
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);
  // Text shared into the Android app lands in the message box.
  const draft = useStore((s) => (s.draftText?.chatId === chat.id ? s.draftText.text : null));
  useEffect(() => {
    if (draft == null) return;
    // Added after what was already written there, not in its place.
    setText((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n${draft}` : draft));
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
    if (!edit) {
      // Until it is sent or queued, the text stays saved: a crash meanwhile doesn't lose it.
      saver.set(t);
      saver.flush();
      sendsInFlight.current++;
    }
    const chatId = chat.id;
    const settled = (delivered) => {
      if (edit) return;
      sendsInFlight.current--;
      // Only if the stored draft is still this text (not something typed since).
      if (delivered && loadDraft(uid, 'chat', chatId) === t) clearDraft(uid, 'chat', chatId);
    };
    setText('');
    resetTyping(chat.id);
    useStore.setState({ replyTo: null, editing: null, ...(edit ? {} : { sentAt: Date.now() }) });
    inputRef.current?.focus();
    setBusy(true);
    const clientId = newClientId();
    sendChain.current = sendChain.current.then(async () => {
      try {
        if (edit) {
          const { message } = await api('PATCH', `/messages/${edit.id}`, { text: t });
          useStore.getState().updateMessage(message);
        } else if (!useStore.getState().connected) {
          // Offline: it goes into the outbox and is sent when the connection is back.
          await enqueue(chat.id, t, reply?.id, clientId);
          flushOutbox();
        } else {
          const { message } = await api('POST', `/chats/${chat.id}/messages`, { text: t, replyTo: reply?.id, clientId });
          useStore.getState().addMessage(message);
        }
        settled(true);
      } catch (e) {
        if (!e.status && !edit) {
          await enqueue(chat.id, t, reply?.id, clientId).then(
            () => settled(true),
            () => settled(false),
          );
        } else {
          settled(false);
          showToast(e.message);
          if (edit) {
            // Back into edit mode with the text as the user changed it (the draft stays aside).
            useStore.setState({ editing: { ...edit, text: t } });
          } else {
            // Not sent: give the text back (unless something new was typed meanwhile).
            setText((cur) => cur || t);
            if (reply) useStore.setState({ replyTo: reply });
          }
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

  // A finished recording: into the outbox (kept on this device until sent), so the recorder
  // closes at once and nothing waits on the network here.
  async function onVoice(v) {
    const reply = replyTo?.id ?? null;
    useStore.setState({ replyTo: null, sentAt: Date.now() });
    const clientId = newClientId();
    try {
      await enqueueVoice({ chatId: chat.id, blob: v.blob, duration: v.duration, waveform: v.waveform, replyTo: reply, clientId });
      flushOutbox();
    } catch (e) {
      // Queue full or storage refused: send it directly; on failure it stays in memory with a retry.
      if (e.full) showToast(`${e.message}؛ این پیام مستقیم ارسال می‌شود`);
      const item = { id: clientId, chatId: chat.id, ...v, replyTo: reply, clientId, fileId: null, error: null, sending: false };
      setDirect((list) => [...list, item]);
      sendVoiceDirect(item);
    }
  }

  const bar = editing || replyTo;
  return (
    <div className="composer-wrap">
      <DirectVoices chatId={chat.id} />
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
      {recording && <VoiceRecorder onRecorded={onVoice} onDone={() => setRecording(false)} />}
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
  const enabled = chat.type === 'group' || chat.type === 'voice';
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

function VoiceRecorder({ onRecorded, onDone }) {
  const showToast = useStore((s) => s.showToast);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [sending, setSending] = useState(false);
  const rec = useRef(null);
  const done = useRef(false);

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
        const start = Date.now();
        rec.current = { recorder, chunks, stream, start };
        recorder.start(250);
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

  // Hands the recording over and closes; sending happens elsewhere (see onVoice), so this never
  // stays stuck on "sending…" over a slow link. Guarded: the time limit calls it on every tick.
  async function finish(send) {
    if (done.current) return;
    done.current = true;
    const r = rec.current;
    if (!r) return onDone();
    if (!send) {
      if (r.recorder.state === 'recording') r.recorder.stop();
      return onDone();
    }
    setSending(true);
    try {
      await new Promise((ok) => {
        r.recorder.onstop = ok;
        if (r.recorder.state === 'recording') r.recorder.stop();
        else ok();
      });
      r.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) return;
      // Some WebViews never finish decoding: the waveform is a nicety, not worth waiting for.
      const elapsed = (Date.now() - r.start) / 1000;
      const wave = await Promise.race([computeWaveform(blob), new Promise((ok) => setTimeout(() => ok({ waveform: null, duration: null }), 5000))]);
      onRecorded({ blob, waveform: wave.waveform, duration: wave.duration || elapsed });
    } catch (e) {
      showToast(e.message);
    } finally {
      onDone();
    }
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

// Voices that couldn't be kept in the outbox (queue full, storage refused): sent straight away,
// and when that fails kept in memory with "send again / delete" so a recording is never lost
// without the user knowing. Module level: survives switching chats (not a reload).
let directVoices = []; // { id, chatId, blob, duration, waveform, replyTo, clientId, fileId, error, sending }
const directListeners = new Set();
const directAborts = new Map();
function setDirect(fn) {
  directVoices = fn(directVoices);
  directListeners.forEach((l) => l());
}
const subscribeDirect = (l) => {
  directListeners.add(l);
  return () => directListeners.delete(l);
};
const patchDirect = (id, patch) => setDirect((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));

async function sendVoiceDirect(v) {
  patchDirect(v.id, { sending: true, error: null });
  const ac = new AbortController();
  directAborts.set(v.id, ac);
  try {
    let fileId = directVoices.find((x) => x.id === v.id)?.fileId;
    if (!fileId) {
      const type = v.blob.type || '';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const file = await upload(v.blob, { name: `voice.${ext}`, meta: { voice: 1, wave: v.waveform, dur: v.duration?.toFixed(2) }, signal: ac.signal });
      fileId = file.id;
      patchDirect(v.id, { fileId }); // a retry only posts the message
    }
    // Same clientId on every try: a post whose answer got lost isn't made twice.
    const { message } = await api('POST', `/chats/${v.chatId}/messages`, { fileId, type: 'voice', replyTo: v.replyTo, clientId: v.clientId });
    useStore.getState().addMessage(message);
    useStore.setState({ sentAt: Date.now() });
    setDirect((list) => list.filter((x) => x.id !== v.id));
  } catch (e) {
    if (e.status === CANCELLED) return;
    patchDirect(v.id, { sending: false, error: e.message });
    // A lost answer may mean it was sent: look at the chat first (the message itself says so).
    useStore.getState().showToast(e.message === LATE ? `پیام صوتی: ${LATE}` : `پیام صوتی ارسال نشد: ${e.message} — «ارسال دوباره» را بزنید`);
  } finally {
    directAborts.delete(v.id);
  }
}

function DirectVoices({ chatId }) {
  const all = useSyncExternalStore(subscribeDirect, () => directVoices);
  const list = all.filter((v) => v.chatId === chatId);
  if (!list.length) return null;
  return list.map((v) => (
    <div key={v.id} className="composer-bar voice-retry">
      <span className="bar-icon">
        <Mic size={20} />
      </span>
      <span className="bar-body">
        <b>{v.sending ? 'در حال ارسال پیام صوتی…' : 'پیام صوتی ارسال نشد'}</b>
        {v.error && <span className="preview">{v.error}</span>}
      </span>
      {!v.sending && (
        <button className="btn sm" onClick={() => sendVoiceDirect(v)}>
          ارسال دوباره
        </button>
      )}
      <button
        className="icon-btn"
        aria-label="حذف پیام صوتی"
        onClick={() => {
          if (!confirm('این پیام صوتی حذف شود؟')) return;
          directAborts.get(v.id)?.abort();
          setDirect((l) => l.filter((x) => x.id !== v.id));
        }}
      >
        <X size={20} />
      </button>
    </div>
  ));
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
