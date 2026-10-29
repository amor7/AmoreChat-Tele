import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { settingNumber } from '../settings.js';
import { getAccountForUser, liveClient, listDialogs, upsertDialog, onTeleUpdate, assertQuota, overQuota } from './accounts.js';
import { ensureEgress } from './egress.js';
import { ffmpeg, mediaReady } from '../media.js';

const UPLOADS = path.join(DATA_DIR, 'tele-uploads');
export const mediaMaxBytes = () => (settingNumber('tele_media_max_mb') || 5) * 1048576;

export function listStoredMessages(accountId, dialogId, { limit = 50, beforeTgId = null } = {}) {
  const n = Math.min(100, limit);
  // Telegram's own message ids give the real order (rows from a later "load older" have higher row ids).
  const rows = beforeTgId
    ? all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id < ? ORDER BY tg_msg_id DESC LIMIT ?`, accountId, dialogId, Number(beforeTgId), n)
    : all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? ORDER BY tg_msg_id IS NULL DESC, tg_msg_id DESC, id DESC LIMIT ?`, accountId, dialogId, n);
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
// Voice message: length, the waveform Telegram sends with it (for the bars) and the file to fetch on request.
function voiceInfo(content) {
  if (content?._ !== 'messageVoiceNote' || !content.voice_note) return null;
  const v = content.voice_note;
  return { type: 'voice', duration: v.duration || 0, mime: v.mime_type || '', size: v.voice?.size || v.voice?.expected_size || 0, remote: v.voice?.remote?.id || '', wave: v.waveform || '' };
}
// Files, videos, music and GIFs: name, size and the file to fetch on request (never on their own).
function fileInfo(content) {
  const pick = {
    messageDocument: [content?.document, content?.document?.document, 'fileTypeDocument'],
    messageVideo: [content?.video, content?.video?.video, 'fileTypeVideo'],
    messageAudio: [content?.audio, content?.audio?.audio, 'fileTypeAudio'],
    messageAnimation: [content?.animation, content?.animation?.animation, 'fileTypeAnimation'],
  }[content?._];
  if (!pick || !pick[0] || !pick[1]) return null;
  const [m, f, fileType] = pick;
  const video = content._ === 'messageVideo' || content._ === 'messageAnimation';
  const ext = video ? '.mp4' : content._ === 'messageAudio' ? '.mp3' : '';
  return {
    type: 'file', fileType, video, gif: content._ === 'messageAnimation',
    name: String(m.file_name || m.title || (video ? 'video' : 'file') + ext).slice(0, 200),
    mime: m.mime_type || '', size: f.size || f.expected_size || 0, remote: f.remote?.id || '',
    duration: m.duration || 0, w: m.width || 0, h: m.height || 0, mini: m.minithumbnail?.data || '',
  };
}
const mediaInfo = (content) => photoInfo(content) || voiceInfo(content) || fileInfo(content);
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
    voice: media?.type === 'voice' ? { duration: media.duration, wave: media.wave, size: media.size } : null,
    file: media?.type === 'file' ? { name: media.name, size: media.size, mime: media.mime, video: media.video, gif: media.gif, duration: media.duration, w: media.w, h: media.h, mini: media.mini } : null,
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
const kindOf = (content) => ({ messageText: 'text', messagePhoto: 'photo', messageVoiceNote: 'voice', messageDocument: 'file', messageVideo: 'file', messageAudio: 'file', messageAnimation: 'file' })[content?._] || 'other';

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
    createdAt: m.date ? m.date * 1000 : now(), senderId: s.id, senderName: s.name, replyTo: replyIdOf(m), media: mediaInfo(m.content),
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
onTeleUpdate((accountId, u) => {
  applySent(accountId, u);
  applyChange(accountId, u);
});

