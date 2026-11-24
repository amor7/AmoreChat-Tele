// Pure rules of the Telegram screens (TeleView, TeleChat, TeleMessage, MediaCard, the sidebar
// entry). No imports on purpose: the unit tests in server/test load this file directly in Node.

// util.js has toFa / faDigits too, but util.js imports the app (store, api): this copy keeps the
// file import-free so node --test can load it. Same output as util.faDigits.
const FA = '۰۱۲۳۴۵۶۷۸۹';
/** Persian digits in any text. */
export const faDigits = (s) => String(s).replace(/\d/g, (d) => FA[d]);

/** Avatar colors need a number: Telegram ids (and "u123" / "c-100…" sender ids) give a stable one. */
export const avatarNum = (id) => Math.abs(Number(String(id || '').replace(/^[uc]/, '')) || 0);

/**
 * What the app's sidebar shows for Telegram, from a /api/tele/status answer:
 * { show, unread }. Shown for a connected account (unread = the sum over the chats the user
 * added) and while the section is locked (no number then: nothing from Telegram while locked).
 * Hidden without access, without an answer yet, or before an account is connected.
 */
export function teleEntry(status) {
  if (!status || status.access === false) return { show: false, unread: 0 };
  if (status.locked) return { show: true, unread: 0 };
  if (status.account?.status !== 'connected') return { show: false, unread: 0 };
  return { show: true, unread: unreadSum(status.dialogs, 'all', true) };
}

/**
 * Unread messages (not chats) of `dialogs` of one kind ('all', 'private', 'group', 'channel'),
 * the same count on the sidebar button and on the Telegram page's tabs. `selectedOnly`: only the
 * chats the user added (the others are not followed).
 */
export function unreadSum(dialogs, kind = 'all', selectedOnly = false) {
  let unread = 0;
  for (const d of dialogs || []) {
    const n = Number(d?.unread);
    if (selectedOnly && !d?.selected) continue;
    if (kind !== 'all' && d?.kind !== kind) continue;
    if (Number.isFinite(n) && n > 0) unread += Math.floor(n);
  }
  return unread;
}

/** The badge text: Persian digits, «۹۹+» past 99, '' for none. */
export const badgeText = (n) => (n > 99 ? `${faDigits(99)}+` : n > 0 ? faDigits(n) : '');

// ---------- Message history ----------
const byTg = (a, b) => (a.tgMsgId ?? Infinity) - (b.tgMsgId ?? Infinity) || a.id - b.id;

