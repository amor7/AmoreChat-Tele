import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { settingNumber } from '../settings.js';
import { getAccountForUser, liveClient, listDialogs, upsertDialog, onTeleUpdate } from './accounts.js';
import { ensureEgress } from './egress.js';

const UPLOADS = path.join(DATA_DIR, 'tele-uploads');
export const mediaMaxBytes = () => (settingNumber('tele_media_max_mb') || 5) * 1048576;

export function listStoredMessages(accountId, dialogId, { limit = 50, beforeTgId = null } = {}) {
  const n = Math.min(100, limit);
  // Telegram's own message ids give the real order (rows from a later "load older" have higher row ids).
  const rows = beforeTgId
    ? all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id < ? ORDER BY tg_msg_id DESC LIMIT ?`, accountId, dialogId, Number(beforeTgId), n)
    : all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? ORDER BY tg_msg_id DESC, id DESC LIMIT ?`, accountId, dialogId, n);
  return rows.reverse();
}

// Photo info kept with a message: the tiny preview Telegram embeds in every message (no extra
// traffic) and the available sizes, so the full photo can be fetched later on request.
function photoInfo(content) {
  if (content?._ !== 'messagePhoto' || !content.photo) return null;
  const sizes = (content.photo.sizes || [])
    .map((s) => ({ t: s.type, w: s.width, h: s.height, size: s.photo?.size || s.photo?.expected_size || 0, remote: s.photo?.remote?.id || '' }))
    .filter((s) => s.remote);
  const big = sizes.at(-1);
  return { type: 'photo', w: big?.w || 0, h: big?.h || 0, mini: content.photo.minithumbnail?.data || '', sizes };
}
const parseMedia = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** Rows → API messages, with the quoted message of replies (when it is stored). */
export function publicMessages(rows) {
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
  const quoted = new Map();
  if (replyIds.length && rows[0]) {
    const ph = replyIds.map(() => '?').join(',');
    for (const q of all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id IN (${ph})`, rows[0].account_id, rows[0].dialog_id, ...replyIds)) {
      quoted.set(q.tg_msg_id, q);
    }
  }
  return rows.map((r) => publicMessage(r, quoted));
}
export function publicMessage(row, quoted = null) {
  if (!row) return null;
  const media = parseMedia(row.media);
  let replyTo = null;
  if (row.reply_to) {
    const q = quoted?.get(row.reply_to) || get('SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?', row.account_id, row.dialog_id, row.reply_to);
    replyTo = { tgMsgId: row.reply_to, senderName: q ? (q.direction === 'out' ? 'شما' : q.sender_name) : '', text: q ? q.text.split('\n')[0].slice(0, 120) : '' };
  }
  return {
    id: row.id, dialogId: row.dialog_id, tgMsgId: row.tg_msg_id, direction: row.direction, kind: row.kind, text: row.text,
    createdAt: row.created_at, senderId: row.sender_id || '', senderName: row.sender_name || '', replyTo,
    photo: media?.type === 'photo' ? { w: media.w, h: media.h, mini: media.mini } : null,
  };
}
function storeMessage(accountId, dialogId, { tgMsgId, direction, kind, text, createdAt, senderId = '', senderName = '', replyTo = null, media = null }) {
  const mediaJson = media ? JSON.stringify(media) : '';
  try {
    const r = run(
      `INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, direction, kind, text, media_path, created_at, sender_id, sender_name, reply_to, media) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      accountId, dialogId, tgMsgId != null ? Number(tgMsgId) : null, direction || 'in', kind || 'text', String(text || '').slice(0, 8000), '', createdAt || now(),
      String(senderId), senderName, replyTo ? Number(replyTo) : null, mediaJson,
    );
    return get('SELECT * FROM tele_messages WHERE id = ?', Number(r.lastInsertRowid));
  } catch (e) {
    if (!/UNIQUE/i.test(String(e.message))) throw e;
    // Already stored: fill in what older versions did not keep (sender, real date, reply, photo).
    run(
      `UPDATE tele_messages SET sender_id = ?, sender_name = ?, created_at = ?, text = ?, kind = ?, reply_to = ?, media = ? WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?`,
      String(senderId), senderName, createdAt || now(), String(text || '').slice(0, 8000), kind || 'text', replyTo ? Number(replyTo) : null, mediaJson,
      accountId, dialogId, Number(tgMsgId),
    );
    return get('SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?', accountId, dialogId, Number(tgMsgId));
  }
}