// Deleted and edited in Telegram (by anyone): the same here, for the chats that are stored.
function applyChange(accountId, u) {
  if (u._ !== 'updateDeleteMessages' && u._ !== 'updateMessageContent') return;
  const dialog = get('SELECT id FROM tele_dialogs WHERE account_id = ? AND tg_chat_id = ?', accountId, String(u.chat_id));
  if (!dialog) return;
  if (u._ === 'updateDeleteMessages') {
    // from_cache: TDLib only dropped its local copy; the message still exists.
    if (!u.is_permanent || u.from_cache || !u.message_ids?.length) return;
    run(`DELETE FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id IN (${u.message_ids.map(() => '?').join(',')})`, accountId, dialog.id, ...u.message_ids);
    return;
  }
  const media = mediaInfo(u.new_content);
  run(
    'UPDATE tele_messages SET text = ?, kind = ?, media = COALESCE(?, media) WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?',
    contentText(u.new_content).slice(0, 8000), kindOf(u.new_content), media ? JSON.stringify(media) : null, accountId, dialog.id, u.message_id,
  );
}
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
  const media = mediaInfo(m.content);
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
  const client = await liveClient(account).catch((e) => {
    if (e.quota) return null;
    throw e;
  });
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
  assertQuota(account);
  let client;
  try {
    await ensureEgress();
    client = await liveClient(account);
  } catch (e) {
    // No tunnel right now (all proxies down…): keep the message and send it once it is back.
    if (e.egress) return queueContent(account, dialog, content, { replyTo, text, kind, media });
    throw e;
  }
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
  const row = storeMessage(account.id, dialog.id, { tgMsgId: result?.id, direction: 'out', kind, text, createdAt: t, replyTo, media: media || mediaInfo(result?.content) });
  const confirmed = early.get(`${account.id}:${result?.id}`);
  if (confirmed) {
    early.delete(`${account.id}:${result.id}`);
    applySent(account.id, confirmed);
    return publicMessage(get('SELECT * FROM tele_messages WHERE id = ?', row.id));
  }
  return publicMessage(row);
}

// ---------- Waiting for the tunnel ----------
// A message sent while the tunnel is down is stored as "queued" (no Telegram id yet) and sent, in
// order, once a proxy works again. Nothing leaves the server before that: fail-closed as ever.
function queueContent(account, dialog, content, { replyTo, text, kind, media }) {
  const row = storeMessage(account.id, dialog.id, { tgMsgId: null, direction: 'out', kind: 'queued', text, createdAt: now(), replyTo, media });
  run('INSERT INTO tele_queue (account_id, dialog_id, message_id, content, created_at) VALUES (?, ?, ?, ?, ?)', account.id, dialog.id, row.id, JSON.stringify({ content, replyTo, kind }), now());
  upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, lastText: text, lastAt: now(), lastOut: true });
  return publicMessage(row);
}

let flushing = false;
/** Sends queued messages (oldest first) when the tunnel is up; called every few seconds. */
export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const items = all('SELECT q.*, d.tg_chat_id FROM tele_queue q JOIN tele_dialogs d ON d.id = q.dialog_id ORDER BY q.id');
    for (const q of items) {
      const account = get('SELECT * FROM tele_accounts WHERE id = ?', q.account_id);
      if (!account || account.status !== 'connected') {
        run("UPDATE tele_messages SET kind = 'failed' WHERE id = ?", q.message_id);
        run('DELETE FROM tele_queue WHERE id = ?', q.id);
        continue;
      }
      if (overQuota(account)) continue;
      let client;
      try {
        await ensureEgress();
        client = await liveClient(account);
      } catch (e) {
        if (e.egress) break; // still no tunnel: try again later
        continue;
      }
      if (!client) continue;
      const c = JSON.parse(q.content);
      try {
        const result = await client.invoke({
          _: 'sendMessage',
          chat_id: Number(q.tg_chat_id),
          ...(c.replyTo ? { reply_to: { _: 'inputMessageReplyToMessage', message_id: Number(c.replyTo) } } : {}),
          input_message_content: c.content,
        });
        // From here on like any sent message: the temporary id, then the final one (applySent).
        run('UPDATE tele_messages SET tg_msg_id = ?, kind = ?, created_at = ? WHERE id = ?', result.id, c.kind || 'text', result.date ? result.date * 1000 : now(), q.message_id);
        run('DELETE FROM tele_queue WHERE id = ?', q.id);
        const confirmed = early.get(`${account.id}:${result.id}`);
        if (confirmed) {
          early.delete(`${account.id}:${result.id}`);
          applySent(account.id, confirmed);
        }
      } catch (e) {
        // Telegram refused it (chat gone, no right to write…): after a few tries it is marked failed.
        if (q.attempts + 1 >= 5) {
          run("UPDATE tele_messages SET kind = 'failed' WHERE id = ?", q.message_id);
          run('DELETE FROM tele_queue WHERE id = ?', q.id);
        } else {
          run('UPDATE tele_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?', String(e?.message || e).slice(0, 300), q.id);
        }
      }
    }
  } finally {
    flushing = false;
  }
}
setInterval(() => flushQueue().catch(() => {}), Number(process.env.TELE_QUEUE_MS) || 10000).unref();

