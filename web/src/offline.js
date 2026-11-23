// Offline mode: the last state of chats and messages is kept on this device (IndexedDB), so the
// app opens and shows recent messages without a connection; messages written meanwhile wait
// in an outbox and are sent when the server is reachable again (even after a restart).
import { api, upload, ApiError, CANCELLED } from './api';
import { useStore } from './store';
import { afterFailure, drainOutbox, queuedMeanwhile, voiceQueueRefusal } from './outbox-rules';
import { clearAllDrafts } from './drafts';

const DB = 'amorechat-offline';
const KEEP_MESSAGES = 100;
let dbp = null;

function db() {
  dbp ||= new Promise((ok, bad) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => ok(req.result);
    req.onerror = () => bad(req.error);
  }).catch(() => null);
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((ok) => {
    const t = d.transaction('kv', mode);
    const r = fn(t.objectStore('kv'));
    t.oncomplete = () => ok(r?.result);
    t.onerror = t.onabort = () => ok(undefined);
  });
}
const put = (k, v) => tx('readwrite', (s) => s.put(v, k));
const read = (k) => tx('readonly', (s) => s.get(k));
const del = (k) => tx('readwrite', (s) => s.delete(k));

// Like put(), but says whether it was really written (quota full, storage unavailable).
async function putChecked(k, v) {
  const d = await db();
  if (!d) throw new Error('storage unavailable');
  await new Promise((ok, bad) => {
    const t = d.transaction('kv', 'readwrite');
    t.objectStore('kv').put(v, k);
    t.oncomplete = ok;
    t.onerror = t.onabort = () => bad(t.error || new Error('storage refused'));
  });
}

const uid = () => useStore.getState().me?.id || 0;
const key = (k) => `u${uid()}:${k}`;

// ---------- Snapshot ----------
export const saveBoot = (config, me) => put('boot', { config, me, at: Date.now() });
export const loadBoot = () => read('boot');

const timers = new Map();
function later(k, fn) {
  clearTimeout(timers.get(k));
  timers.set(k, setTimeout(fn, 800));
}

export function cacheChats(chats) {
  later('chats', () => put(key('chats'), Object.values(chats)));
}
export const cachedChats = async () => (await read(key('chats'))) || null;

export function cacheMessages(chatId, list) {
  if (!list) return;
  later(`m${chatId}`, () => put(key(`msgs:${chatId}`), list.slice(-KEEP_MESSAGES)));
}
export const cachedMessages = async (chatId) => (await read(key(`msgs:${chatId}`))) || null;

export async function clearOffline() {
  await tx('readwrite', (s) => s.clear());
}

/** Signing out / leaving the server: nothing of this account stays on the device (cache, outbox, drafts). */
export async function wipeLocal() {
  await clearOffline().catch(() => {});
  clearAllDrafts();
  // Cached media of the previous account must not stay on a shared phone either.
  await globalThis.caches?.delete('files').catch(() => {});
}

// ---------- Outbox ----------
// Text items:  { tmpId, clientId, chatId, text, replyTo, createdAt, error }
// Voice items: { kind: 'voice', tmpId, clientId, chatId, mime, size, duration, waveform, replyTo,
//                createdAt, error, uploadId, fileId }
// Both may carry laterTries / laterSince: how often (since when) the server answered 5xx / 408.
// A voice's audio is stored under its own key as an ArrayBuffer (old Safari / WebViews can't keep
// a Blob in IndexedDB), so saving the list after every change doesn't rewrite megabytes of audio.
export async function loadOutbox() {
  const items = (await read(key('outbox'))) || [];
  useStore.setState({ outbox: items });
  return items;
}
const saveOutbox = () => put(key('outbox'), useStore.getState().outbox);
const voiceKey = (clientId) => key(`voice:${clientId}`);

// One id per message the user sends, kept through every retry: the server makes it only once.
export const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function enqueue(chatId, text, replyTo = null, clientId = newClientId()) {
  const item = { tmpId: `tmp-${clientId}`, clientId, chatId, text, replyTo, createdAt: Date.now(), error: null };
  useStore.setState((s) => ({ outbox: [...s.outbox, item] }));
  await saveOutbox();
  return item;
}

