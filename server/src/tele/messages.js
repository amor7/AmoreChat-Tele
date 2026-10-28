import { get, all, run, now } from '../db.js';
import { getAccountForUser, getLiveClient, listDialogs, upsertDialog } from './accounts.js';
import { ensureEgress } from './egress.js';

export function listStoredMessages(accountId, dialogId, { limit = 50 } = {}) {
  return all(`SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? ORDER BY id DESC LIMIT ?`, accountId, dialogId, Math.min(100, limit)).reverse();
}
export function publicMessage(row) {
  if (!row) return null;
  return { id: row.id, dialogId: row.dialog_id, tgMsgId: row.tg_msg_id, direction: row.direction, kind: row.kind, text: row.text, mediaPath: row.media_path || '', createdAt: row.created_at };
}
function storeMessage(accountId, dialogId, { tgMsgId, direction, kind, text }) {
  try {
    const r = run(`INSERT INTO tele_messages (account_id, dialog_id, tg_msg_id, direction, kind, text, media_path, created_at) VALUES (?,?,?,?,?,?,?,?)`, accountId, dialogId, tgMsgId != null ? Number(tgMsgId) : null, direction || 'in', kind || 'text', String(text || '').slice(0, 8000), '', now());
    return get('SELECT * FROM tele_messages WHERE id = ?', Number(r.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return get('SELECT * FROM tele_messages WHERE account_id = ? AND dialog_id = ? AND tg_msg_id = ?', accountId, dialogId, Number(tgMsgId));
    throw e;
  }
}
export async function syncDialogMessages(userId, dialogId, { limit = 30 } = {}) {
  const account = getAccountForUser(userId);
  if (!account) throw Object.assign(new Error('حساب تلگرام وصل نیست'), { statusCode: 400 });
  const dialog = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), account.id);
  if (!dialog?.selected) throw Object.assign(new Error('گفتگو انتخاب نشده'), { statusCode: 400 });
  await ensureEgress();
  const client = getLiveClient(account.id);
  if (!client) return { messages: listStoredMessages(account.id, dialog.id).map(publicMessage), notice: 'TDLib فعال نیست' };
  const hist = await client.invoke({ _: 'getChatHistory', chat_id: Number(dialog.tg_chat_id), from_message_id: 0, offset: 0, limit: Math.min(50, limit), only_local: false });
  for (const m of (hist?.messages || []).reverse()) {
    const text = m.content?._ === 'messageText' ? m.content.text?.text || '' : m.content?._ || '';
    storeMessage(account.id, dialog.id, { tgMsgId: m.id, direction: m.is_outgoing ? 'out' : 'in', kind: m.content?._ === 'messageText' ? 'text' : 'other', text });
  }
  return { messages: listStoredMessages(account.id, dialog.id).map(publicMessage) };
}
export async function sendTeleMessage(userId, dialogId, text) {
  const body = String(text || '').trim();
  if (!body) throw Object.assign(new Error('متن خالی است'), { statusCode: 400 });
  const account = getAccountForUser(userId);
  if (!account || account.status !== 'connected') throw Object.assign(new Error('حساب وصل نیست'), { statusCode: 400 });
  const dialog = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), account.id);
  if (!dialog?.selected) throw Object.assign(new Error('گفتگو پیدا نشد'), { statusCode: 404 });
  await ensureEgress();
  const client = getLiveClient(account.id);
  if (!client) throw Object.assign(new Error('TDLib نصب نیست'), { statusCode: 503 });
  const result = await client.invoke({ _: 'sendMessage', chat_id: Number(dialog.tg_chat_id), input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: body } } });
  return publicMessage(storeMessage(account.id, dialog.id, { tgMsgId: result?.id, direction: 'out', kind: 'text', text: body }));
}
export async function refreshDialogsFromTelegram(userId) {
  const account = getAccountForUser(userId);
  if (!account) throw Object.assign(new Error('حساب وصل نیست'), { statusCode: 400 });
  await ensureEgress();
  const client = getLiveClient(account.id);
  if (!client) return { dialogs: listDialogs(account.id), notice: 'TDLib فعال نیست' };
  const chats = await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 100 });
  for (const id of chats?.chat_ids || []) {
    try {
      const chat = await client.invoke({ _: 'getChat', chat_id: id });
      const kind = chat.type?._ === 'chatTypePrivate' ? 'private' : chat.type?._ === 'chatTypeSupergroup' && chat.type?.is_channel ? 'channel' : 'group';
      upsertDialog(account.id, { tgChatId: String(id), kind, title: chat.title || '', username: '' });
    } catch {}
  }
  return { dialogs: listDialogs(account.id) };
}
