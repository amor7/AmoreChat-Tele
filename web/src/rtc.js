// Voice rooms, 1:1 calls and streaming on top of LiveKit.
// livekit-client is loaded lazily so plain chat users never download it.
import { api } from './api';
import { useStore } from './store';
import { startRing, stopRing } from './sounds';
import { nativeInCall, takePendingAnswer } from './native';

let lk = null;
let room = null;
let audioBox = null;
let pttDown = false;
const watching = new Set(); // identities whose screen share we subscribed to

const st = useStore.getState;
const setRtc = (patch) => useStore.setState((s) => ({ rtc: s.rtc ? { ...s.rtc, ...patch } : null }));

async function loadLk() {
  lk ||= await import('livekit-client');
  return lk;
}

// Short side -> capture/encode settings for screen shares and cameras.
export const QUALITY = {
  480: { width: 854, height: 480, bitrate: { 15: 600_000, 30: 900_000, 60: 1_500_000 } },
  720: { width: 1280, height: 720, bitrate: { 15: 1_200_000, 30: 2_000_000, 60: 3_500_000 } },
  1080: { width: 1920, height: 1080, bitrate: { 15: 2_500_000, 30: 4_000_000, 60: 6_500_000 } },
};

export const canShareScreen = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
const meta = (p) => {
  try {
    return JSON.parse(p.metadata || '{}');
  } catch {
    return {};
  }
};

// ---------- State snapshot for React ----------
let raf = 0;
function refresh() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (!room) return;
    const { Track } = lk;
    const all = [room.localParticipant, ...room.remoteParticipants.values()];
    const participants = all.map((p) => {
      const pub = (src) => p.getTrackPublication(src);
      const mic = pub(Track.Source.Microphone);
      const cam = pub(Track.Source.Camera);
      const screen = pub(Track.Source.ScreenShare);
      return {
        identity: p.identity,
        userId: Number(p.identity.slice(1)),
        name: p.name || p.identity,
        avatar: meta(p).avatar || null,
        isLocal: p === room.localParticipant,
        speaking: p.isSpeaking,
        micOn: !!mic && !mic.isMuted,
        camera: cam && !cam.isMuted ? cam : null,
        screen: screen && !screen.isMuted ? screen : null,
        watching: watching.has(p.identity),
        quality: p.connectionQuality,
      };
    });
    const lp = room.localParticipant;
    setRtc({
      participants,
      micOn: lp.isMicrophoneEnabled,
      camOn: lp.isCameraEnabled,
      screenOn: lp.isScreenShareEnabled,
      canPlayAudio: room.canPlaybackAudio,
    });
  });
}

// ---------- Subscriptions: audio + cameras always, screen shares only when watched ----------
function applySubscription(pub, participant) {
  if (!room || participant === room.localParticipant || st().rtc?.kind === 'call') return;
  const { Track } = lk;
  const screen = pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio;
  pub.setSubscribed(!screen || watching.has(participant.identity));
}

export function watchStream(identity, on = true) {
  if (!room) return;
  if (on) watching.add(identity);
  else watching.delete(identity);
  const p = room.remoteParticipants.get(identity);
  p?.trackPublications.forEach((pub) => applySubscription(pub, p));
  refresh();
}

let lastWeak = false;
useStore.subscribe((s) => {
  const weak = s.netWeak && s.prefs.autoSaver !== false;
  if (weak === lastWeak) return;
  lastWeak = weak;
  if (!room || !lk) return;
  room.remoteParticipants.forEach((p) =>
    p.trackPublications.forEach((pub) => pub.kind === 'video' && pub.setVideoQuality(weak ? lk.VideoQuality.LOW : lk.VideoQuality.HIGH)),
  );
});

export function setStreamQuality(pub, level) {
  const { VideoQuality } = lk;
  pub?.setVideoQuality({ low: VideoQuality.LOW, medium: VideoQuality.MEDIUM, high: VideoQuality.HIGH }[level]);
}

