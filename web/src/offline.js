// Offline mode: the last state of chats and messages is kept on this device (IndexedDB), so the
// app opens and shows recent messages without a connection; messages written meanwhile wait
// in an outbox and are sent when the server is reachable again (even after a restart).
import { api } from './api';
import { useStore } from './store';

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

// ---------- Outbox ----------
// items: { tmpId, chatId, text, replyTo, createdAt, error }
export async function loadOutbox() {
  const items = (await read(key('outbox'))) || [];
  useStore.setState({ outbox: items });
  return items;
}
const saveOutbox = () => put(key('outbox'), useStore.getState().outbox);

export async function enqueue(chatId, text, replyTo = null) {
  const item = { tmpId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, chatId, text, replyTo, createdAt: Date.now(), error: null };
  useStore.setState((s) => ({ outbox: [...s.outbox, item] }));
  await saveOutbox();
  return item;
}

export async function dropFromOutbox(tmpId) {
  useStore.setState((s) => ({ outbox: s.outbox.filter((o) => o.tmpId !== tmpId) }));
  await saveOutbox();
}

let flushing = false;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of [...useStore.getState().outbox]) {
      if (item.error) continue;
      try {
        const { message } = await api('POST', `/chats/${item.chatId}/messages`, { text: item.text, replyTo: item.replyTo });
        useStore.getState().addMessage(message);
        await dropFromOutbox(item.tmpId);
      } catch (e) {
        if (!e.status) break; // still offline: keep the order, try later
        // Refused (not a member any more, chat locked…): keep it, marked, so it isn't lost.
        useStore.setState((s) => ({ outbox: s.outbox.map((o) => (o.tmpId === item.tmpId ? { ...o, error: e.message } : o)) }));
        await saveOutbox();
      }
    }
  } finally {
    flushing = false;
  }
}

export async function retryOutbox(tmpId) {
  useStore.setState((s) => ({ outbox: s.outbox.map((o) => (o.tmpId === tmpId ? { ...o, error: null } : o)) }));
  await saveOutbox();
  flushOutbox();
}

export function startOutbox() {
  loadOutbox().then(flushOutbox);
  window.addEventListener('online', () => flushOutbox());
  setInterval(() => useStore.getState().outbox.length && flushOutbox(), 15000);
}

// A queued item shown as a message bubble in its chat.
export function outboxMessage(o, me) {
  return {
    id: o.tmpId,
    chatId: o.chatId,
    type: 'text',
    text: o.text,
    sender: { id: me.id, displayName: me.displayName, username: me.username, avatar: me.avatar },
    reactions: [],
    mentions: [],
    replyTo: null,
    createdAt: o.createdAt,
    pending: !o.error,
    failed: o.error,
  };
}
