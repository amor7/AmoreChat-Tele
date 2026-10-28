import { get, all, now, parseJSON } from './db.js';

// Notification stream for the Android app (server-sent events). The app keeps one light
// connection open in the background, so notifications arrive without Google's push service,
// which is unreachable during international internet shutdowns.
const streams = new Map(); // userId -> Set({ res, sessionId })

export function addStream(userId, sessionId, res) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  const entry = { res, sessionId };
  streams.get(userId).add(entry);
  return () => {
    streams.get(userId)?.delete(entry);
    if (!streams.get(userId)?.size) streams.delete(userId);
  };
}

export function pushTo(userIds, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const id of userIds) for (const s of streams.get(id) || []) s.res.write(data);
}

// Logged-out devices and banned users lose their stream too.
export function closeStreams({ userId, sessionIds } = {}) {
  for (const [uid, set] of streams) {
    for (const s of set) {
      if (uid === userId || sessionIds?.includes(s.sessionId)) s.res.end();
    }
  }
}

function preview(m) {
  const caption = m.text ? ` ${m.text}` : '';
  switch (m.type) {
    case 'image':
      return `📷 عکس${caption}`;
    case 'video':
      return `🎬 ویدیو${caption}`;
    case 'voice':
      return '🎤 پیام صوتی';
    case 'file':
      return `📎 ${m.file?.name || 'فایل'}${caption}`;
    case 'call': {
      const c = parseJSON(m.text, {});
      return c.status === 'missed' ? '📞 تماس بی‌پاسخ' : '📞 تماس';
    }
    default:
      return String(m.text || '').slice(0, 300);
  }
}

// Called for every new message: tells the members' phones, respecting per-chat mute
// (an @mention or a reply to you still gets through).
export function notifyMessage(msg, senderId) {
  if (!streams.size || msg.type === 'system') return;
  const chat = get('SELECT id, type, title, avatar_file_id FROM chats WHERE id = ?', msg.chatId);
  if (!chat) return;
  const members = all('SELECT user_id, notify_muted_until FROM chat_members WHERE chat_id = ?', chat.id);
  for (const m of members) {
    if (!streams.has(m.user_id)) continue;
    if (msg.type === 'call') {
      // Only the person who missed the call hears about it.
      const c = parseJSON(msg.text, {});
      if (c.status !== 'missed' || m.user_id === senderId) continue;
    } else if (m.user_id === senderId) continue;
    const mentioned = (msg.mentions || []).includes(m.user_id);
    if (m.notify_muted_until && m.notify_muted_until > now() && !mentioned) continue;
    const name = msg.sender?.displayName || '';
    const title = chat.type === 'dm' ? name : chat.type === 'saved' ? 'پیام‌های ذخیره‌شده' : chat.title;
    const body = chat.type === 'group' && name ? `${name}: ${preview(msg)}` : preview(msg);
    pushTo([m.user_id], {
      type: 'message',
      chatId: chat.id,
      messageId: msg.id,
      title,
      body,
      mentioned,
      // For a conversation-style notification with the sender's picture (app 0.8+).
      text: preview(msg),
      senderId: msg.sender?.id || 0,
      senderName: name,
      senderAvatar: msg.sender?.avatar || null,
      chatAvatar: chat.type === 'dm' ? msg.sender?.avatar || null : chat.avatar_file_id || null,
      group: chat.type === 'group' || chat.type === 'channel',
    });
  }
}