/**
 * Queues a recorded voice message; flushOutbox() sends it. Throws when it can't be kept on this
 * device (queue full: err.full; or storage refused it): the caller must then send it directly.
 */
export async function enqueueVoice({ chatId, blob, duration, waveform, replyTo = null, clientId = newClientId() }) {
  const refusal = voiceQueueRefusal(useStore.getState().outbox, blob.size);
  if (refusal) throw Object.assign(new Error(refusal), { full: true });
  const mime = blob.type || 'audio/webm';
  // Blob.arrayBuffer() is missing on older Safari / WebViews; Response reads it there.
  await putChecked(voiceKey(clientId), await (blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer()));
  const item = {
    kind: 'voice',
    tmpId: `tmp-${clientId}`,
    clientId,
    chatId,
    mime,
    size: blob.size,
    duration: Number.isFinite(duration) ? duration : null,
    waveform: waveform || null,
    replyTo,
    createdAt: Date.now(),
    error: null,
    uploadId: null,
    fileId: null,
  };
  const list = [...useStore.getState().outbox, item];
  try {
    await putChecked(key('outbox'), list);
  } catch (e) {
    del(voiceKey(clientId));
    throw e;
  }
  useStore.setState((s) => ({ outbox: [...s.outbox.filter((o) => o.tmpId !== item.tmpId), item] }));
  // Again from the live list: another save may have run (without this item) while we wrote.
  saveOutbox();
  // The recording is in memory already: play it from there instead of reading it back.
  voiceUrls.set(clientId, URL.createObjectURL(blob));
  return item;
}

const aborts = new Map(); // tmpId -> AbortController of the voice upload in progress

export async function dropFromOutbox(tmpId) {
  const item = useStore.getState().outbox.find((o) => o.tmpId === tmpId);
  aborts.get(tmpId)?.abort();
  useStore.setState((s) => ({ outbox: s.outbox.filter((o) => o.tmpId !== tmpId) }));
  await saveOutbox();
  if (item?.kind === 'voice') {
    releaseVoiceUrl(item.clientId);
    await del(voiceKey(item.clientId));
  }
}

const queued = (tmpId) => useStore.getState().outbox.some((o) => o.tmpId === tmpId);
const cancelled = () => new ApiError('ارسال لغو شد', CANCELLED);

async function patchItem(tmpId, patch) {
  if (!queued(tmpId)) return;
  useStore.setState((s) => ({ outbox: s.outbox.map((o) => (o.tmpId === tmpId ? { ...o, ...patch } : o)) }));
  await saveOutbox();
}

