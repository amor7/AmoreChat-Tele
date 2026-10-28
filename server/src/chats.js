import { get, all, run, now, tx, parseJSON } from './db.js';
import { toChat, toUser, joinChat, leaveChat, isOnline } from './realtime.js';
import { hasSitePerm } from './perms.js';
import { notifyMessage } from './push.js';
import { kickFromVoice } from './voice.js';

export function fail(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  throw e;
}

export const getChat = (chatId) => get('SELECT * FROM chats WHERE id = ?', chatId);
export const getMember = (chatId, userId) =>
  get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, userId);

const MSG_SELECT = `
  SELECT m.*,
    u.display_name AS sender_name, u.username AS sender_username, u.avatar_file_id AS sender_avatar,
    f.mime AS f_mime, f.size AS f_size, f.name AS f_name, f.kind AS f_kind,
    f.width AS f_w, f.height AS f_h, f.duration AS f_dur, f.status AS f_status,
    f.variants AS f_variants, f.thumb AS f_thumb, f.waveform AS f_wave, f.purged AS f_purged,
    ch.type AS chat_type, ch.title AS chat_title, ch.avatar_file_id AS chat_avatar, r.text AS r_text, r.type AS r_type, r.deleted AS r_deleted, ru.display_name AS r_sender
  FROM messages m
  LEFT JOIN users u ON u.id = m.sender_id
  LEFT JOIN files f ON f.id = m.file_id
  LEFT JOIN messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.sender_id
  LEFT JOIN chats ch ON ch.id = m.chat_id`;

// Reactions grouped per emoji: [{ emoji, users: [userId, ...] }]
function reactionsFor(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = all(
    'SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at',
    JSON.stringify(ids),
  );
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, new Map());
    const byEmoji = out.get(r.message_id);
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  return new Map([...out].map(([id, m]) => [id, [...m].map(([emoji, users]) => ({ emoji, users }))]));
}

function withReactions(rows) {
  const reactions = reactionsFor(rows.filter((m) => !m.deleted).map((m) => m.id));
  return rows.map((m) => serializeMessage(m, reactions.get(m.id)));
}

// Every serialized copy of a message gets a strictly increasing version: when updates of one
// message cross (an HTTP reply and the live broadcast of a later change), clients keep the newest.
let lastVersion = 0;
const nextVersion = () => (lastVersion = Math.max(lastVersion + 1, Date.now() * 1000));

export function serializeMessage(m, reactions = []) {
  if (!m) return null;
  const deleted = !!m.deleted;
  return {
    id: m.id,
    v: nextVersion(),
    chatId: m.chat_id,
    type: deleted ? 'deleted' : m.type,
    text: deleted ? '' : m.text,
    // Channel posts appear under the channel's name (like Telegram): subscribers never learn who the admins are.
    sender: !m.sender_id
      ? null
      : m.chat_type === 'channel'
        ? { id: 0, displayName: m.chat_title, username: '', avatar: m.chat_avatar, channel: true }
        : { id: m.sender_id, displayName: m.sender_name, username: m.sender_username, avatar: m.sender_avatar },
    file:
      !deleted && m.file_id
        ? {
            id: m.file_id,
            mime: m.f_mime,
            size: m.f_size,
            name: m.f_name,
            kind: m.f_kind,
            width: m.f_w,
            height: m.f_h,
            duration: m.f_dur,
            status: m.f_status,
            purged: !!m.f_purged,
            thumb: !!m.f_thumb,
            waveform: m.f_wave,
            variants: parseJSON(m.f_variants, []).map((v) => ({ q: v.q, size: v.size })),
          }
        : null,
    // Channels: anonymous reactions (counts only), like Telegram. `mine` is added per request.
    reactions: deleted ? [] : m.chat_type === 'channel' ? reactions.map((r) => ({ emoji: r.emoji, users: [], count: r.users.length })) : reactions,
    forwardedFrom: m.forwarded_from,
    expiresAt: m.expires_at,
    replyTo: m.reply_to
      ? {
          id: m.reply_to,
          text: m.r_deleted ? '' : m.r_text,
          type: m.r_deleted ? 'deleted' : m.r_type,
          sender: m.chat_type === 'channel' ? m.chat_title : m.r_sender,
        }
      : null,
    editedAt: m.edited_at,
    pinned: !!m.pinned,
    mentions: deleted || !m.mentions ? [] : parseJSON(m.mentions, []),
    createdAt: m.created_at,
  };
}

// Members named as @username in the text, plus the author of the replied-to message
// (like Telegram). These users are notified even when they muted the chat.
export function findMentions(chatId, text, replyTo = null, senderId = null) {
  const names = [...new Set([...String(text || '').matchAll(/(?:^|[^\w@.])@([A-Za-z][A-Za-z0-9_]{2,31})/g)].map((x) => x[1].toLowerCase()))].slice(0, 50);
  const ids = new Set();
  if (names.length) {
    for (const r of all(
      'SELECT u.id FROM users u JOIN chat_members cm ON cm.user_id = u.id AND cm.chat_id = ? WHERE lower(u.username) IN (SELECT value FROM json_each(?))',
      chatId,
      JSON.stringify(names),
    ))
      ids.add(r.id);
  }
  if (replyTo) {
    const r = get('SELECT sender_id FROM messages WHERE id = ? AND chat_id = ?', replyTo, chatId);
    if (r?.sender_id) ids.add(r.sender_id);
  }
  ids.delete(senderId);
  return [...ids];
}