// Everything about a message the server may change between two checks (a queued message gets its
// Telegram id and kind, a failed one its kind, a reply its quoted text). Media are compared by
// their JSON: small objects (sizes, length, a mini thumbnail).
const SCALARS = ['id', 'tgMsgId', 'kind', 'text', 'direction', 'createdAt', 'senderId', 'senderName', 'dialogId'];
const OBJECTS = ['replyTo', 'photo', 'voice', 'file'];
/** True when two versions of a message would show the same. */
export function sameMessage(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  for (const k of SCALARS) if (a[k] !== b[k]) return false;
  for (const k of OBJECTS) if (a[k] !== b[k] && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  return true;
}

// Keeps the objects of `cur` for messages that did not change, and `cur` itself when nothing did:
// a check every few seconds then re-renders nothing (TeleMessage is memoized on its message).
function keepUnchanged(cur, next) {
  if (!cur) return next;
  const old = new Map(cur.map((m) => [m.id, m]));
  let same = cur.length === next.length;
  const out = next.map((m, i) => {
    const prev = old.get(m.id);
    const keep = prev && sameMessage(prev, m) ? prev : m;
    if (keep !== cur[i]) same = false;
    return keep;
  });
  return same ? cur : out;
}

/**
 * The server's latest page replaces everything shown from its oldest message on: a message sent
 * from here moves from its temporary id to its final one, and must not stay twice on screen.
 * Unchanged messages keep their objects, and an unchanged list is returned as is.
 */
export function mergeLatest(cur, page) {
  if (!page.length) return cur || [];
  const from = Math.min(...page.map((m) => m.tgMsgId ?? Infinity));
  const ids = new Set(page.map((m) => m.id));
  return keepUnchanged(cur, [...(cur || []).filter((m) => (m.tgMsgId ?? Infinity) < from && !ids.has(m.id)), ...page].sort(byTg));
}

/** Older messages (or one just sent) added to what is shown, without doubles; `cur` if none is new. */
export function mergeOlder(cur, older) {
  const ids = new Set((cur || []).map((m) => m.id));
  const added = older.filter((m) => !ids.has(m.id));
  if (cur && !added.length) return cur;
  return [...added, ...(cur || [])].sort(byTg);
}

/**
 * What the history area shows: 'loading' (first load, skeleton), 'error' (first load failed:
 * the reason and a retry, not an endless spinner), 'empty' or 'list'. Later polls never bring the
 * skeleton back: once something (even an empty list) was shown, it stays until replaced.
 */
export function historyView(messages, error) {
  if (messages == null) return error ? 'error' : 'loading';
  return messages.length ? 'list' : 'empty';
}

// ---------- Message actions ----------
/**
 * The actions of a Telegram message's menu, in order. `m` is the message; `opts` says what this
 * chat and account allow: canReply (not a channel), allowMedia / allowVoice / allowFiles.
 * A queued message (not in Telegram yet) has no Telegram id: no reply or forward, only cancel.
 */
export function messageActions(m, { canReply = true, allowMedia = false, allowVoice = false, allowFiles = false } = {}) {
  const out = [];
  const queued = m.kind === 'queued';
  if (!queued && canReply && m.tgMsgId) out.push('reply');
  if (!queued) out.push('forward');
  // «انتخاب متن»: on phones a long-press opens this menu, so selecting part of the text is here.
  if (captionOf(m, { allowMedia, allowVoice, allowFiles }).trim()) out.push('copy', 'select');
  if (!queued && mediaKind(m, { allowMedia, allowVoice, allowFiles })) out.push('download');
  if (queued) out.push('cancel');
  return out;
}

/** Which media card a message shows ('photo' | 'voice' | 'file' | null), as the account allows. */
export function mediaKind(m, { allowMedia = false, allowVoice = false, allowFiles = false } = {}) {
  if (m.photo && allowMedia) return 'photo';
  if (m.voice && allowVoice) return 'voice';
  if (m.file && allowFiles) return 'file';
  return null;
}

/**
 * The text under a media card. Without a photo / player shown, the text keeps its "📷 عکس" /
 * "🎤 پیام صوتی" label; with it, only the caption.
 */
export function captionOf(m, allow = {}) {
  const text = m.text || '';
  const kind = mediaKind(m, allow);
  if (kind === 'photo') return text.replace(/^📷 عکس\n?/, '');
  if (kind === 'voice') return text.replace(/^🎤 پیام صوتی\n?/, '');
  if (kind === 'file') return text.replace(/^(📎|🎬|🎵|GIF)[^\n]*\n?/, '');
  return text;
}

// ---------- Media downloads ----------
/** A media card's state: idle → loading (received / total bytes) → done | error. */
export const MEDIA_IDLE = Object.freeze({ status: 'idle', received: 0, total: 0, error: '' });

export function mediaReducer(s, a) {
  switch (a.type) {
    case 'start':
      // A second tap while it runs changes nothing.
      if (s.status === 'loading') return s;
      return { status: 'loading', received: 0, total: a.total > 0 ? a.total : 0, error: '' };
    case 'progress': {
      if (s.status !== 'loading') return s;
      const total = a.total > 0 ? a.total : s.total;
      const received = Math.max(0, total ? Math.min(a.received, total) : a.received);
      if (received === s.received && total === s.total) return s;
      return { ...s, received, total };
    }
    case 'done':
      return { status: 'done', received: s.total || s.received, total: s.total || s.received, error: '' };
    case 'fail':
      // Cancelled by the user: back to the start, no error to read.
      if (a.cancelled) return MEDIA_IDLE;
      return { status: 'error', received: 0, total: s.total, error: a.error || 'دانلود ناموفق بود' };
    case 'reset':
      return MEDIA_IDLE;
    default:
      return s;
  }
}

/**
 * Where a running download is: 'fetching' (nothing arrived yet: the server is still getting it
 * from Telegram), 'receiving' (bytes coming, size known), 'streaming' (bytes coming, size
 * unknown), 'finishing' (all announced bytes in, not done yet). null when not loading.
 */
export function progressPhase(s) {
  if (s.status !== 'loading') return null;
  if (!s.received) return 'fetching';
  if (!s.total) return 'streaming';
  return s.received >= s.total ? 'finishing' : 'receiving';
}

/** Whole percent 0-99 while bytes arrive with a known size; null otherwise (no honest number). */
export function mediaPercent(s) {
  if (progressPhase(s) !== 'receiving') return null;
  return Math.max(0, Math.min(99, Math.floor((s.received / s.total) * 100)));
}

/** «۴۲٪», or '' when the size is unknown. */
export function percentText(s) {
  const p = mediaPercent(s);
  return p == null ? '' : `${faDigits(p)}٪`;
}

/**
 * Only redraw on a real step: the first bytes (fetching → receiving), a percent changed, or
 * 256 KB more when the size is unknown.
 */
export function progressStep(prev, next, total) {
  if (!prev && next > 0) return true;
  if (total > 0) return Math.floor((next / total) * 100) !== Math.floor((prev / total) * 100);
  return Math.floor(next / 262144) !== Math.floor(prev / 262144);
}

/** m:ss with Persian digits (voice and video lengths). */
export function clockText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return faDigits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

/**
 * A file name from Telegram, safe for <a download>: no folders (/ \), no leading dots (hidden
 * files, ".."), no control characters, at most 120 characters; `fallback` when nothing is left.
 */
export function safeFileName(name, fallback = 'file') {
  let n = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '') // eslint-disable-line no-control-regex
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/^[.\s]+/, '');
  if (n.length > 120) {
    const ext = (n.match(/\.[\w]{1,8}$/) || [''])[0];
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || fallback;
}