// Text for a TDLib message: its text or caption, or a label for media this view does not show.
const LABELS = {
  messagePhoto: '📷 عکس', messageVideo: '🎬 ویدیو', messageVoiceNote: '🎤 پیام صوتی', messageVideoNote: '⏺ پیام ویدیویی',
  messageAudio: '🎵 موسیقی', messageDocument: '📎 فایل', messageAnimation: 'GIF', messageContact: '👤 مخاطب',
  messageLocation: '📍 موقعیت', messageVenue: '📍 مکان', messagePoll: '📊 نظرسنجی', messageCall: '📞 تماس',
  messageChatAddMembers: 'عضو جدید اضافه شد', messageChatJoinByLink: 'با لینک عضو شد', messageChatDeleteMember: 'عضوی خارج شد',
  messagePinMessage: '📌 پیامی سنجاق شد', messageChatChangeTitle: 'نام گفتگو عوض شد', messageChatChangePhoto: 'عکس گفتگو عوض شد',
};
export function contentText(content) {
  if (!content) return '';
  if (content._ === 'messageText') return content.text?.text || '';
  if (content._ === 'messageSticker') return `${content.sticker?.emoji || ''} استیکر`.trim();
  const label = LABELS[content._] || 'پیام';
  const caption = content.caption?.text;
  if (content._ === 'messageDocument' && content.document?.file_name) return `${label}: ${content.document.file_name}${caption ? '\n' + caption : ''}`;
  return caption ? `${label}\n${caption}` : label;
}
const kindOf = (content) => (content?._ === 'messageText' ? 'text' : content?._ === 'messagePhoto' ? 'photo' : 'other');

// Display names of senders, per TDLib client (users and chats rarely change name).
const names = new WeakMap();
async function senderOf(client, sender) {
  if (!sender) return { id: '', name: '' };
  let cache = names.get(client);
  if (!cache) names.set(client, (cache = new Map()));
  const id = sender._ === 'messageSenderUser' ? `u${sender.user_id}` : `c${sender.chat_id}`;
  if (!cache.has(id)) {
    let name = '';
    try {
      if (sender._ === 'messageSenderUser') {
        const u = await client.invoke({ _: 'getUser', user_id: sender.user_id });
        name = [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.usernames?.active_usernames?.[0] ? '@' + u.usernames.active_usernames[0] : '');
      } else {
        name = (await client.invoke({ _: 'getChat', chat_id: sender.chat_id })).title || '';
      }
    } catch {
      /* unknown sender: shown without a name */
    }
    cache.set(id, name);
  }
  return { id, name: cache.get(id) };
}

// The message a reply points to, when it is in the same chat.
const replyIdOf = (m) => (m.reply_to?._ === 'messageReplyToMessage' && (!m.reply_to.chat_id || m.reply_to.chat_id === m.chat_id) ? m.reply_to.message_id : null);

async function storeTdMessage(client, accountId, dialogId, m) {
  const s = await senderOf(client, m.sender_id);
  return storeMessage(accountId, dialogId, {
    tgMsgId: m.id, direction: m.is_outgoing ? 'out' : 'in', kind: kindOf(m.content), text: contentText(m.content),
    createdAt: m.date ? m.date * 1000 : now(), senderId: s.id, senderName: s.name, replyTo: replyIdOf(m), media: photoInfo(m.content),
  });
}
async function storeTdMessages(client, accountId, dialogId, messages) {
  for (const m of messages) {
    // Still being sent: it is stored under its final id once Telegram confirms it (see below).
    if (m.sending_state) continue;
    await storeTdMessage(client, accountId, dialogId, m);
  }
  // Quoted messages that are not stored yet (older than what was loaded): fetch them once.
  const missing = [...new Set(messages.map(replyIdOf).filter(Boolean))].filter(
    (id) => !get('SELECT 1 FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?', accountId, dialogId, id),
  );
  for (const id of missing.slice(0, 20)) {
    try {
      const q = await client.invoke({ _: 'getMessage', chat_id: messages[0].chat_id, message_id: id });
      if (q && !q.sending_state) await storeTdMessage(client, accountId, dialogId, q);
    } catch {
      /* deleted or not accessible: the reply shows without its quote */
    }
  }
}

