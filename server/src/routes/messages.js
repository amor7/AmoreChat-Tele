import { get, all, run, now } from '../db.js';
import { hasSitePerm, hasChatPerm, canPostInChannel } from '../perms.js';
import { toChat, toAll, toChatExcept } from '../realtime.js';
import { fail, getMember, loadMessage, loadMessages, loadMessagesByIds, postMessage, systemMessage, audit, findMentions, withMine, membersHidden } from '../chats.js';
import { requireChat } from './chats.js';
import { deleteMessage } from '../sweeper.js';
import { pushTo } from '../push.js';

const MAX_TEXT = 4000;
// Which file kinds each message type accepts.
const TYPE_KINDS = { image: ['image'], video: ['video'], voice: ['audio'], file: null };

export function assertCanPost(user, chat, member) {
  if (!member) fail(403, 'شما عضو این گفتگو نیستید');
  if (chat.is_emergency) {
    if (member.role !== 'owner' && !hasSitePerm(user, 'broadcast')) fail(403, 'فقط مدیران می‌توانند در این کانال پیام بگذارند');
    return;
  }
  if (chat.type === 'channel') {
    if (!canPostInChannel(member)) fail(403, 'فقط مدیران کانال می‌توانند پیام بگذارند');
    return;
  }
  if (chat.type !== 'group' && chat.type !== 'voice') return;
  const isStaff = member.role === 'owner' || member.role === 'admin' || hasSitePerm(user, 'manage_chats');
  if (isStaff) return;
  if (chat.locked) fail(403, 'گروه قفل است؛ فقط مدیران می‌توانند پیام بدهند');
  if (member.muted_until && member.muted_until > now()) fail(403, 'شما در این گروه بی‌صدا هستید');
  if (chat.slow_mode && member.last_post_at) {
    const wait = Math.ceil((member.last_post_at + chat.slow_mode * 1000 - now()) / 1000);
    if (wait > 0) fail(429, `حالت آهسته فعال است؛ ${wait} ثانیه دیگر صبر کنید`);
  }
}

function requireMessage(req, id) {
  const m = get('SELECT * FROM messages WHERE id = ?', Number(id));
  if (!m || m.deleted) fail(404, 'پیام پیدا نشد');
  const { chat, member } = requireChat(req, m.chat_id, { allowModerator: true });
  return { m, chat, member };
}

