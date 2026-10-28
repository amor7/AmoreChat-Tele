import { io } from 'socket.io-client';
import { useStore } from './store';
import { api } from './api';
import { messagePreview } from './util';
import { callEvents, restoreCall, leave, onSpeakChanged } from './rtc';
import { ensureLatest } from './update';
import { isAndroidApp } from './native';
import { flushOutbox } from './offline';

let socket = null;

export function connectSocket() {
  if (socket) return;
  const st = useStore.getState;
  let connectedBefore = false;
  socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    useStore.setState({ connected: true, ping: null });
    flushOutbox();
    startPing();
    // After a reconnect, catch up on whatever we missed.
    if (connectedBefore) {
      // The server may have been updated while we were disconnected.
      api('GET', '/config')
        .then((c) => !st().rtc && ensureLatest(c.version))
        .catch(() => {});
      st().loadChats().catch(() => {});
      const active = st().activeChatId;
      if (active) st().loadMessages(active).catch(() => {});
    }
    // Voice presence and any call that survived a reload / reconnect.
    st()
      .loadVoice()
      .then((state) => !connectedBefore && state?.call && restoreCall(state.call))
      .catch(() => {})
      .finally(() => (connectedBefore = true));
  });
  socket.on('disconnect', (reason) => {
    useStore.setState({ connected: false });
    // Server-side disconnect means we were banned or logged out elsewhere.
    if (reason === 'io server disconnect') checkSession();
  });
  socket.on('connect_error', (err) => {
    useStore.setState({ connected: false });
    if (err.message === 'unauthorized') checkSession();
  });

  socket.on('message:new', async (m) => {
    // First message of a private chat the other person just started: it isn't in the list yet.
    if (!st().chats[m.chatId]) {
      const r = await api('GET', `/chats/${m.chatId}`).catch(() => null);
      if (r?.chat?.myRole || r?.chat?.type === 'dm') st().upsertChat(r.chat);
    }
    st().addMessage(m);
    notify(m);
  });
  socket.on('message:edit', (m) => st().updateMessage(m));
  socket.on('message:delete', (d) => st().markDeleted(d));
  socket.on('chat:new', (c) => st().upsertChat(c));
  socket.on('folders:changed', () => st().loadFolders().catch(() => {}));
  socket.on('chat:removed', ({ chatId, reason }) => {
    const title = st().chats[chatId]?.title;
    st().removeChat(chatId);
    if (title && reason !== 'left') st().showToast(reason === 'deleted' ? `«${title}» حذف شد` : `شما از «${title}» حذف شدید`);
  });
  socket.on('chat:changed', ({ chatId }) => st().refreshChat(chatId));
  socket.on('read', (d) => st().onRead(d));
  socket.on('typing', (d) => st().setTyping(d));
  socket.on('presence', (d) => st().setPresence(d));
  socket.on('voice:state', (d) => st().setVoiceRoom(d));
  socket.on('voice:channels', () => st().loadVoice().catch(() => {}));
  socket.on('call:incoming', callEvents.incoming);
  socket.on('call:accepted', callEvents.accepted);
  socket.on('call:handled', callEvents.handled);
  socket.on('call:ended', callEvents.ended);
  socket.on('rtc:notice', (n) => {
    st().showToast(n.text);
    if ((n.action === 'kick' || n.action === 'end') && st().rtc?.chatId === n.chatId) leave();
  });
  socket.on('rtc:speak', (d) => onSpeakChanged(d));
  socket.on('rtc:hand', ({ chatId, name }) => {
    beep();
    st().showToast(`✋ ${name} دست بلند کرد${st().rtc?.chatId === chatId ? '' : ` (${st().chats[chatId]?.title || ''})`}`);
  });
  // Server health alert (admins): toast now; the details are in Saved Messages and the dashboard.
  socket.on('server:alert', ({ text }) => st().showToast(text));
  socket.on('emergency', (m) => m.sender?.id !== st().me?.id && useStore.setState({ emergency: m }));
}

export function disconnectSocket() {
  socket?.disconnect();
  socket = null;
  clearInterval(pingTimer);
}