// Marks which anonymous (channel) reactions are the viewer's own.
export function withMine(messages, userId) {
  const anon = messages.filter((m) => m?.reactions?.some((r) => r.count != null));
  if (!anon.length) return messages;
  const rows = all(
    'SELECT message_id, emoji FROM reactions WHERE user_id = ? AND message_id IN (SELECT value FROM json_each(?))',
    userId,
    JSON.stringify(anon.map((m) => m.id)),
  );
  const mine = new Set(rows.map((r) => `${r.message_id}:${r.emoji}`));
  for (const m of anon) m.reactions = m.reactions.map((r) => ({ ...r, mine: mine.has(`${m.id}:${r.emoji}`) }));
  return messages;
}

// Channels always hide their member list from regular members; groups when the admin turns it on.
export const membersHidden = (chat) => chat.type === 'channel' || (chat.type === 'group' && !!chat.hide_members);
export const isChatStaff = (user, member) => hasSitePerm(user, 'manage_chats') || member?.role === 'owner' || member?.role === 'admin';

export function loadMessage(id) {
  const row = get(`${MSG_SELECT} WHERE m.id = ?`, id);
  return row ? withReactions([row])[0] : null;
}

// Pages of a chat's history. `before`: older than id; `after`: newer than id; `around`: centred on id.
export function loadMessages(chatId, { before, after, around, limit }) {
  let rows;
  if (around) {
    const half = Math.floor(limit / 2);
    const older = all(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id <= ? ORDER BY m.id DESC LIMIT ?`, chatId, around, half + 1);
    const newer = all(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`, chatId, around, half);
    rows = [...older.reverse(), ...newer];
  } else if (after) {
    rows = all(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?`, chatId, after, limit);
  } else if (before) {
    rows = all(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, chatId, before, limit).reverse();
  } else {
    rows = all(`${MSG_SELECT} WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT ?`, chatId, limit).reverse();
  }
  return withReactions(rows);
}

export const loadMessagesByIds = (ids) =>
  ids.length ? withReactions(all(`${MSG_SELECT} WHERE m.id IN (SELECT value FROM json_each(?)) ORDER BY m.id DESC`, JSON.stringify(ids))) : [];

const SUMMARY_SELECT = `
  SELECT c.*, cm.role AS my_role, cm.perms AS my_perms, cm.last_read, cm.muted_until, cm.notify_muted_until, cm.pinned_at,
    (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) AS member_count,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.id > cm.last_read
       AND m.deleted = 0 AND m.type != 'system' AND IFNULL(m.sender_id, 0) != cm.user_id) AS unread,
    (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.id > cm.last_read AND m.deleted = 0
       AND m.mentions IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(m.mentions) j WHERE j.value = cm.user_id)) AS unread_mentions,
    (SELECT MAX(id) FROM messages m WHERE m.chat_id = c.id) AS last_msg_id,
    (SELECT MAX(o.last_read) FROM chat_members o WHERE o.chat_id = c.id AND o.user_id != cm.user_id) AS others_read
  FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?`;

function formatSummary(c, userId) {
  const out = {
    id: c.id,
    type: c.type,
    title: c.title,
    description: c.description,
    avatar: c.avatar_file_id,
    isPublic: !!c.is_public,
    isEmergency: !!c.is_emergency,
    slowMode: c.slow_mode,
    locked: !!c.locked,
    autoDelete: c.auto_delete,
    voiceStage: c.type === 'channel' || !!c.voice_stage,
    hideMembers: c.type === 'channel' || !!c.hide_members,
    memberCount: c.member_count,
    myRole: c.my_role,
    myPerms: parseJSON(c.my_perms, []),
    mutedUntil: c.muted_until,
    lastRead: c.last_read,
    othersRead: c.others_read || 0,
    unread: c.unread,
    unreadMentions: c.unread_mentions,
    pinnedAt: c.pinned_at || null,
    notifyMutedUntil: c.notify_muted_until && c.notify_muted_until > now() ? c.notify_muted_until : null,
    lastMessage: c.last_msg_id ? loadMessage(c.last_msg_id) : null,
    createdAt: c.created_at,
    peer: null,
  };
  if (c.type === 'dm') {
    const p = get(
      `SELECT u.id, u.username, u.display_name, u.avatar_file_id, u.last_seen
       FROM chat_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ? AND cm.user_id != ?`,
      c.id,
      userId,
    );
    if (p) {
      out.peer = { id: p.id, username: p.username, displayName: p.display_name, avatar: p.avatar_file_id, lastSeen: p.last_seen, online: isOnline(p.id) };
      out.title = p.display_name;
      out.avatar = p.avatar_file_id;
    }
  }
  if (c.type === 'saved') out.title = 'پیام‌های ذخیره‌شده';
  return out;
}

export function chatSummary(chatId, userId) {
  const c = get(`${SUMMARY_SELECT} WHERE c.id = ?`, userId, chatId);
  return c ? formatSummary(c, userId) : null;
}

// A private chat appears in lists (for both people) only once it has a message, like Telegram:
// opening someone's chat without writing leaves no trace on their side.
export function listChats(userId) {
  return all(SUMMARY_SELECT, userId)
    .filter((c) => c.type !== 'dm' || c.last_msg_id)
    .map((c) => formatSummary(c, userId));
}

export function postMessage({ chatId, senderId = null, type = 'text', text = '', fileId = null, replyTo = null, forwardedFrom = null }) {
  const t = now();
  const autoDelete = type === 'system' ? 0 : get('SELECT auto_delete FROM chats WHERE id = ?', chatId)?.auto_delete;
  const mentions = type === 'system' || forwardedFrom ? [] : findMentions(chatId, type === 'call' ? '' : text, replyTo, senderId);
  const id = tx(() => {
    const r = run(
      'INSERT INTO messages (chat_id, sender_id, type, text, file_id, reply_to, forwarded_from, expires_at, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      chatId,
      senderId,
      type,
      text,
      fileId,
      replyTo,
      forwardedFrom,
      autoDelete ? t + autoDelete * 1000 : null,
      mentions.length ? JSON.stringify(mentions) : null,
      t,
    );
    const msgId = Number(r.lastInsertRowid);
    if (senderId) {
      run('UPDATE chat_members SET last_post_at = ?, last_read = ? WHERE chat_id = ? AND user_id = ?', t, msgId, chatId, senderId);
    }
    return msgId;
  });
  const msg = loadMessage(id);
  toChat(chatId, 'message:new', msg);
  notifyMessage(msg, senderId);
  return msg;
}

export const systemMessage = (chatId, text) => postMessage({ chatId, type: 'system', text });

export function addMember(chatId, userId, role = 'member', { silent = false } = {}) {
  const r = run(
    'INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at, last_read) VALUES (?, ?, ?, ?, (SELECT IFNULL(MAX(id), 0) FROM messages WHERE chat_id = ?))',
    chatId,
    userId,
    role,
    now(),
    chatId,
  );
  if (!r.changes) return false;
  joinChat(userId, chatId);
  const chat = getChat(chatId);
  if (!silent && chat.type === 'group') {
    const u = get('SELECT display_name FROM users WHERE id = ?', userId);
    systemMessage(chatId, `${u.display_name} به گروه پیوست`);
  }
  toUser(userId, 'chat:new', chatSummary(chatId, userId));
  toChat(chatId, 'chat:changed', { chatId });
  return true;
}

export function removeMember(chatId, userId, reason = 'left') {
  const r = run('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, userId);
  if (!r.changes) return false;
  leaveChat(userId, chatId);
  kickFromVoice(chatId, userId);
  toUser(userId, 'chat:removed', { chatId, reason });
  const chat = getChat(chatId);
  if (chat.type === 'group') {
    const u = get('SELECT display_name FROM users WHERE id = ?', userId);
    systemMessage(chatId, reason === 'left' ? `${u.display_name} گروه را ترک کرد` : `${u.display_name} از گروه حذف شد`);
  }
  toChat(chatId, 'chat:changed', { chatId });
  return true;
}

export function createChat({ type, title = '', description = '', createdBy = null, isPublic = false, isEmergency = false, dmKey = null }) {
  const r = run(
    'INSERT INTO chats (type, title, description, is_public, is_emergency, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    type,
    title,
    description,
    isPublic ? 1 : 0,
    isEmergency ? 1 : 0,
    dmKey,
    createdBy,
    now(),
  );
  return Number(r.lastInsertRowid);
}

export function getOrCreateDm(a, b) {
  const key = `dm:${Math.min(a, b)}:${Math.max(a, b)}`;
  const c = get('SELECT id FROM chats WHERE dm_key = ?', key);
  if (c) return c.id;
  const id = createChat({ type: 'dm', dmKey: key, createdBy: a });
  addMember(id, a, 'member', { silent: true });
  addMember(id, b, 'member', { silent: true });
  return id;
}

export function ensureEmergencyChannel() {
  const c = get('SELECT id FROM chats WHERE is_emergency = 1');
  if (c) return c.id;
  return createChat({
    type: 'channel',
    title: '📢 اطلاع‌رسانی',
    description: 'کانال اطلاع‌رسانی رسمی. همه کاربران عضو آن هستند.',
    isEmergency: true,
  });
}

export function ensureSavedChat(userId) {
  const key = `saved:${userId}`;
  const c = get('SELECT id FROM chats WHERE dm_key = ?', key);
  if (c) return c.id;
  const id = createChat({ type: 'saved', dmKey: key, createdBy: userId });
  addMember(id, userId, 'owner', { silent: true });
  return id;
}

export function audit(actorId, action, target = '', details = '') {
  run(
    'INSERT INTO audit_log (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)',
    actorId,
    action,
    String(target),
    typeof details === 'string' ? details : JSON.stringify(details),
    now(),
  );
}