/** Takes back a message that is still waiting for the tunnel. */
export function cancelQueued(userId, messageId) {
  const account = getAccountForUser(userId);
  const row = account && get('SELECT * FROM tele_messages WHERE id = ? AND account_id = ?', Number(messageId), account.id);
  if (!row) throw Object.assign(new Error('پیام پیدا نشد'), { statusCode: 404 });
  if (row.kind !== 'queued') throw Object.assign(new Error('این پیام فرستاده شده و قابل پس گرفتن نیست'), { statusCode: 400 });
  run('DELETE FROM tele_messages WHERE id = ?', row.id);
  return { ok: true };
}

export async function sendTeleMessage(userId, dialogId, text, replyTo = null) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('متن خالی است'), { statusCode: 400 });
  return sendContent(userId, dialogId, { _: 'inputMessageText', text: { _: 'formattedText', text: body } }, { replyTo, text: body });
}

// ---------- Photos: only for accounts an admin allowed, and up to the size limit ----------
function mediaAccount(userId, kind = 'photo') {
  const account = getAccountForUser(userId);
  if (kind === 'voice' ? !account?.allow_voice : !account?.allow_media) {
    throw Object.assign(new Error(kind === 'voice' ? 'دسترسی به پیام صوتی تلگرام برای شما فعال نیست' : 'دسترسی به عکس‌های تلگرام برای شما فعال نیست'), { statusCode: 403 });
  }
  return account;
}

/** Sends a photo the user uploaded (a temporary file, removed after a day). */
export async function sendTelePhoto(userId, dialogId, file, { caption = '', replyTo = null } = {}) {
  mediaAccount(userId);
  const text = String(caption || '').trim();
  const content = { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: file } }, caption: text ? { _: 'formattedText', text } : undefined };
  return sendContent(userId, dialogId, content, { replyTo, text: text ? `📷 عکس\n${text}` : '📷 عکس', kind: 'photo' });
}
export function newUploadPath(ext = '.jpg') {
  fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o700 });
  // TDLib uploads in the background after sendMessage returns: keep files a day, then clean up.
  for (const f of fs.readdirSync(UPLOADS)) {
    const p = path.join(UPLOADS, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true, recursive: true });
    } catch {
      /* ignore */
    }
  }
  return path.join(UPLOADS, crypto.randomBytes(12).toString('hex') + ext);
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
  let client;
  try {
    client = await liveClient(account);
  } catch (e) {
    if (e.quota) return { dialogs: listDialogs(account.id), notice: e.message };
    throw e;
  }
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

// ---------- Voice messages: only for accounts an admin allowed, and up to the size limit ----------

/**
 * A message's voice file, downloaded through the tunnel on first request. Telegram voice is
 * Ogg/Opus, which iPhones can't play: it is converted to AAC (m4a) once when ffmpeg is there.
 */