// ---------- Per-person volume (0–200%), remembered on this device, like Discord ----------
const VOL_KEY = 'amorechat:volumes';
let volumes = {};
try {
  volumes = JSON.parse(localStorage.getItem(VOL_KEY) || '{}');
} catch {
  /* storage unavailable */
}
export const getVolume = (userId, kind = 'voice') => volumes[userId]?.[kind] ?? 1;

function applyVolume(p) {
  if (!lk || !p || p === room?.localParticipant) return;
  const id = Number(p.identity.slice(1));
  const off = !!st().rtc?.deafened;
  p.setVolume(off ? 0 : getVolume(id, 'voice'), lk.Track.Source.Microphone);
  p.setVolume(off ? 0 : getVolume(id, 'stream'), lk.Track.Source.ScreenShareAudio);
}

export function setVolume(userId, kind, value) {
  volumes[userId] = { ...volumes[userId], [kind]: value };
  try {
    localStorage.setItem(VOL_KEY, JSON.stringify(volumes));
  } catch {
    /* ignore */
  }
  applyVolume(room?.remoteParticipants.get(`u${userId}`));
  useStore.setState({ volumesVersion: Date.now() });
}

function attachAudio(track) {
  if (track.kind !== 'audio') return;
  if (!audioBox) {
    audioBox = document.createElement('div');
    audioBox.hidden = true;
    document.body.appendChild(audioBox);
  }
  const el = track.attach();
  el.muted = !!st().rtc?.deafened;
  audioBox.appendChild(el);
}

function wire(r) {
  const E = lk.RoomEvent;
  r.on(E.TrackPublished, (pub, p) => {
    applySubscription(pub, p);
    refresh();
  });
  r.on(E.ParticipantConnected, (p) => {
    p.trackPublications.forEach((pub) => applySubscription(pub, p));
    refresh();
  });
  r.on(E.TrackSubscribed, (track, _pub, participant) => {
    attachAudio(track);
    applyVolume(participant);
    refresh();
  });
  r.on(E.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove());
    refresh();
  });
  r.on(E.ParticipantDisconnected, (p) => {
    watching.delete(p.identity);
    refresh();
  });
  for (const ev of [E.TrackMuted, E.TrackUnmuted, E.TrackUnpublished, E.LocalTrackPublished, E.LocalTrackUnpublished, E.ActiveSpeakersChanged, E.ConnectionQualityChanged, E.AudioPlaybackStatusChanged]) {
    r.on(ev, refresh);
  }
  r.on(E.Reconnecting, () => setRtc({ state: 'reconnecting' }));
  r.on(E.Reconnected, () => setRtc({ state: 'connected' }));
  r.on(E.Disconnected, () => {
    if (room === r) cleanup();
  });
}

// ---------- Connect / leave ----------
async function connect(session, token, { video = false, speak = true } = {}) {
  await leave();
  const { Room } = await loadLk();
  const r = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    publishDefaults: { simulcast: true, dtx: true, red: true },
    // Mix through Web Audio so a person's volume can go above 100%.
    webAudioMix: true,
  });
  room = r;
  wire(r);
  useStore.setState({
    rtc: { state: 'connecting', participants: [], micOn: false, camOn: false, screenOn: false, deafened: false, ptt: false, expanded: false, stage: null, hand: false, ...session },
  });
  try {
    await r.connect(wsUrl(), token, { autoSubscribe: session.kind === 'call' });
  } catch (e) {
    cleanup();
    throw new Error('اتصال به سرور صدا برقرار نشد' + (e?.message ? ` (${e.message})` : ''));
  }
  setRtc({ state: 'connected' });
  // Android app: keep the microphone and the call alive with the screen off.
  nativeInCall(true, session.title);
  r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => applySubscription(pub, p)));
  if (speak) {
    try {
      await r.localParticipant.setMicrophoneEnabled(true);
    } catch {
      st().showToast('به میکروفون دسترسی نیست؛ فقط می‌شنوید');
    }
  }
  if (video) await setCamera(true).catch(() => st().showToast('به دوربین دسترسی نیست'));
  refresh();
}

function cleanup() {
  const r = room;
  room = null;
  watching.clear();
  audioBox?.replaceChildren();
  window.removeEventListener('keydown', onPttKey);
  window.removeEventListener('keyup', onPttKey);
  useStore.setState({ rtc: null });
  nativeInCall(false);
  r?.removeAllListeners();
}

