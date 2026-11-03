import { get, all, now, parseJSON } from './db.js';
import { loadMessage } from './chats.js';

// Notification stream for the Android app (server-sent events). The app keeps one light
// connection open in the background, so notifications arrive without Google's push service,
// which is unreachable during international internet shutdowns.
const streams = new Map(); // userId -> Set({ res, sessionId })

export function addStream(userId, sessionId, res, { ip = '', owner = false } = {}) {
  if (!streams.has(userId)) streams.set(userId, new Set());
  const entry = { res, sessionId, ip, owner };
  const set = streams.get(userId);
  // A phone keeps one; a handful covers several devices. More is a leak or abuse: the oldest go.
  while (set.size >= 8) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    oldest.res.end();
  }
  set.add(entry);
  return () => {
    streams.get(userId)?.delete(entry);
    if (!streams.get(userId)?.size) streams.delete(userId);
  };
}

// `id` is what the app sends back as Last-Event-ID when it reconnects.
export const frame = (event) => `${event.messageId ? `id: ${event.messageId}\n` : ''}data: ${JSON.stringify(event)}\n\n`;

export function pushTo(userIds, event) {
  const data = frame(event);
  for (const id of userIds) for (const s of streams.get(id) || []) s.res.write(data);
}

// Logged-out devices, banned users and banned IPs (except the owner's) lose their stream too.
export function closeStreams({ userId, sessionIds, ip } = {}) {
  for (const [uid, set] of streams) {
    for (const s of set) {
      if (uid === userId || sessionIds?.includes(s.sessionId) || (ip && s.ip === ip && !s.owner)) s.res.end();
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

// The notification for one member, or null when they shouldn't get one (per-chat mute;
// an @mention or a reply to you still gets through).
function eventFor(msg, chat, member, senderId) {
  if (msg.type === 'call') {
    // Only the person who missed the call hears about it.
    const c = parseJSON(msg.text, {});
    if (c.status !== 'missed' || member.user_id === senderId) return null;
  } else if (member.user_id === senderId) return null;
  const mentioned = (msg.mentions || []).includes(member.user_id);
  if (member.notify_muted_until && member.notify_muted_until > now() && !mentioned) return null;
  const name = msg.sender?.displayName || '';
  const title = chat.type === 'dm' ? name : chat.type === 'saved' ? 'پیام‌های ذخیره‌شده' : chat.title;
  const body = chat.type === 'group' && name ? `${name}: ${preview(msg)}` : preview(msg);
  return {
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
  };
}

const chatOf = (id) => get('SELECT id, type, title, avatar_file_id FROM chats WHERE id = ?', id);

// Called for every new message: tells the members' phones.
export function notifyMessage(msg, senderId) {
  if (!streams.size || msg.type === 'system') return;
  const chat = chatOf(msg.chatId);
  if (!chat) return;
  const members = all('SELECT user_id, notify_muted_until FROM chat_members WHERE chat_id = ?', chat.id);
  for (const m of members) {
    if (!streams.has(m.user_id)) continue;
    const event = eventFor(msg, chat, m, senderId);
    if (event) pushTo([m.user_id], event);
  }
}

const MISSED_MAX = 30;
const MISSED_AGE = 24 * 3600 * 1000;

// A phone that lost its stream for a moment: unread messages newer than the last one it saw,
// oldest first. Nothing about what is already read, or from long ago (the app shows those).
export function missedEvents(userId, afterId) {
  const rows = all(
    `SELECT m.id, cm.notify_muted_until FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
      WHERE m.id > ? AND m.id > cm.last_read AND m.deleted = 0 AND m.type != 'system'
        AND m.created_at > ? AND IFNULL(m.sender_id, 0) != ?
      ORDER BY m.id DESC LIMIT ?`,
    userId,
    afterId,
    now() - MISSED_AGE,
    userId,
    MISSED_MAX,
  );
  const events = [];
  for (const r of rows.reverse()) {
    const msg = loadMessage(r.id);
    const chat = msg && chatOf(msg.chatId);
    const event = chat && eventFor(msg, chat, { user_id: userId, notify_muted_until: r.notify_muted_until }, msg.sender?.id);
    if (event) events.push(event);
  }
  return events;
}

export const lastMessageId = () => get('SELECT MAX(id) AS id FROM messages').id || 0;
