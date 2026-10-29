import { get, all, run, now, parseJSON } from '../db.js';
import { getSetting } from '../settings.js';
import { hasSitePerm, hasChatPerm, cleanPerms, CHAT_PERMS } from '../perms.js';
import { randomCode, publicUser } from '../auth.js';
import { spendLookup, knowsUser } from '../lookup.js';
import { isOnline, toChat, toUser, toAll } from '../realtime.js';
import {
  fail,
  getChat,
  getMember,
  chatSummary,
  listChats,
  addMember,
  removeMember,
  createChat,
  getOrCreateDm,
  systemMessage,
  audit,
  membersHidden,
  isChatStaff,
} from '../chats.js';

function formatDuration(secs) {
  const fa = (n) => n.toLocaleString('fa-IR');
  if (secs % 86400 === 0) return `${fa(secs / 86400)} روز`;
  if (secs % 3600 === 0) return `${fa(secs / 3600)} ساعت`;
  if (secs % 60 === 0) return `${fa(secs / 60)} دقیقه`;
  return `${fa(secs)} ثانیه`;
}

const isRoom = (chat) => chat.type === 'group' || chat.type === 'channel' || chat.type === 'voice';
const TYPE_LABEL = { group: 'گروه', channel: 'کانال', voice: 'کانال صوتی' };

// Loads chat + caller's membership, failing unless the caller is a member
// (site chat moderators may also inspect chats they are not in).
export function requireChat(req, chatId, { allowModerator = false } = {}) {
  const chat = getChat(Number(chatId));
  if (!chat) fail(404, 'گفتگو پیدا نشد');
  const member = getMember(chat.id, req.user.id);
  // Site moderators may look into groups, channels and voice chats, never into someone's private
  // chats or saved messages (a report already shows the reported message itself).
  const moderated = chat.type !== 'dm' && chat.type !== 'saved';
  if (!member && !(allowModerator && moderated && hasSitePerm(req.user, 'manage_chats'))) fail(403, 'شما عضو این گفتگو نیستید');
  return { chat, member };
}

// Can `actor` moderate `target` (kick, ban, mute) in this chat?
function outranks(actor, actorMember, targetMember) {
  if (!targetMember) return true;
  if (targetMember.role === 'owner') return actor.role === 'owner';
  if (targetMember.role === 'admin') return actorMember?.role === 'owner' || hasSitePerm(actor, 'manage_chats');
  return true;
}

function membersOf(chatId) {
  return all(
    `SELECT u.*, cm.role AS chat_role, cm.perms AS chat_perms, cm.muted_until
     FROM chat_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = ?
     ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name
     LIMIT 1000`,
    chatId,
  ).map((u) => ({
    ...publicUser(u),
    online: isOnline(u.id),
    chatRole: u.chat_role,
    chatPerms: parseJSON(u.chat_perms, []),
    mutedUntil: u.muted_until,
  }));
}

function inviteRow(code) {
  const inv = get('SELECT * FROM chat_invites WHERE code = ?', String(code));
  if (!inv) return null;
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return null;
  if (inv.expires_at != null && inv.expires_at < now()) return null;
  return inv;
}

function joinAllowed(chatId, userId) {
  if (get('SELECT 1 FROM chat_bans WHERE chat_id = ? AND user_id = ?', chatId, userId)) {
    fail(403, 'شما از این گفتگو مسدود شده‌اید');
  }
}

