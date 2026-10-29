import { get, all, run, now } from '../db.js';
import { getAccountForUser, liveClient, listDialogs, upsertDialog } from './accounts.js';
import { ensureEgress } from './egress.js';

export function listStoredMessages(accountId, dialogId, { limit = 50, beforeTgId = null } = {}) {
  const n = Math.min(100, limit);
  // Telegram's own message ids give the real order (rows from a later "load older" have higher row ids).
  const rows = beforeTgId
    ? all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id < ? ORDER BY tg_msg_id DESC LIMIT ?`, accountId, dialogId, Number(beforeTgId), n)
    : all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? ORDER BY tg_msg_id DESC, id DESC LIMIT ?`, accountId, dialogId, n);
  return rows.reverse();
}
export function publicMessage(row) {
  if (!row) return null;
  return {
    id: row.id, dialogId: row.dialog_id, tgMsgId: row.tg_msg_id, direction: row.direction, kind: row.kind, text: row.text,
    mediaPath: row.media_path || '', createdAt: row.created_at, senderId: row.sender_id || '', senderName: row.sender_name || '',
  };
}
function storeMessage(accountId, dialogId, { tgMsgId, direction, kind, text, createdAt, senderId = '', senderName = '' }) {
  try {
    const r = run(
      `INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, direction, kind, text, media_path, created_at, sender_id, sender_name) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      accountId, dialogId, tgMsgId != null ? Number(tgMsgId) : null, direction || 'in', kind || 'text', String(text || '').slice(0, 8000), '', createdAt || now(), String(senderId), senderName,
    );
    return get('SELECT * FROM tele_messages WHERE id = ?', Number(r.lastInsertRowid));
  } catch (e) {
    if (!/UNIQUE/i.test(String(e.message))) throw e;
    // Already stored: fill in what older versions did not keep (sender, real date).
    run(
      `UPDATE tele_messages SET sender_id = ?, sender_name = ?, created_at = ?, text = ?, kind = ? WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?`,
      String(senderId), senderName, createdAt || now(), String(text || '').slice(0, 8000), kind || 'text', accountId, dialogId, Number(tgMsgId),
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

async function storeTdMessages(client, accountId, dialogId, messages) {
  for (const m of messages) {
    const s = await senderOf(client, m.sender_id);
    storeMessage(accountId, dialogId, {
      tgMsgId: m.id, direction: m.is_outgoing ? 'out' : 'in', kind: m.content?._ === 'messageText' ? 'text' : 'other',
      text: contentText(m.content), createdAt: m.date ? m.date * 1000 : now(), senderId: s.id, senderName: s.name,
    });
  }
}

function ownDialog(userId, dialogId) {
  const account = getAccountForUser(userId);
  if (!account) throw Object.assign(new Error('حساب تلگرام وصل نیست'), { statusCode: 400 });
  const dialog = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), account.id);
  if (!dialog) throw Object.assign(new Error('گفتگو پیدا نشد'), { statusCode: 404 });
  return { account, dialog };
}

/**
 * Latest messages of a chat (or older ones with `before` = a Telegram message id). Opening a chat
 * adds it to the user's chats and marks it read in Telegram, like opening it in a Telegram app.
 * `local`: the periodic check while the chat is open. TDLib already received new messages as
 * updates, so it answers from its own database without any network traffic.
 */
export async function syncDialogMessages(userId, dialogId, { limit = 40, before = null, local = false } = {}) {
  const { account, dialog } = ownDialog(userId, dialogId);
  if (!dialog.selected) run('UPDATE tele_dialogs SET selected = 1, updated_at = ? WHERE id = ?', now(), dialog.id);
  const n = Math.min(50, limit);
  const client = await liveClient(account);
  if (!client) return { messages: listStoredMessages(account.id, dialog.id, { limit: n, beforeTgId: before }).map(publicMessage), notice: 'حساب تلگرام وصل نیست' };
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
    const last = msgs[0];
    if (last) upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, lastText: contentText(last.content), lastAt: last.date * 1000, lastOut: last.is_outgoing, unread: 0 });
    else upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, unread: 0 });
    // Mark as read in Telegram on opening, and when new incoming messages showed up.
    const unseen = local ? msgs.filter((m) => m.id > newest && !m.is_outgoing) : msgs;
    if (unseen.length) {
      await client.invoke({ _: 'viewMessages', chat_id: chatId, message_ids: unseen.map((m) => m.id), force_read: true }).catch(() => {});
    }
  }
  return {
    messages: listStoredMessages(account.id, dialog.id, { limit: before ? n : Math.max(n, 40), beforeTgId: before }).map(publicMessage),
    hasMore: msgs.length > 0,
  };
}

/** Search one chat's whole Telegram history (results are kept like other messages). */
export async function searchDialogMessages(userId, dialogId, query) {
  const q = String(query || '').trim();
  if (q.length < 2) throw Object.assign(new Error('حداقل ۲ حرف بنویسید'), { statusCode: 400 });
  const { account, dialog } = ownDialog(userId, dialogId);
  const client = await liveClient(account);
  if (!client) {
    const rows = all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND text LIKE ? ORDER BY tg_msg_id DESC LIMIT 50`, account.id, dialog.id, `%${q}%`);
    return { messages: rows.map(publicMessage) };
  }
  await ensureEgress();
  const found = await client.invoke({ _: 'searchChatMessages', chat_id: Number(dialog.tg_chat_id), query: q, from_message_id: 0, offset: 0, limit: 50 });
  await storeTdMessages(client, account.id, dialog.id, found?.messages || []);
  const ids = (found?.messages || []).map((m) => m.id);
  if (!ids.length) return { messages: [] };
  const rows = all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id IN (${ids.map(() => '?').join(',')}) ORDER BY tg_msg_id DESC`, account.id, dialog.id, ...ids);
  return { messages: rows.map(publicMessage) };
}

export async function sendTeleMessage(userId, dialogId, text) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('متن خالی است'), { statusCode: 400 });
  const { account, dialog } = ownDialog(userId, dialogId);
  if (account.status !== 'connected') throw Object.assign(new Error('حساب وصل نیست'), { statusCode: 400 });
  await ensureEgress();
  const client = await liveClient(account);
  if (!client) throw Object.assign(new Error('اتصال به تلگرام برقرار نیست'), { statusCode: 503, expose: true });
  const result = await client.invoke({ _: 'sendMessage', chat_id: Number(dialog.tg_chat_id), input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: body } } });
  const t = result?.date ? result.date * 1000 : now();
  upsertDialog(account.id, { tgChatId: dialog.tg_chat_id, lastText: body, lastAt: t, lastOut: true });
  return publicMessage(storeMessage(account.id, dialog.id, { tgMsgId: result?.id, direction: 'out', kind: 'text', text: body, createdAt: t }));
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