// A sent message first has a temporary id; Telegram then confirms it under its final id. Move the
// stored row to the final id, so the message is not shown twice (temporary + final copy).
// Confirmations that arrived before the temporary row was stored, applied right after storing it.
const early = new Map();
onTeleUpdate((accountId, u) => applySent(accountId, u));
function applySent(accountId, u) {
  if (u._ !== 'updateMessageSendSucceeded' && u._ !== 'updateMessageSendFailed') return;
  const temp = get('SELECT * FROM tele_messages WHERE account_id = ? AND tg_msg_id = ?', accountId, u.old_message_id);
  if (!temp) {
    early.set(`${accountId}:${u.old_message_id}`, u);
    setTimeout(() => early.delete(`${accountId}:${u.old_message_id}`), 60000).unref();
    return;
  }
  if (u._ === 'updateMessageSendFailed') {
    run(`UPDATE tele_messages SET kind = 'failed' WHERE id = ?`, temp.id);
    return;
  }
  const m = u.message;
  const final = get('SELECT id FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?', accountId, temp.dialog_id, m.id);
  if (final) run('DELETE FROM tele_messages WHERE id = ?', final.id);
  const media = photoInfo(m.content);
  run(
    'UPDATE tele_messages SET tg_msg_id = ?, created_at = ?, media = ? WHERE id = ?',
    m.id, m.date ? m.date * 1000 : temp.created_at, media ? JSON.stringify(media) : temp.media, temp.id,
  );
}

function ownDialog(userId, dialogId) {
  const account = getAccountForUser(userId);
  if (!account) throw Object.assign(new Error('حساب تلگرام وصل نیست'), { statusCode: 400 });
  const dialog = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), account.id);
  if (!dialog) throw Object.assign(new Error('گفتگو پیدا نشد'), { statusCode: 404 });
  return { account, dialog };
}

/**
 * Latest messages of a chat (or older ones with `before` = a Telegram message id), and marks it
 * read in Telegram like opening it in a Telegram app. Opening a chat does not add it to the
 * user's list: only "add a chat" does, so a removed chat stays removed.
 * `local`: the periodic check while the chat is open. TDLib already received new messages as
 * updates, so it answers from its own database without any network traffic.
 */
export async function syncDialogMessages(userId, dialogId, { limit = 40, before = null, local = false } = {}) {
  const { account, dialog } = ownDialog(userId, dialogId);
  const n = Math.min(50, limit);
  const stored = () => publicMessages(listStoredMessages(account.id, dialog.id, { limit: before ? n : Math.max(n, 40), beforeTgId: before }));
  const client = await liveClient(account);
  if (!client) return { messages: stored(), notice: 'حساب تلگرام وصل نیست' };
  if (!local) await ensureEgress();
  const chatId = Number(dialog.tg_chat_id);
  const history = () => client.invoke({ _: 'getChatHistory', chat_id: chatId, from_message_id: before ? Number(before) : 0, offset: 0, limit: n, only_local: local });
  let hist = await history();
  // From the network TDLib may answer with only a few messages at first: ask again once.
  if (!local && (hist?.messages?.length || 0) < Math.min(n, 10)) hist = await history();
  const msgs = hist?.messages || [];
  const newest = get('SELECT MAX(tg_msg_id) AS m FROM tele_messages WHERE account_id = ? AND dialog_id = ?', account.id, dialog.id)?.m || 0;
  await storeTdMessages(client, account.id, dialog.id, msgs);
  if (!before) {
    const last = msgs.find((m) => !m.sending_state);
    if (last) upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, lastText: contentText(last.content), lastAt: last.date * 1000, lastOut: last.is_outgoing, unread: 0 });
    else upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, unread: 0 });
    // Mark as read in Telegram on opening, and when new incoming messages showed up.
    const unseen = local ? msgs.filter((m) => m.id > newest && !m.is_outgoing) : msgs;
    if (unseen.length) {
      await client.invoke({ _: 'viewMessages', chat_id: chatId, message_ids: unseen.map((m) => m.id), force_read: true }).catch(() => {});
    }
  }
  return { messages: stored(), hasMore: msgs.length > 0 };
}