export default async function messageRoutes(app) {
  app.get('/api/chats/:id/messages', async (req) => {
    const { chat } = requireChat(req, req.params.id, { allowModerator: true });
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const n = (k) => Number(req.query[k]) || null;
    return { messages: withMine(loadMessages(chat.id, { before: n('before'), after: n('after'), around: n('around'), limit }), req.user.id) };
  });

  app.get('/api/search', async (req) => {
    const terms = String(req.query.q || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (!terms.length) return { messages: [] };
    // Each term becomes a quoted prefix query so user input can't inject FTS syntax.
    const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
    const chatId = Number(req.query.chatId) || null;
    // A mirrored channel's file not fetched yet: only its name is known, and it is not a file yet.
    const pending = terms.map(() => "name LIKE ? ESCAPE '\\'").join(' AND ');
    const likes = terms.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
    let ids = [];
    try {
      ids = all(
      `SELECT m.id FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.deleted = 0 AND m.type NOT IN ('system', 'call') AND (? IS NULL OR m.chat_id = ?)
         AND (m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)
           OR m.file_id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)
           OR m.id IN (SELECT message_id FROM tele_mirror_photos WHERE ${pending}))
       ORDER BY m.id DESC LIMIT 50`,
      req.user.id,
      chatId,
      chatId,
      match,
      match,
      ...likes,
    ).map((r) => r.id);
    } catch {
      // Whatever the search text was, a query it can't run finds nothing (never a server error).
      ids = [];
    }
    return { messages: loadMessagesByIds(ids) };
  });

  app.post('/api/messages/:id/react', async (req) => {
    const { m, member } = requireMessage(req, req.params.id);
    if (!member) fail(403, 'شما عضو این گفتگو نیستید');
    const emoji = String(req.body?.emoji || '').trim();
    if (!emoji || emoji.length > 16 || /[\s<>]/.test(emoji)) fail(400, 'ری‌اکشن نامعتبر');
    const exists = get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, emoji);
    if (exists) {
      run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, emoji);
    } else {
      const count = get('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', m.id).n;
      if (count >= 20) fail(400, 'تعداد ری‌اکشن‌های این پیام به سقف رسیده');
      run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', m.id, req.user.id, emoji, now());
    }
    const msg = loadMessage(m.id);
    toChat(m.chat_id, 'message:edit', msg);
    return { message: withMine([structuredClone(msg)], req.user.id)[0] };
  });

  app.post('/api/messages/:id/forward', async (req) => {
    const { m, member } = requireMessage(req, req.params.id);
    if (!member) fail(403, 'شما عضو این گفتگو نیستید');
    if (m.type === 'system') fail(400, 'این پیام قابل فوروارد نیست');
    const src = loadMessage(m.id);
    const from = m.forwarded_from || src.sender?.displayName || '';
    const ids = Array.isArray(req.body?.chatIds) ? [...new Set(req.body.chatIds.map(Number))].slice(0, 20) : [];
    const sent = [];
    for (const chatId of ids) {
      const target = getMember(chatId, req.user.id);
      if (!target) continue;
      const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
      try {
        assertCanPost(req.user, chat, target);
      } catch {
        continue;
      }
      const msg = postMessage({ chatId, senderId: req.user.id, type: m.type, text: m.text, fileId: m.file_id, forwardedFrom: from });
      if (chat.is_emergency) toAll('emergency', msg);
      sent.push(chatId);
    }
    if (!sent.length) fail(400, 'به هیچ‌کدام از گفتگوهای انتخاب‌شده ارسال نشد');
    return { sent };
  });

  app.post('/api/messages/:id/report', async (req) => {
    const { m, member } = requireMessage(req, req.params.id);
    if (!member) fail(403, 'شما عضو این گفتگو نیستید');
    if (m.sender_id === req.user.id) fail(400, 'پیام خودتان را نمی‌توانید گزارش کنید');
    if (get("SELECT 1 FROM reports WHERE message_id = ? AND reporter_id = ? AND status = 'open'", m.id, req.user.id)) {
      fail(409, 'این پیام را قبلاً گزارش کرده‌اید');
    }
    run(
      'INSERT INTO reports (message_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)',
      m.id,
      req.user.id,
      String(req.body?.reason || '').slice(0, 500),
      now(),
    );
    return { ok: true };
  });

  app.get('/api/chats/:id/pinned', async (req) => {
    const { chat } = requireChat(req, req.params.id, { allowModerator: true });
    const ids = all('SELECT id FROM messages WHERE chat_id = ? AND pinned = 1 AND deleted = 0 ORDER BY id DESC LIMIT 50', chat.id);
    return { messages: ids.map((r) => loadMessage(r.id)) };
  });

  app.post('/api/chats/:id/messages', async (req) => {
    const { chat, member } = requireChat(req, req.params.id);
    assertCanPost(req.user, chat, member);

    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (text.length > MAX_TEXT) fail(400, `متن پیام حداکثر ${MAX_TEXT} کاراکتر است`);

    let type = 'text';
    let fileId = null;
    if (b.fileId) {
      const f = get('SELECT * FROM files WHERE id = ? AND owner_id = ?', Number(b.fileId), req.user.id);
      if (!f) fail(400, 'فایل نامعتبر است');
      type = b.type in TYPE_KINDS ? b.type : 'file';
      const kinds = TYPE_KINDS[type];
      if (kinds && !kinds.includes(f.kind)) type = 'file';
      fileId = f.id;
    } else if (!text) {
      fail(400, 'پیام خالی است');
    }

    let replyTo = null;
    if (b.replyTo) {
      const r = get('SELECT id FROM messages WHERE id = ? AND chat_id = ?', Number(b.replyTo), chat.id);
      if (r) replyTo = r.id;
    }

    const msg = postMessage({ chatId: chat.id, senderId: req.user.id, type, text, fileId, replyTo });
    if (chat.is_emergency) toAll('emergency', msg);
    return { message: msg };
  });

  app.patch('/api/messages/:id', async (req) => {
    const { m, chat, member } = requireMessage(req, req.params.id);
    // Channel posts are anonymous: any admin who may post can edit them.
    const channelEditor = chat.type === 'channel' && canPostInChannel(member);
    if (m.sender_id !== req.user.id && !channelEditor) fail(403, 'فقط پیام‌های خودتان را می‌توانید ویرایش کنید');
    if (m.type === 'system') fail(400, 'نامعتبر');
    const text = String(req.body?.text || '').trim();
    if (!text && !m.file_id) fail(400, 'پیام خالی است');
    if (text.length > MAX_TEXT) fail(400, 'متن خیلی طولانی است');
    const mentions = findMentions(m.chat_id, text, m.reply_to, m.sender_id);
    run('UPDATE messages SET text = ?, edited_at = ?, mentions = ? WHERE id = ?', text, now(), mentions.length ? JSON.stringify(mentions) : null, m.id);
    const msg = loadMessage(m.id);
    toChat(m.chat_id, 'message:edit', msg);
    return { message: msg };
  });

  app.delete('/api/messages/:id', async (req) => {
    const { m, chat, member } = requireMessage(req, req.params.id);
    const own = m.sender_id === req.user.id;
    if (!own && !hasChatPerm(req.user, member, 'delete_messages')) fail(403, 'دسترسی حذف این پیام را ندارید');
    deleteMessage(m, { by: req.user.id });
    if (!own) audit(req.user.id, 'message.delete', m.id, { chat: chat.id, sender: m.sender_id });
    return { ok: true };
  });

  // What a deleted group / channel message was: moderators only, while it is kept, and logged.
  app.get('/api/messages/:id/deleted', async (req) => {
    if (!hasSitePerm(req.user, 'manage_chats')) fail(403, 'دسترسی ندارید');
    const id = Number(req.params.id);
    const d = get(
      `SELECT d.*, m.chat_id, m.created_at, s.display_name AS sender, s.username AS sender_username, b.display_name AS deleted_by,
         f.name AS f_name, f.mime AS f_mime, f.size AS f_size, f.kind AS f_kind, f.purged AS f_purged
       FROM deleted_messages d JOIN messages m ON m.id = d.message_id
       LEFT JOIN users s ON s.id = m.sender_id LEFT JOIN users b ON b.id = d.by LEFT JOIN files f ON f.id = d.file_id
       WHERE d.message_id = ?`,
      id,
    );
    if (!d) fail(404, 'محتوای این پیام دیگر نگه داشته نشده است');
    audit(req.user.id, 'message.view_deleted', id, { chat: d.chat_id });
    return {
      type: d.type, text: d.text, sender: d.sender, senderUsername: d.sender_username, deletedBy: d.deleted_by, deletedAt: d.at, createdAt: d.created_at,
      file: d.file_id && !d.f_purged ? { id: d.file_id, name: d.f_name, mime: d.f_mime, size: d.f_size, kind: d.f_kind } : null,
    };
  });

  app.post('/api/messages/:id/pin', async (req) => {
    const { m, chat, member } = requireMessage(req, req.params.id);
    const allowed = chat.type === 'dm' || chat.type === 'saved' || hasChatPerm(req.user, member, 'pin_messages');
    if (!allowed) fail(403, 'دسترسی سنجاق کردن ندارید');
    const pinned = req.body?.pinned !== false;
    run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, m.id);
    toChat(m.chat_id, 'message:edit', loadMessage(m.id));
    if (pinned && chat.type === 'group') systemMessage(chat.id, `${req.user.display_name} پیامی را سنجاق کرد`);
    return { ok: true };
  });

  // "Seen by": members whose read pointer passed this message (groups and channels).
  app.get('/api/messages/:id/readers', async (req) => {
    const { m: msg, chat, member } = requireMessage(req, req.params.id);
    const staff = member && (member.role === 'owner' || member.role === 'admin');
    // With a hidden member list only admins may see who read (it would reveal members).
    if (!staff && (msg.sender_id !== req.user.id || membersHidden(chat))) fail(403, 'فقط فرستنده یا مدیران می‌توانند ببینند');
    const users = all(
      `SELECT u.id, u.username, u.display_name, u.avatar_file_id FROM chat_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ? AND cm.last_read >= ? AND cm.user_id != IFNULL(?, 0) ORDER BY u.display_name LIMIT 500`,
      msg.chat_id,
      msg.id,
      msg.sender_id,
    );
    const total = get('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ? AND user_id != IFNULL(?, 0)', msg.chat_id, msg.sender_id).n;
    return { readers: users.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar_file_id })), total };
  });

  // Shared media of one chat, newest first: kind = media | files | voice | links
  app.get('/api/chats/:id/media', async (req) => {
    const { chat } = requireChat(req, req.params.id, { allowModerator: true });
    const where = {
      media: "m.type IN ('image', 'video')",
      files: "m.type = 'file'",
      music: "m.type = 'file' AND f.kind = 'audio'",
      voice: "m.type = 'voice'",
      links: "m.type = 'text' AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%')",
    }[req.query.kind] || "m.type IN ('image', 'video')";
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const ids = all(
      `SELECT m.id FROM messages m LEFT JOIN files f ON f.id = m.file_id
       WHERE m.chat_id = ? AND m.deleted = 0 AND m.id < ? AND ${where} AND IFNULL(f.purged, 0) = 0
       ORDER BY m.id DESC LIMIT 60`,
      chat.id,
      before,
    ).map((r) => r.id);
    return { messages: loadMessagesByIds(ids) };
  });

  app.post('/api/chats/:id/read', async (req) => {
    const chatId = Number(req.params.id);
    const member = getMember(chatId, req.user.id);
    if (!member) fail(403, 'شما عضو این گفتگو نیستید');
    const messageId = Number(req.body?.messageId) || 0;
    if (messageId > member.last_read) {
      run('UPDATE chat_members SET last_read = ? WHERE chat_id = ? AND user_id = ?', messageId, chatId, req.user.id);
      // With a hidden member list, don't reveal who read: others only learn that someone did.
      const chat = get('SELECT type, hide_members FROM chats WHERE id = ?', chatId);
      if (membersHidden(chat)) toChatExcept(chatId, [req.user.id], 'read', { chatId, userId: 0, messageId });
      else toChat(chatId, 'read', { chatId, userId: req.user.id, messageId });
      // Read on one device: clear the notification on my phone.
      pushTo([req.user.id], { type: 'read', chatId });
    }
    return { ok: true };
  });
}