// Round-trip time to the server, smoothed. Faster sampling during calls.
let pingTimer = 0;
let lastPing = 0;
function measurePing() {
  const st = useStore.getState();
  if (!socket?.connected) return useStore.setState({ ping: null });
  // Hidden tab: one sample after connecting, then pause (unless in a call).
  if (document.hidden && !st.rtc && st.ping != null) return;
  const interval = st.rtc ? 2000 : 5000;
  if (Date.now() - lastPing < interval - 100) return;
  lastPing = Date.now();
  const t = performance.now();
  socket.timeout(8000).emit('rtt', Date.now(), (err) => {
    const ms = err ? 9999 : Math.round(performance.now() - t);
    const prev = useStore.getState().ping;
    const ping = prev == null || err ? ms : Math.round(prev * 0.5 + ms * 0.5);
    useStore.setState({ ping });
    trackWeak(ms);
  });
}
// Weak connection: 3 slow samples in a row (or the browser says 2G) switch the app to
// low-data mode automatically; 3 good samples switch it back.
let slow = 0;
let fast = 0;
function trackWeak(ms) {
  const conn = navigator.connection;
  const verySlow = conn && /(^|-)2g$/.test(conn.effectiveType || '');
  if (ms > 700 || verySlow) {
    slow++;
    fast = 0;
  } else if (ms < 350) {
    fast++;
    slow = 0;
  }
  const s = useStore.getState();
  if (!s.netWeak && slow >= 3) {
    useStore.setState({ netWeak: true });
    if (s.prefs.autoSaver !== false) s.showToast('اینترنت ضعیف است؛ حالت کم‌مصرف خودکار روشن شد');
  } else if (s.netWeak && fast >= 3) {
    useStore.setState({ netWeak: false });
  }
}

function startPing() {
  clearInterval(pingTimer);
  lastPing = 0;
  measurePing();
  pingTimer = setInterval(measurePing, 1000);
}

// "typing…" at most every 2.5 s per chat; sending a message starts over, so typing the next
// message right after shows at once again (it used to stay silent for a quick follow-up).
const lastTyping = new Map();
export function emitTyping(chatId) {
  if (Date.now() - (lastTyping.get(chatId) || 0) < 2500) return;
  lastTyping.set(chatId, Date.now());
  socket?.emit('typing', { chatId });
}
export const resetTyping = (chatId) => lastTyping.delete(chatId);

async function checkSession() {
  try {
    await api('GET', '/auth/me');
    setTimeout(() => socket?.connect(), 2000);
  } catch (e) {
    if (e.status === 401) location.reload();
  }
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.25);
  } catch {
    /* audio not allowed yet */
  }
}

export const isChatMuted = (chat) => !!chat?.notifyMutedUntil && chat.notifyMutedUntil > Date.now();

function notify(m) {
  const s = useStore.getState();
  if (!m.sender || m.sender.id === s.me?.id) return;
  if (!document.hidden && s.activeChatId === m.chatId) return;
  // A muted chat stays silent unless the message @mentions me or replies to me.
  const mentioned = m.mentions?.includes(s.me?.id);
  if (isChatMuted(s.chats[m.chatId]) && !mentioned) return;
  // In the Android app the system notification (with its own sound) covers the background.
  if (isAndroidApp && document.hidden) return;
  beep();
  if (!document.hidden) {
    const c = s.chats[m.chatId];
    const who = c?.type === 'dm' || c?.type === 'channel' ? c?.title : `${c?.title || ''} — ${m.sender.displayName}`;
    s.showToast(`💬 ${who}: ${messagePreview(m).slice(0, 80)}`);
  }
  if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const chat = s.chats[m.chatId];
  const title = (mentioned && chat?.type !== 'dm' ? '@ ' : '') + (chat?.type === 'dm' ? m.sender.displayName : chat?.type === 'channel' ? chat.title : `${chat?.title || ''} — ${m.sender.displayName}`);
  const opts = { body: messagePreview(m).slice(0, 120), tag: `chat-${m.chatId}`, icon: '/icon-192.png', data: { chatId: m.chatId } };
  navigator.serviceWorker?.ready
    .then((reg) => reg.showNotification(title, opts))
    .catch(() => new Notification(title, opts));
}