export async function leave() {
  const r = room;
  if (!r) return;
  cleanup();
  await r.disconnect().catch(() => {});
}

// Browsers (and the Android WebView) only allow the microphone and camera on a secure connection.
const NEED_HTTPS = 'تماس و ویس‌چت فقط با اتصال امن (https) کار می‌کند؛ پیام‌ها بدون آن هم کار می‌کنند. آدرس https همین سرور را باز کنید.';
function needSecure() {
  if (typeof window !== 'undefined' && !window.isSecureContext) throw new Error(NEED_HTTPS);
}

export async function joinVoice(chatId, { expanded = false } = {}) {
  needSecure();
  const chat = st().chats[chatId];
  const info = await api('POST', '/rtc/join', { chatId });
  await connect(
    { kind: 'room', chatId, title: chat?.title || '', canSpeak: info.canSpeak, canStream: info.canStream, streamQuality: info.streamQuality, streamFps: info.streamFps, stage: info.stage, hand: !!info.stage?.hand, expanded },
    info.token,
    { speak: info.canSpeak },
  );
}

// ✋ Raise / lower my hand in a stage voice chat.
export async function setHand(up) {
  const chatId = st().rtc?.chatId;
  if (!chatId) return;
  await api('POST', `/rtc/${chatId}/hand`, { up });
  setRtc({ hand: up });
}

// An admin let me speak (or took it back): reconnect with the new permissions.
export async function onSpeakChanged({ chatId, canSpeak, text }) {
  if (st().rtc?.chatId !== chatId) return;
  st().showToast(text);
  const expanded = st().rtc.expanded;
  await joinVoice(chatId, { expanded }).catch((e) => st().showToast(e.message));
  if (canSpeak) setRtc({ hand: false });
}

// ---------- Local controls ----------
export async function setMic(on) {
  await room?.localParticipant.setMicrophoneEnabled(on);
  refresh();
}

export async function setCamera(on) {
  if (!room) return;
  const q = QUALITY[Math.min(st().rtc?.streamQuality || 720, 720)];
  await room.localParticipant.setCameraEnabled(on, { resolution: { width: q.width, height: q.height, frameRate: 24 } });
  refresh();
}

let facing = 'user';
export async function flipCamera() {
  const pub = room?.localParticipant.getTrackPublication(lk.Track.Source.Camera);
  if (!pub?.videoTrack) return;
  facing = facing === 'user' ? 'environment' : 'user';
  await pub.videoTrack.restartTrack({ facingMode: facing });
}

// The browser shows its own picker: whole screen, a window, or a tab.
export async function startScreenShare({ quality, fps, audio }) {
  if (!room) return;
  const q = QUALITY[quality] || QUALITY[720];
  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      { audio, resolution: { width: q.width, height: q.height, frameRate: fps }, contentHint: fps >= 30 ? 'motion' : 'detail', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include' },
      { videoEncoding: { maxBitrate: q.bitrate[fps] || q.bitrate[30], maxFramerate: fps }, simulcast: true },
    );
  } catch (e) {
    if (e?.name !== 'NotAllowedError') st().showToast('اشتراک صفحه شروع نشد');
  }
  refresh();
}

export async function stopScreenShare() {
  await room?.localParticipant.setScreenShareEnabled(false);
  refresh();
}

export function setDeafened(on) {
  setRtc({ deafened: on });
  audioBox?.querySelectorAll('audio').forEach((el) => (el.muted = on));
  room?.remoteParticipants.forEach(applyVolume);
  if (on) setMic(false);
}

export async function enableAudioPlayback() {
  await room?.startAudio();
  refresh();
}

