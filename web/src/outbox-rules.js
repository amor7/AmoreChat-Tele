// Decisions of the offline outbox that don't need a browser (unit-tested in Node; no imports).

// Voice messages are kept in IndexedDB until sent: bounded so a long outage can't fill the phone.
export const VOICE_QUEUE_MAX_ITEMS = 20;
export const VOICE_QUEUE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * What a failed send means for a queued item:
 * - 'offline'   no answer (no connection, server unreachable): keep it, keep the order, try later
 * - 'slow'      429, sending too fast: keep it, try again in a few seconds
 * - 'later'     408 / 5xx (server restarting, behind a proxy that times out): keep it, try later
 * - 'cancelled' the user removed it meanwhile
 * - 'refused'   any other 4xx (not a member any more, file too big…): mark it failed, with the
 *               server's message, so the user can retry or delete it
 */
export function failureKind(status) {
  if (status === -1) return 'cancelled';
  if (!status) return 'offline';
  if (status === 429) return 'slow';
  if (status === 408 || status >= 500) return 'later';
  return 'refused';
}

/** null when one more voice of `size` bytes fits in the queue, else the reason (Persian, for the user). */
export function voiceQueueRefusal(items, size) {
  const voices = (items || []).filter((o) => o.kind === 'voice');
  if (voices.length >= VOICE_QUEUE_MAX_ITEMS) return `صف پیام‌های صوتی پر است (حداکثر ${VOICE_QUEUE_MAX_ITEMS.toLocaleString('fa-IR')} پیام)`;
  const total = voices.reduce((n, o) => n + (o.size || 0), 0);
  if (total + size > VOICE_QUEUE_MAX_BYTES) return `صف پیام‌های صوتی پر است (حداکثر ${(VOICE_QUEUE_MAX_BYTES / 1048576).toLocaleString('fa-IR')} مگابایت)`;
  return null;
}

// A server that keeps answering 5xx / 408 for one item (a bug, a broken file) must not hold its
// chat forever: after this many such answers, spread over at least this long, the item is marked
// failed so the user can send it again or delete it. Pure network failures (no answer at all)
// don't count: that is an outage, not a server refusing this message.
export const LATER_MAX_TRIES = 8;
export const LATER_MIN_MS = 10 * 60 * 1000;
export const SERVER_GAVE_UP = 'سرور پیام را نپذیرفت؛ دوباره بفرستید یا حذف کنید';

/**
 * What a failed send of `item` (status of the error) means, and what to record on the item:
 * { kind, patch } — kind as failureKind() ('later' turns into 'refused' when the server has
 * failed it too often for too long); patch is null when nothing is to be saved.
 */
export function afterFailure(item, status, now = Date.now()) {
  const kind = failureKind(status);
  if (kind !== 'later') return { kind, patch: null };
  const tries = (item.laterTries || 0) + 1;
  const since = item.laterSince || now;
  if (tries >= LATER_MAX_TRIES && now - since >= LATER_MIN_MS) {
    return { kind: 'refused', patch: { error: SERVER_GAVE_UP, laterTries: 0, laterSince: null } };
  }
  return { kind, patch: { laterTries: tries, laterSince: since } };
}

/**
 * Sends the queued items in order, but only in order within each chat: an item the server can't
 * take now ('later') holds back the rest of its own chat for this round, not the other chats.
 * No connection ('offline') or sending too fast ('slow') stops the whole round.
 * - live(item):   still queued (the user may have deleted it meanwhile)
 * - send(item):   resolves when sent
 * - failed(item, err): records the failure, resolves to its kind (see afterFailure)
 * Returns { stopped: null | 'offline' | 'slow', blocked: Set of chat ids held back }.
 */
export async function drainOutbox(items, { live, send, failed }) {
  const blocked = new Set();
  for (const item of items) {
    if (item.error || blocked.has(item.chatId) || !live(item)) continue;
    try {
      await send(item);
    } catch (e) {
      const kind = await failed(item, e);
      if (kind === 'offline' || kind === 'slow') return { stopped: kind, blocked };
      if (kind === 'later') blocked.add(item.chatId);
    }
  }
  return { stopped: null, blocked };
}

/** Items queued while a round ran (not in `before`) that the next round could send now. */
export function queuedMeanwhile(before, after, blocked = new Set()) {
  const seen = new Set(before.map((o) => o.tmpId));
  return after.some((o) => !seen.has(o.tmpId) && !o.error && !blocked.has(o.chatId));
}