export async function teleVoiceFile(userId, messageId) {
  const account = mediaAccount(userId, 'voice');
  const row = get('SELECT * FROM tele_messages WHERE id = ? AND account_id = ?', Number(messageId), account.id);
  const media = parseMedia(row?.media);
  if (media?.type !== 'voice' || !media.remote) throw Object.assign(new Error('پیام صوتی پیدا نشد'), { statusCode: 404 });
  if (media.size > mediaMaxBytes()) throw Object.assign(new Error(`حجم این پیام صوتی بیشتر از سقف مجاز (${settingNumber('tele_media_max_mb') || 5} مگابایت) است`), { statusCode: 413 });
  const client = await liveClient(account);
  if (!client) throw Object.assign(new Error('اتصال به تلگرام برقرار نیست'), { statusCode: 503, expose: true });
  let file = await client.invoke({ _: 'getRemoteFile', remote_file_id: media.remote, file_type: { _: 'fileTypeVoiceNote' } });
  if (!file.local?.is_downloading_completed) {
    await ensureEgress();
    file = await client.invoke({ _: 'downloadFile', file_id: file.id, priority: 16, offset: 0, limit: 0, synchronous: true });
  }
  const src = file.local?.path;
  if (!src || !fs.existsSync(src)) throw Object.assign(new Error('دانلود پیام صوتی ناموفق بود'), { statusCode: 502, expose: true });
  const m4a = src + '.m4a';
  if (!fs.existsSync(m4a) && (await mediaReady)) {
    try {
      await ffmpeg(['-y', '-i', src, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart', m4a]);
    } catch {
      fs.rmSync(m4a, { force: true });
    }
  }
  return fs.existsSync(m4a) ? { file: m4a, type: 'audio/mp4' } : { file: src, type: 'audio/ogg' };
}

/** Sends a recorded voice message: converted to Ogg/Opus (what Telegram plays as a voice message). */
export async function sendTeleVoice(userId, dialogId, file, { duration = 0, caption = '', replyTo = null } = {}) {
  mediaAccount(userId, 'voice');
  const out = file.replace(/\.[^.\/]+$/, '') + '.voice.ogg';
  if (await mediaReady) {
    try {
      await ffmpeg(['-y', '-i', file, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', out]);
    } catch {
      throw Object.assign(new Error('فایل صوتی قابل تبدیل نبود'), { statusCode: 400 });
    } finally {
      fs.rmSync(file, { force: true });
    }
  } else {
    throw Object.assign(new Error('برای ارسال پیام صوتی ffmpeg روی سرور لازم است'), { statusCode: 503, expose: true });
  }
  const text = String(caption || '').trim();
  const dur = Math.max(1, Math.min(3600, Math.round(Number(duration) || 1)));
  const content = {
    _: 'inputMessageVoiceNote',
    voice_note: { _: 'inputVoiceNote', voice_note: { _: 'inputFileLocal', path: out }, duration: dur, waveform: '' },
    caption: text ? { _: 'formattedText', text } : undefined,
  };
  return sendContent(userId, dialogId, content, { replyTo, text: text ? `🎤 پیام صوتی\n${text}` : '🎤 پیام صوتی', kind: 'voice' });
}

/** A stored Telegram message of this user (for forwarding it into the app's own chats). */
export function ownTeleMessage(userId, messageId) {
  const account = getAccountForUser(userId);
  const row = account && get('SELECT * FROM tele_messages WHERE id = ? AND account_id = ?', Number(messageId), account.id);
  if (!row) throw Object.assign(new Error('پیام پیدا نشد'), { statusCode: 404 });
  const dialog = get('SELECT * FROM tele_dialogs WHERE id = ?', row.dialog_id);
  return { account, row, dialog, media: parseMedia(row.media) };
}

// ---------- Files and videos: only for accounts an admin allowed, and up to their own size limit ----------
export const fileMaxBytes = () => (settingNumber('tele_file_max_mb') || 20) * 1048576;
function filesAccount(userId) {
  const account = getAccountForUser(userId);
  if (!account?.allow_files) throw Object.assign(new Error('دسترسی به فایل‌های تلگرام برای شما فعال نیست'), { statusCode: 403 });
  return account;
}
/** A message's file, downloaded through the tunnel on first request. */
export async function teleFileFile(userId, messageId) {
  const account = filesAccount(userId);
  const row = get('SELECT * FROM tele_messages WHERE id = ? AND account_id = ?', Number(messageId), account.id);
  const media = parseMedia(row?.media);
  if (media?.type !== 'file' || !media.remote) throw Object.assign(new Error('فایل پیدا نشد'), { statusCode: 404 });
  if (media.size > fileMaxBytes()) throw Object.assign(new Error(`حجم این فایل بیشتر از سقف مجاز (${settingNumber('tele_file_max_mb') || 20} مگابایت) است`), { statusCode: 413 });
  const client = await liveClient(account);
  if (!client) throw Object.assign(new Error('اتصال به تلگرام برقرار نیست'), { statusCode: 503, expose: true });
  let file = await client.invoke({ _: 'getRemoteFile', remote_file_id: media.remote, file_type: { _: media.fileType || 'fileTypeDocument' } });
  if (!file.local?.is_downloading_completed) {
    await ensureEgress();
    file = await client.invoke({ _: 'downloadFile', file_id: file.id, priority: 16, offset: 0, limit: 0, synchronous: true });
  }
  if (!file.local?.path || !fs.existsSync(file.local.path)) throw Object.assign(new Error('دانلود فایل ناموفق بود'), { statusCode: 502, expose: true });
  return { file: file.local.path, name: media.name, mime: media.mime, video: media.video };
}
/** A temporary folder for an upload, so Telegram shows the file under its own name. */
export function newUploadFile(name) {
  const dir = newUploadPath('');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  return path.join(dir, safe);
}
/** Sends a file (a video as a playable video). */
export async function sendTeleFile(userId, dialogId, file, { mime = '', caption = '', replyTo = null } = {}) {
  filesAccount(userId);
  const text = String(caption || '').trim();
  const name = path.basename(file);
  const cap = text ? { _: 'formattedText', text } : undefined;
  const content = /^video\/(mp4|quicktime|webm)$/.test(mime)
    ? { _: 'inputMessageVideo', video: { _: 'inputFileLocal', path: file }, supports_streaming: true, caption: cap }
    : { _: 'inputMessageDocument', document: { _: 'inputFileLocal', path: file }, caption: cap };
  return sendContent(userId, dialogId, content, { replyTo, text: text ? `📎 ${name}\n${text}` : `📎 ${name}`, kind: 'file' });
}