export default async function chatRoutes(app) {
  app.get('/api/chats', async (req) => ({ chats: listChats(req.user.id) }));

  // Public groups and channels: searched by at least 3 letters of the name; the full list only
  // when the admin allows it (setting discover_list).
  app.get('/api/chats/discover', async (req) => {
    const q = String(req.query.q || '').trim();
    const listAll = getSetting('discover_list') !== '0';
    if (q && q.length < 3) return { chats: [], listAll, minLength: 3 };
    if (!q && !listAll) return { chats: [], listAll, minLength: 3 };
    if (q) spendLookup(req.user, 'discover');
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    return {
      listAll,
      minLength: 3,
      chats: all(
        `SELECT c.id, c.type, c.title, c.description, c.avatar_file_id AS avatar,
           (SELECT COUNT(*) FROM chat_members x WHERE x.chat_id = c.id) AS memberCount
         FROM chats c
         WHERE c.is_public = 1 AND c.type IN ('group', 'channel', 'voice')
           AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ?)
           AND (? = '' OR c.title LIKE ? ESCAPE '\\')
         ORDER BY memberCount DESC LIMIT 100`,
        req.user.id,
        q,
        like,
      ),
    };
  });

  app.post('/api/chats', async (req) => {
    const { type, title, description = '', memberIds = [], isPublic = false } = req.body || {};
    if (!TYPE_LABEL[type]) fail(400, 'نوع گفتگو نامعتبر است');
    if (getSetting('allow_user_groups') !== '1' && req.user.role === 'user') {
      fail(403, 'ساخت گروه و کانال فقط برای مدیران فعال است');
    }
    const t = String(title || '').trim().slice(0, 100);
    if (!t) fail(400, 'عنوان را وارد کنید');

    const chatId = createChat({
      type,
      title: t,
      description: String(description).slice(0, 500),
      createdBy: req.user.id,
      isPublic: !!isPublic,
    });
    addMember(chatId, req.user.id, 'owner', { silent: true });
    systemMessage(chatId, `${req.user.display_name} ${TYPE_LABEL[type]} «${t}» را ساخت`);
    const ids = Array.isArray(memberIds) ? memberIds.slice(0, 500).map(Number) : [];
    for (const id of ids) {
      if (id !== req.user.id && get('SELECT 1 FROM users WHERE id = ? AND banned = 0', id)) {
        addMember(chatId, id, 'member', { silent: true });
      }
    }
    if (type === 'voice') toAll('voice:channels', {});
    return { chat: chatSummary(chatId, req.user.id) };
  });

  app.post('/api/chats/dm', async (req) => {
    const otherId = Number(req.body?.userId);
    if (otherId === req.user.id) fail(400, 'برای پیام به خودتان از «پیام‌های ذخیره‌شده» استفاده کنید');
    if (!get('SELECT 1 FROM users WHERE id = ? AND banned = 0', otherId)) fail(404, 'کاربر پیدا نشد');
    // A new private chat with someone you don't know yet counts as a lookup (no id walking).
    if (!knowsUser(req.user.id, otherId)) spendLookup(req.user, 'dm');
    // Not shown to the other person (or in lists) until the first message: see listChats.
    return { chat: chatSummary(getOrCreateDm(req.user.id, otherId), req.user.id) };
  });

  app.get('/api/chats/:id', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    const canSeeBans = hasChatPerm(req.user, member, 'ban_members');
    // A channel's subscriber list is for the channel's own owner/admins only (not site admins
    // who happen to join it); hidden group lists are also open to site moderators.
    const seesAll = chat.type === 'channel' ? member?.role === 'owner' || member?.role === 'admin' : isChatStaff(req.user, member);
    return {
      chat: member ? chatSummary(chat.id, req.user.id) : { id: chat.id, type: chat.type, title: chat.title, description: chat.description },
      // Hidden list, like Telegram: channel subscribers only see themselves (not even the admins);
      // in groups with a hidden list, regular members see the admins and themselves.
      members:
        chat.type === 'saved'
          ? []
          : membersOf(chat.id).filter(
              (u) => !membersHidden(chat) || seesAll || u.id === req.user.id || (chat.type === 'group' && u.chatRole !== 'member'),
            ),
      membersHidden: membersHidden(chat) && !seesAll,
      bans: canSeeBans
        ? all(
            `SELECT u.id, u.username, u.display_name AS displayName FROM chat_bans b JOIN users u ON u.id = b.user_id WHERE b.chat_id = ?`,
            chat.id,
          )
        : [],
    };
  });

  app.patch('/api/chats/:id', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    const b = req.body || {};
    const isPrivate = chat.type === 'dm' || chat.type === 'saved';
    if (isPrivate && member && Object.keys(b).every((k) => k === 'autoDelete')) {
      // Either side of a private chat may set its auto-delete timer.
    } else {
      if (!isRoom(chat)) fail(400, 'این گفتگو قابل ویرایش نیست');
      if (!hasChatPerm(req.user, member, 'edit_info')) fail(403, 'دسترسی ویرایش ندارید');
    }
    if (b.autoDelete !== undefined) {
      const secs = Math.max(0, Math.min(30 * 86400, Number(b.autoDelete) || 0));
      run('UPDATE chats SET auto_delete = ? WHERE id = ?', secs, chat.id);
      const label = secs ? `پیام‌های جدید پس از ${formatDuration(secs)} خودکار حذف می‌شوند` : 'حذف خودکار پیام‌ها خاموش شد';
      if (chat.type !== 'saved') systemMessage(chat.id, `${req.user.display_name}: ${label}`);
    }
    if (b.title !== undefined) {
      const t = String(b.title).trim().slice(0, 100);
      if (!t) fail(400, 'عنوان خالی است');
      run('UPDATE chats SET title = ? WHERE id = ?', t, chat.id);
    }
    if (b.description !== undefined) run('UPDATE chats SET description = ? WHERE id = ?', String(b.description).slice(0, 500), chat.id);
    if (b.isPublic !== undefined && !chat.is_emergency) run('UPDATE chats SET is_public = ? WHERE id = ?', b.isPublic ? 1 : 0, chat.id);
    if (b.slowMode !== undefined) run('UPDATE chats SET slow_mode = ? WHERE id = ?', Math.max(0, Math.min(3600, Number(b.slowMode) || 0)), chat.id);
    if (b.locked !== undefined) run('UPDATE chats SET locked = ? WHERE id = ?', b.locked ? 1 : 0, chat.id);
    if (b.voiceStage !== undefined && chat.type === 'group') run('UPDATE chats SET voice_stage = ? WHERE id = ?', b.voiceStage ? 1 : 0, chat.id);
    if (b.hideMembers !== undefined && chat.type === 'group') run('UPDATE chats SET hide_members = ? WHERE id = ?', b.hideMembers ? 1 : 0, chat.id);
    if (b.avatar !== undefined) {
      if (b.avatar !== null && !get("SELECT 1 FROM files WHERE id = ? AND owner_id = ? AND kind = 'image'", b.avatar, req.user.id)) {
        fail(400, 'تصویر نامعتبر است');
      }
      run('UPDATE chats SET avatar_file_id = ? WHERE id = ?', b.avatar, chat.id);
    }
    audit(req.user.id, 'chat.edit', chat.id, b);
    toChat(chat.id, 'chat:changed', { chatId: chat.id });
    return { chat: chatSummary(chat.id, req.user.id) || { id: chat.id } };
  });

  app.delete('/api/chats/:id', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!isRoom(chat) || chat.is_emergency) fail(400, 'این گفتگو قابل حذف نیست');
    if (member?.role !== 'owner' && !hasSitePerm(req.user, 'manage_chats')) fail(403, 'فقط سازنده می‌تواند حذف کند');
    const memberIds = all('SELECT user_id FROM chat_members WHERE chat_id = ?', chat.id).map((r) => r.user_id);
    run('DELETE FROM chats WHERE id = ?', chat.id);
    for (const uid of memberIds) toUser(uid, 'chat:removed', { chatId: chat.id, reason: 'deleted' });
    audit(req.user.id, 'chat.delete', chat.id, { title: chat.title });
    if (chat.type === 'voice') toAll('voice:channels', {});
    return { ok: true };
  });

  // Personal notification mute (not the moderation mute): null = on, -1 = forever, or a timestamp.
  app.patch('/api/chats/:id/notify', async (req) => {
    const { chat, member } = requireChat(req, req.params.id);
    if (!member) fail(403, 'شما عضو این گفتگو نیستید');
    const v = req.body?.mutedUntil;
    const until = v == null || v === false ? null : v === -1 || v === true ? 32503680000000 : Math.max(0, Number(v) || 0) || null;
    run('UPDATE chat_members SET notify_muted_until = ? WHERE chat_id = ? AND user_id = ?', until, chat.id, req.user.id);
    toUser(req.user.id, 'chat:new', chatSummary(chat.id, req.user.id));
    return { notifyMutedUntil: until };
  });

  app.post('/api/chats/:id/leave', async (req) => {
    const { chat, member } = requireChat(req, req.params.id);
    if (!isRoom(chat) || chat.is_emergency) fail(400, 'از این گفتگو نمی‌توان خارج شد');
    if (member.role === 'owner') fail(400, 'سازنده نمی‌تواند خارج شود؛ ابتدا گفتگو را حذف کنید');
    removeMember(chat.id, req.user.id, 'left');
    return { ok: true };
  });

  app.post('/api/chats/:id/join', async (req) => {
    const chat = getChat(Number(req.params.id));
    if (!chat || !chat.is_public || !isRoom(chat)) fail(404, 'گفتگو پیدا نشد');
    joinAllowed(chat.id, req.user.id);
    addMember(chat.id, req.user.id);
    return { chat: chatSummary(chat.id, req.user.id) };
  });

  app.post('/api/chats/:id/members', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!isRoom(chat) || chat.is_emergency) fail(400, 'نمی‌توان به این گفتگو عضو اضافه کرد');
    if (!hasChatPerm(req.user, member, 'add_members')) fail(403, 'دسترسی افزودن عضو ندارید');
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.slice(0, 500).map(Number) : [];
    let added = 0;
    for (const id of ids) {
      if (!get('SELECT 1 FROM users WHERE id = ? AND banned = 0', id)) continue;
      run('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?', chat.id, id);
      if (addMember(chat.id, id)) added++;
    }
    return { added };
  });

  app.patch('/api/chats/:id/members/:userId', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!isRoom(chat)) fail(400, 'نامعتبر');
    const targetId = Number(req.params.userId);
    const target = getMember(chat.id, targetId);
    if (!target) fail(404, 'این کاربر عضو نیست');
    const b = req.body || {};
    const isOwner = member?.role === 'owner' || hasSitePerm(req.user, 'manage_chats');

    if (b.role !== undefined || b.perms !== undefined) {
      if (!isOwner) fail(403, 'فقط سازنده می‌تواند ادمین تعیین کند');
      if (target.role === 'owner') fail(400, 'نقش سازنده قابل تغییر نیست');
      const role = b.role === 'admin' ? 'admin' : b.role === 'member' ? 'member' : target.role;
      const perms = role === 'admin' ? cleanPerms(b.perms ?? parseJSON(target.perms, []), CHAT_PERMS) : [];
      run('UPDATE chat_members SET role = ?, perms = ? WHERE chat_id = ? AND user_id = ?', role, JSON.stringify(perms), chat.id, targetId);
      audit(req.user.id, 'chat.member_role', `${chat.id}:${targetId}`, { role, perms });
      toUser(targetId, 'chat:changed', { chatId: chat.id });
    }

    if (b.mutedUntil !== undefined) {
      if (!hasChatPerm(req.user, member, 'mute_members')) fail(403, 'دسترسی بی‌صدا کردن ندارید');
      if (!outranks(req.user, member, target)) fail(403, 'نمی‌توانید این کاربر را بی‌صدا کنید');
      const until = b.mutedUntil === null ? null : Number(b.mutedUntil);
      run('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?', until, chat.id, targetId);
      audit(req.user.id, 'chat.mute', `${chat.id}:${targetId}`, { until });
      const u = get('SELECT display_name FROM users WHERE id = ?', targetId);
      if (chat.type === 'group' || chat.type === 'voice') {
        systemMessage(chat.id, until && until > now() ? `${u.display_name} بی‌صدا شد` : `${u.display_name} از حالت بی‌صدا خارج شد`);
      }
      toUser(targetId, 'chat:changed', { chatId: chat.id });
    }
    toChat(chat.id, 'chat:changed', { chatId: chat.id });
    return { ok: true };
  });

  app.delete('/api/chats/:id/members/:userId', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!isRoom(chat) || chat.is_emergency) fail(400, 'نامعتبر');
    if (!hasChatPerm(req.user, member, 'ban_members')) fail(403, 'دسترسی حذف عضو ندارید');
    const targetId = Number(req.params.userId);
    const target = getMember(chat.id, targetId);
    if (!outranks(req.user, member, target)) fail(403, 'نمی‌توانید این کاربر را حذف کنید');
    const ban = req.query.ban === '1';
    if (ban) {
      run('INSERT OR REPLACE INTO chat_bans (chat_id, user_id, by_id, created_at) VALUES (?, ?, ?, ?)', chat.id, targetId, req.user.id, now());
    }
    if (target) removeMember(chat.id, targetId, 'kicked');
    audit(req.user.id, ban ? 'chat.ban' : 'chat.kick', `${chat.id}:${targetId}`);
    return { ok: true };
  });

  app.delete('/api/chats/:id/bans/:userId', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!hasChatPerm(req.user, member, 'ban_members')) fail(403, 'دسترسی ندارید');
    run('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?', chat.id, Number(req.params.userId));
    audit(req.user.id, 'chat.unban', `${chat.id}:${req.params.userId}`);
    return { ok: true };
  });

  // --- Chat invite links ---
  app.get('/api/chats/:id/invites', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!hasChatPerm(req.user, member, 'invite_links')) fail(403, 'دسترسی ندارید');
    return { invites: all('SELECT * FROM chat_invites WHERE chat_id = ? ORDER BY created_at DESC', chat.id) };
  });

  app.post('/api/chats/:id/invites', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!isRoom(chat) || chat.is_emergency) fail(400, 'نامعتبر');
    if (!hasChatPerm(req.user, member, 'invite_links')) fail(403, 'دسترسی ندارید');
    const { maxUses, expiresInHours } = req.body || {};
    const code = randomCode(8);
    run(
      'INSERT INTO chat_invites (code, chat_id, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      code,
      chat.id,
      req.user.id,
      Number(maxUses) > 0 ? Number(maxUses) : null,
      Number(expiresInHours) > 0 ? now() + Number(expiresInHours) * 3600 * 1000 : null,
      now(),
    );
    return { invite: get('SELECT * FROM chat_invites WHERE code = ?', code) };
  });

  app.delete('/api/chats/:id/invites/:code', async (req) => {
    const { chat, member } = requireChat(req, req.params.id, { allowModerator: true });
    if (!hasChatPerm(req.user, member, 'invite_links')) fail(403, 'دسترسی ندارید');
    run('DELETE FROM chat_invites WHERE chat_id = ? AND code = ?', chat.id, req.params.code);
    return { ok: true };
  });

  app.get('/api/join/:code', async (req) => {
    const inv = inviteRow(req.params.code);
    if (!inv) fail(404, 'لینک دعوت نامعتبر یا منقضی است');
    const c = getChat(inv.chat_id);
    return {
      chat: {
        id: c.id,
        type: c.type,
        title: c.title,
        description: c.description,
        avatar: c.avatar_file_id,
        memberCount: get('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', c.id).n,
        isMember: !!getMember(c.id, req.user.id),
      },
    };
  });

  app.post('/api/join/:code', async (req) => {
    const inv = inviteRow(req.params.code);
    if (!inv) fail(404, 'لینک دعوت نامعتبر یا منقضی است');
    joinAllowed(inv.chat_id, req.user.id);
    if (addMember(inv.chat_id, req.user.id)) run('UPDATE chat_invites SET uses = uses + 1 WHERE code = ?', inv.code);
    return { chat: chatSummary(inv.chat_id, req.user.id) };
  });
}