/** Search one chat's whole Telegram history (results are kept like other messages). */
export async function searchDialogMessages(userId, dialogId, query) {
  const q = String(query || '').trim();
  if (q.length < 2) throw Object.assign(new Error('حداقل ۲ حرف بنویسید'), { statusCode: 400 });
  const { account, dialog } = ownDialog(userId, dialogId);
  const client = await liveClient(account);
  if (!client) {
    const rows = all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND text LIKE ? ORDER BY tg_msg_id DESC LIMIT 50`, account.id, dialog.id, `%${q}%`);
    return { messages: publicMessages(rows) };
  }
  await ensureEgress();
  const found = await client.invoke({ _: 'searchChatMessages', chat_id: Number(dialog.tg_chat_id), query: q, from_message_id: 0, offset: 0, limit: 50 });
  await storeTdMessages(client, account.id, dialog.id, found?.messages || []);
  const ids = (found?.messages || []).map((m) => m.id);
  if (!ids.length) return { messages: [] };
  const rows = all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id IN (${ids.map(() => '?').join(',')}) ORDER BY tg_msg_id DESC`, account.id, dialog.id, ...ids);
  return { messages: publicMessages(rows) };
}

async function sendContent(userId, dialogId, content, { replyTo = null, text = '', kind = 'text', media = null } = {}) {
  const { account, dialog } = ownDialog(userId, dialogId);
  if (account.status !== 'connected') throw Object.assign(new Error('حساب وصل نیست'), { statusCode: 400 });
  await ensureEgress();
  const client = await liveClient(account);
  if (!client) throw Object.assign(new Error('اتصال به تلگرام برقرار نیست'), { statusCode: 503, expose: true });
  const result = await client.invoke({
    _: 'sendMessage',
    chat_id: Number(dialog.tg_chat_id),
    ...(replyTo ? { reply_to: { _: 'inputMessageReplyToMessage', message_id: Number(replyTo) } } : {}),
    input_message_content: content,
  });
  const t = result?.date ? result.date * 1000 : now();
  upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, lastText: text, lastAt: t, lastOut: true });
  // Stored under the temporary id; moved to the final one when Telegram confirms (onTeleUpdate above).
  const row = storeMessage(account.id, dialog.id, { tgMsgId: result?.id, direction: 'out', kind, text, createdAt: t, replyTo, media: media || photoInfo(result?.content) });
  const confirmed = early.get(`${account.id}:${result?.id}`);
  if (confirmed) {
    early.delete(`${account.id}:${result.id}`);
    applySent(account.id, confirmed);
    return publicMessage(get('SELECT * FROM tele_messages WHERE id = ?', row.id));
  }
  return publicMessage(row);
}

export async function sendTeleMessage(userId, dialogId, text, replyTo = null) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('متن خالی است'), { statusCode: 400 });
  return sendContent(userId, dialogId, { _: 'inputMessageText', text: { _: 'formattedText', text: body } }, { replyTo, text: body });
}

// ---------- Photos: only for accounts an admin allowed, and up to the size limit ----------
function mediaAccount(userId) {
  const account = getAccountForUser(userId);
  if (!account?.allow_media) throw Object.assign(new Error('دسترسی به عکس‌های تلگرام برای شما فعال نیست'), { statusCode: 403 });
  return account;
}