const voiceExt = (mime) => (mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm');

// Uploads (once: the file id is kept, so a retry only posts the message) and posts a voice item.
// The post carries the item's clientId: if its answer is lost, the next try gets the same message.
async function sendVoiceItem(item) {
  let fileId = item.fileId;
  if (!fileId) {
    const data = await read(voiceKey(item.clientId));
    if (!data) throw new ApiError('فایل صوتی روی این دستگاه پیدا نشد', 400);
    // Deleted by the user while its audio was being read.
    if (!queued(item.tmpId)) throw cancelled();
    const ac = new AbortController();
    aborts.set(item.tmpId, ac);
    let file;
    try {
      file = await upload(new Blob([data], { type: item.mime }), {
        name: `voice.${voiceExt(item.mime)}`,
        meta: { voice: 1, wave: item.waveform, dur: item.duration?.toFixed(2) },
        signal: ac.signal,
        resumeId: item.uploadId,
        // A big voice on a slow link must not hold the queue: give up after a few failures in a
        // row; the session id is kept, so the next round continues where this one stopped.
        maxFailures: 4,
        // Kept so that after a reload the upload continues instead of starting over.
        onSession: (id) => patchItem(item.tmpId, { uploadId: id }),
      });
    } catch (e) {
      // The server dropped the half-done upload (expired, cleaned up): start over next time.
      if (e.status === 404) {
        await patchItem(item.tmpId, { uploadId: null });
        throw new ApiError(e.message, 0);
      }
      throw e;
    } finally {
      aborts.delete(item.tmpId);
    }
    // Deleted by the user just as the upload finished: don't post it.
    if (!queued(item.tmpId)) throw cancelled();
    fileId = file.id;
    await patchItem(item.tmpId, { fileId, uploadId: null });
  }
  return api('POST', `/chats/${item.chatId}/messages`, { fileId, type: 'voice', replyTo: item.replyTo, clientId: item.clientId });
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  const before = useStore.getState().outbox;
  let result;
  try {
    result = await drainOutbox([...before], {
      live: (item) => queued(item.tmpId),
      send: async (item) => {
        const { message } =
          item.kind === 'voice'
            ? await sendVoiceItem(item)
            : await api('POST', `/chats/${item.chatId}/messages`, { text: item.text, replyTo: item.replyTo, clientId: item.clientId });
        useStore.getState().addMessage(message);
        await dropFromOutbox(item.tmpId);
      },
      failed: async (item, e) => {
        const current = useStore.getState().outbox.find((o) => o.tmpId === item.tmpId) || item;
        const { kind, patch } = afterFailure(current, e.status);
        // Sending too fast (a long queue at once): the rest in a few seconds, in order.
        if (kind === 'slow') setTimeout(flushOutbox, 8000);
        // Refused (not a member any more, chat locked…): keep it, marked, so it isn't lost.
        else if (kind === 'refused') await patchItem(item.tmpId, patch || { error: e.message, laterTries: 0, laterSince: null });
        // The server can't take it now: counted, so a server that never will doesn't hold its chat forever.
        else if (patch) await patchItem(item.tmpId, patch);
        return kind;
      },
    });
  } finally {
    flushing = false;
  }
  // Written while this round ran (it only saw the queue as it was): send those too.
  if (result && !result.stopped && queuedMeanwhile(before, useStore.getState().outbox, result.blocked)) setTimeout(flushOutbox, 0);
}

export async function retryOutbox(tmpId) {
  await patchItem(tmpId, { error: null, laterTries: 0, laterSince: null });
  flushOutbox();
}

export function startOutbox() {
  loadOutbox().then(flushOutbox);
  window.addEventListener('online', () => flushOutbox());
  setInterval(() => useStore.getState().outbox.length && flushOutbox(), 15000);
}

// ---------- Local playback of queued voices ----------
const voiceUrls = new Map(); // clientId -> object URL

export const voiceUrl = (clientId) => voiceUrls.get(clientId) || null;

/** Reads a queued voice back from storage (after a reload) for playback; null if it's gone. */
export async function loadVoiceUrl(item) {
  if (voiceUrls.has(item.clientId)) return voiceUrls.get(item.clientId);
  const data = await read(voiceKey(item.clientId));
  if (voiceUrls.has(item.clientId)) return voiceUrls.get(item.clientId);
  if (!data) return null;
  const url = URL.createObjectURL(new Blob([data], { type: item.mime }));
  voiceUrls.set(item.clientId, url);
  return url;
}

function releaseVoiceUrl(clientId) {
  const url = voiceUrls.get(clientId);
  if (url) URL.revokeObjectURL(url);
  voiceUrls.delete(clientId);
}
/** Frees every playback URL (the chat showing them closed); they are made again when needed. */
export function releaseVoiceUrls() {
  for (const id of [...voiceUrls.keys()]) releaseVoiceUrl(id);
}

// A queued item shown as a message bubble in its chat.
export function outboxMessage(o, me) {
  const voice = o.kind === 'voice';
  return {
    id: o.tmpId,
    chatId: o.chatId,
    type: voice ? 'voice' : 'text',
    text: voice ? '' : o.text,
    // Played from this device; `local` keeps the player from asking the server for it.
    file: voice ? { id: o.tmpId, local: true, localUrl: voiceUrl(o.clientId), duration: o.duration, waveform: o.waveform, size: o.size, mime: o.mime } : undefined,
    sender: { id: me.id, displayName: me.displayName, username: me.username, avatar: me.avatar },
    reactions: [],
    mentions: [],
    replyTo: null,
    createdAt: o.createdAt,
    pending: !o.error,
    failed: o.error,
  };
}
