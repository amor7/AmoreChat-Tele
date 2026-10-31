// The music player: one audio element for the whole app, so a song keeps playing while moving
// between chats. The queue is the music of the chat it started in. State lives in the store as
// `music` (and `musicPos`, updated often, so only the seek bars redraw).
import { api, fileUrl } from './api';
import { useStore } from './store';
import { getPrefs, setPrefs } from './util';
import { claimPlayback } from './playback';

export const SPEEDS = [1, 1.25, 1.5, 2];
export const REPEATS = ['off', 'all', 'one'];
const MAX_PAGES = 5;
const native = window.AmoreAndroid;

const prefs = getPrefs();
const audio = new Audio();
audio.preload = 'auto';

const st = () => useStore.getState().music;
const put = (patch) => useStore.setState((s) => ({ music: s.music ? { ...s.music, ...patch } : null }));

/** Title and artist of a file: its tags, else "Artist - Title" in the file name, else the name. */
export function trackInfo(file) {
  const name = String(file.name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const split = name.match(/^(.{1,80}?) - (.+)$/);
  return { title: file.title || split?.[2] || name || 'بدون نام', artist: file.artist || (file.title ? '' : split?.[1] || '') };
}

const toTrack = (m) => ({ messageId: m.id, chatId: m.chatId, fileId: m.file.id, duration: m.file.duration || 0, thumb: !!m.file.thumb, ...trackInfo(m.file) });
const current = (s = st()) => s?.queue[s.order[s.at]];

// The play order: the chat's order, or shuffled with `first` (a queue index) up front.
function orderFor(length, shuffle, first) {
  const order = Array.from({ length }, (_, i) => i);
  if (!shuffle) return order;
  order.splice(first, 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return [first, ...order];
}

function start() {
  const t = current();
  if (!t) return;
  audio.src = fileUrl(t.fileId);
  audio.playbackRate = st().speed;
  useStore.setState({ musicPos: 0 });
  resume();
  announce();
}
function resume() {
  claimPlayback(audio);
  audio.play().catch(() => {});
}

/** Plays a music message (or pauses it if it is the one playing), with its chat as the queue. */
export async function playMessage(m) {
  const s = st();
  if (current(s)?.messageId === m.id) return toggle();
  const first = toTrack(m);
  useStore.setState({
    music: { queue: [first], order: [0], at: 0, playing: true, duration: first.duration, shuffle: !!prefs.musicShuffle, repeat: REPEATS.includes(prefs.musicRepeat) ? prefs.musicRepeat : 'off', speed: SPEEDS.includes(prefs.musicSpeed) ? prefs.musicSpeed : 1, sheet: s?.sheet || false },
  });
  start();
  // The rest of the chat's music, oldest first; playing goes on while it loads.
  const found = [];
  let before = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api('GET', `/chats/${m.chatId}/media?kind=music${before}`).catch(() => null);
    if (!r?.messages.length) break;
    found.push(...r.messages);
    before = `&before=${r.messages.at(-1).id}`;
  }
  if (current()?.messageId !== m.id || !found.some((x) => x.id === m.id)) return;
  const queue = found.filter((x) => x.file).map(toTrack).reverse();
  const index = queue.findIndex((t) => t.messageId === m.id);
  put({ queue, order: orderFor(queue.length, st().shuffle, index), at: st().shuffle ? 0 : index });
  announce();
}

export function toggle() {
  if (!st()) return;
  if (audio.paused) resume();
  else audio.pause();
}

function go(at) {
  put({ at });
  start();
}
export function next(auto = false) {
  const s = st();
  if (!s) return;
  if (auto && s.repeat === 'one') {
    audio.currentTime = 0;
    return resume();
  }
  if (s.at + 1 < s.order.length) return go(s.at + 1);
  if (s.repeat === 'all' || !auto) return go(0);
  put({ playing: false });
  audio.currentTime = 0;
  useStore.setState({ musicPos: 0 });
  announce();
}
export function prev() {
  const s = st();
  if (!s) return;
  if (audio.currentTime > 3) audio.currentTime = 0;
  else go(s.at > 0 ? s.at - 1 : s.order.length - 1);
}
export function playIndex(queueIndex) {
  const s = st();
  const at = s?.order.indexOf(queueIndex);
  if (at >= 0) go(at);
}
export function seek(sec) {
  if (Number.isFinite(sec)) audio.currentTime = sec;
  useStore.setState({ musicPos: sec });
  announce();
}
export function toggleShuffle() {
  const s = st();
  if (!s) return;
  const shuffle = !s.shuffle;
  const index = s.order[s.at];
  setPrefs({ musicShuffle: shuffle });
  put({ shuffle, order: orderFor(s.queue.length, shuffle, index), at: shuffle ? 0 : index });
}
export function cycleRepeat() {
  const s = st();
  if (!s) return;
  const repeat = REPEATS[(REPEATS.indexOf(s.repeat) + 1) % REPEATS.length];
  setPrefs({ musicRepeat: repeat });
  put({ repeat });
}
export function cycleSpeed() {
  const s = st();
  if (!s) return;
  const speed = SPEEDS[(SPEEDS.indexOf(s.speed) + 1) % SPEEDS.length];
  audio.playbackRate = speed;
  setPrefs({ musicSpeed: speed });
  put({ speed });
  announce();
}
export const pauseMusic = () => audio.pause();
export function closeMusic() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  useStore.setState({ music: null, musicPos: 0 });
  announce();
}

// The phone's lock screen and notification: Media Session in browsers, the app's service on Android.
function announce() {
  const s = st();
  const t = current(s);
  if (native?.music) {
    native.music(JSON.stringify(t ? { title: t.title, artist: t.artist, playing: !audio.paused, position: Math.round(audio.currentTime * 1000), duration: Math.round((audio.duration || t.duration || 0) * 1000), speed: s.speed } : {}));
  }
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.thumb ? [{ src: `${fileUrl(t.fileId)}?thumb=1`, type: 'image/jpeg' }] : [] }) : null;
  navigator.mediaSession.playbackState = !t ? 'none' : audio.paused ? 'paused' : 'playing';
}
if ('mediaSession' in navigator) {
  const on = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* not in this browser */
    }
  };
  on('play', resume);
  on('pause', () => audio.pause());
  on('nexttrack', () => next());
  on('previoustrack', prev);
  on('seekto', (d) => seek(d.seekTime));
}
// The buttons of the Android notification.
window.__amoreMusic = (cmd, ms) => ({ play: resume, pause: () => audio.pause(), next: () => next(), prev, seek: () => seek(ms / 1000), close: closeMusic })[cmd]?.();

audio.addEventListener('play', () => (put({ playing: true }), announce()));
audio.addEventListener('pause', () => (put({ playing: false }), announce()));
audio.addEventListener('ended', () => next(true));
audio.addEventListener('timeupdate', () => useStore.setState({ musicPos: audio.currentTime }));
audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration)) put({ duration: audio.duration });
  announce();
});
// A file that can't play (expired, deleted): the next one, unless it is the only one.
audio.addEventListener('error', () => {
  const s = st();
  if (!s || !audio.getAttribute('src')) return;
  useStore.getState().showToast('این آهنگ پخش نشد');
  if (s.order.length > 1 && s.at + 1 < s.order.length) next();
  else put({ playing: false });
});
