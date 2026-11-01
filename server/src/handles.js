import { get, run, now } from './db.js';
import { USERNAME_RE } from './auth.js';
import { fail } from './chats.js';

// The @id of a channel or group. Users and chats share one set of names, as in Telegram. A name
// starting with a digit can't be taken by a user: it marks a channel the server owner added.
const OWNER_ONLY_RE = /^[0-9][a-zA-Z0-9_]{2,32}$/;
const clean = (h) => String(h ?? '').trim().replace(/^@/, '');
const isOwnerOnly = (h) => /^[0-9]/.test(h);

export function handleTaken(handle, chatId = 0) {
  return !!get(
    `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM users WHERE username = ?1)
       OR EXISTS (SELECT 1 FROM chats WHERE handle = ?1 AND id != ?2)
       OR EXISTS (SELECT 1 FROM reserved_handles WHERE handle = ?1 AND chat_id != ?2)`,
    handle,
    chatId,
  );
}

/** Refuses a name this user can't give to a chat; returns it cleaned. */
export function checkHandle(user, value, chatId = 0) {
  const h = clean(value);
  if (isOwnerOnly(h)) {
    if (user.role !== 'owner') fail(400, 'شناسه‌ای که با عدد شروع شود فقط برای کانال‌های مالک سرور است');
    if (!OWNER_ONLY_RE.test(h)) fail(400, 'شناسه نامعتبر است');
  } else if (!USERNAME_RE.test(h)) {
    fail(400, 'شناسه باید ۳ تا ۳۲ حرف انگلیسی، عدد یا _ باشد و با حرف شروع شود');
  }
  if (handleTaken(h, chatId)) fail(409, 'این شناسه قبلاً گرفته شده است');
  return h;
}

const isMirror = (chatId) => !!get('SELECT 1 AS x FROM tele_mirrors WHERE chat_id = ?', chatId);

/** Edit from the chat's settings; an empty value frees the name. */
export function setChatHandle(user, chatId, value) {
  const chat = get('SELECT id, handle, is_public FROM chats WHERE id = ?', chatId);
  const wanted = clean(value);
  if (wanted.toLowerCase() === (chat.handle || '').toLowerCase()) return;
  if (!wanted) {
    run('UPDATE chats SET handle = NULL WHERE id = ?', chat.id);
    return;
  }
  if (!chat.is_public && !isMirror(chat.id)) fail(400, 'فقط گروه و کانال عمومی شناسه دارد');
  run('UPDATE chats SET handle = ? WHERE id = ?', checkHandle(user, wanted, chat.id), chat.id);
}

/** A chat that stops being public gives its name back. */
export function dropPrivateHandle(chatId) {
  if (!isMirror(chatId)) run('UPDATE chats SET handle = NULL WHERE id = ? AND is_public = 0', chatId);
}

/**
 * A channel copied from Telegram: 1varzesh3, and "varzesh3" itself is kept for it so nobody can pose
 * as the original. If that is someone's already, the channel still gets its digit name.
 */
export function assignMirrorHandle(chatId, username, tgChatId) {
  const current = get('SELECT handle FROM chats WHERE id = ?', chatId)?.handle || '';
  if (isOwnerOnly(current)) return current;
  const base = username || `tg${String(tgChatId).replace(/\D/g, '')}`;
  let handle = `1${base}`.slice(0, 33);
  for (let n = 2; handleTaken(handle, chatId); n++) handle = `${n}${base}`.slice(0, 33);
  run('UPDATE chats SET handle = ? WHERE id = ?', handle, chatId);
  if (username && USERNAME_RE.test(username) && !handleTaken(username, chatId)) {
    run('INSERT OR IGNORE INTO reserved_handles (handle, chat_id, created_at) VALUES (?, ?, ?)', username, chatId, now());
  }
  return handle;
}