/** Sends a photo the user uploaded (a temporary file, removed after a day). */
export async function sendTelePhoto(userId, dialogId, file, { caption = '', replyTo = null } = {}) {
  mediaAccount(userId);
  const text = String(caption || '').trim();
  const content = { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: file } }, caption: text ? { _: 'formattedText', text } : undefined };
  return sendContent(userId, dialogId, content, { replyTo, text: text ? `📷 عکس\n${text}` : '📷 عکس', kind: 'photo' });
}
export function newUploadPath() {
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  // TDLib uploads in the background after sendMessage returns: keep files a day, then clean up.
  for (const f of fs.readdirSync(UPLOADS)) {
    const p = path.join(UPLOADS, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
  return path.join(UPLOADS, crypto.randomBytes(12).toString('hex') + '.jpg');
}

/** Local path of a message's photo, downloaded through the tunnel on first request. */
export async function telePhotoFile(userId, messageId) {
  const account = mediaAccount(userId);
  const row = get('SELECT * FROM tele_messages WHERE id = ? AND account_id = ?', Number(messageId), account.id);
  const media = parseMedia(row?.media);
  if (media?.type !== 'photo') throw Object.assign(new Error('عکس پیدا نشد'), { statusCode: 404 });
  // The biggest size that fits the limit (Telegram keeps several sizes of every photo).
  const max = mediaMaxBytes();
  const size = [...media.sizes].sort((a, b) => b.size - a.size).find((s) => !s.size || s.size <= max);
  if (!size) throw Object.assign(new Error(`حجم این عکس بیشتر از سقف مجاز (${settingNumber('tele_media_max_mb') || 5} مگابایت) است`), { statusCode: 413 });
  const client = await liveClient(account);
  if (!client) throw Object.assign(new Error('اتصال به تلگرام برقرار نیست'), { statusCode: 503, expose: true });
  let file = await client.invoke({ _: 'getRemoteFile', remote_file_id: size.remote, file_type: { _: 'fileTypePhoto' } });
  if (!file.local?.is_downloading_completed) {
    await ensureEgress();
    file = await client.invoke({ _: 'downloadFile', file_id: file.id, priority: 16, offset: 0, limit: 0, synchronous: true });
  }
  if (!file.local?.path || !fs.existsSync(file.local.path)) throw Object.assign(new Error('دانلود عکس ناموفق بود'), { statusCode: 502, expose: true });
  return file.local.path;
}

const KIND = (chat) =>
  chat.type?._ === 'chatTypePrivate' || chat.type?._ === 'chatTypeSecret' ? 'private' : chat.type?._ === 'chatTypeSupergroup' && chat.type?.is_channel ? 'channel' : 'group';

/**
 * Update the chat list from Telegram. By default only the chats the user added (their last message
 * and unread count, which TDLib mostly knows already). `all`: the whole Telegram chat list, only
 * when the user opens "add a chat" to pick from it.
 */
export async function refreshDialogsFromTelegram(userId, { all: everything = false } = {}) {
  const account = getAccountForUser(userId);
  if (!account) throw Object.assign(new Error('حساب وصل نیست'), { statusCode: 400 });
  const client = await liveClient(account);
  if (!client) return { dialogs: listDialogs(account.id), notice: 'حساب تلگرام وصل نیست' };
  await ensureEgress();
  let ids;
  if (everything) {
    // Newer TDLib only returns chats that were loaded first; loadChats fails once all are loaded.
    await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 200 }).catch(() => {});
    ids = (await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 200 }))?.chat_ids || [];
  } else {
    ids = all('SELECT tg_chat_id FROM tele_dialogs WHERE account_id = ? AND selected = 1', account.id).map((d) => Number(d.tg_chat_id));
  }
  for (const id of ids) {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id });
      const last = chat.last_message;
      upsertDialog(account.id, {
        tgChatId: String(id), kind: KIND(chat), title: chat.title || '', username: '',
        lastText: last ? contentText(last.content) : '', lastAt: last ? last.date * 1000 : 0, lastOut: !!last?.is_outgoing, unread: chat.unread_count || 0,
      });
    } catch {
      /* skip a chat TDLib can't describe */
    }
  }
  return { dialogs: listDialogs(account.id) };
}