// Push-to-talk: hold Space (desktop) or the talk button (mobile) to speak.
function onPttKey(e) {
  if (e.code !== 'Space' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  e.preventDefault();
  const down = e.type === 'keydown';
  if (down === pttDown) return;
  pttDown = down;
  setMic(down);
}

export function setPtt(on) {
  setRtc({ ptt: on });
  window.removeEventListener('keydown', onPttKey);
  window.removeEventListener('keyup', onPttKey);
  if (on) {
    window.addEventListener('keydown', onPttKey);
    window.addEventListener('keyup', onPttKey);
    setMic(false);
  }
}

// ---------- 1:1 calls ----------
export async function startCall(peer, video) {
  if (st().call) return st().showToast('یک تماس در جریان است');
  needSecure();
  const { call } = await api('POST', '/calls', { userId: peer.id, video });
  useStore.setState({ call: { ...call, role: 'caller', peer, state: 'ringing' } });
  startRing('outgoing');
  try {
    await connect({ kind: 'call', callId: call.id, title: peer.displayName, canSpeak: true, canStream: st().me.limits?.canStream, streamQuality: st().me.limits?.streamQuality, streamFps: st().me.limits?.streamFps }, call.token, { video });
  } catch (e) {
    stopRing();
    api('POST', `/calls/${call.id}/end`).catch(() => {});
    useStore.setState({ call: null });
    throw e;
  }
}

export async function acceptCall() {
  const call = st().call;
  if (!call) return;
  needSecure();
  stopRing();
  const { call: info } = await api('POST', `/calls/${call.id}/accept`);
  useStore.setState({ call: { ...call, state: 'active' } });
  await connect({ kind: 'call', callId: call.id, title: call.peer.displayName, canSpeak: true, canStream: st().me.limits?.canStream, streamQuality: st().me.limits?.streamQuality, streamFps: st().me.limits?.streamFps }, info.token, { video: call.video });
}

export async function declineCall() {
  const call = st().call;
  stopRing();
  useStore.setState({ call: null });
  if (call) await api('POST', `/calls/${call.id}/decline`).catch(() => {});
}

export async function hangUp() {
  const call = st().call;
  stopRing();
  useStore.setState({ call: null });
  // Tell the server first: leaving the room would otherwise end the call on its own.
  if (call) await api('POST', `/calls/${call.id}/end`).catch(() => {});
  await leave();
}

const END_TEXT = { missed: 'تماس بی‌پاسخ ماند', declined: 'تماس رد شد', cancelled: 'تماس لغو شد', ended: 'تماس پایان یافت', busy: 'مخاطب مشغول است' };

// Socket events (wired from socket.js).
export const callEvents = {
  incoming(call) {
    if (st().call) return; // already in a call: the server only rings idle users, but stay safe
    const peer = call.caller;
    useStore.setState({ call: { ...call, role: 'callee', peer, state: 'ringing' } });
    // "Answer" was already pressed on the Android notification.
    if (takePendingAnswer(call.id)) return acceptCall().catch((e) => st().showToast(e.message));
    startRing('incoming');
    if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      navigator.serviceWorker?.ready.then((reg) =>
        reg.showNotification(`${call.video ? '🎥' : '📞'} تماس از ${peer.displayName}`, { tag: `call-${call.id}`, requireInteraction: true, icon: '/icon-192.png' }),
      );
    }
  },
  accepted(call) {
    if (st().call?.id !== call.id) return;
    stopRing();
    useStore.setState({ call: { ...st().call, state: 'active', answeredAt: call.answeredAt } });
  },
  handled(call) {
    // Answered on another device of mine.
    if (st().call?.id === call.id && st().rtc?.callId !== call.id) {
      stopRing();
      useStore.setState({ call: null });
    }
  },
  async ended({ id, reason }) {
    if (st().call?.id !== id) return;
    stopRing();
    useStore.setState({ call: null });
    if (st().rtc?.callId === id) await leave();
    st().showToast(END_TEXT[reason] || END_TEXT.ended);
  },
};

// After a reload: ring again, or rejoin an active call.
export async function restoreCall(call) {
  if (!call || st().call) return;
  const peer = call.role === 'caller' ? call.callee : call.caller;
  if (call.state === 'ringing' && call.role === 'callee') return callEvents.incoming(call);
  useStore.setState({ call: { ...call, peer } });
  if (call.token) {
    await connect({ kind: 'call', callId: call.id, title: peer.displayName, canSpeak: true }, call.token, { video: call.video }).catch(() => hangUp());
  }
}
