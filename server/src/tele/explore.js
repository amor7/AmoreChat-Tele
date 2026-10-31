/**
 * Beyond the chats a user already has: find a person (@username or phone number), a bot, a public
 * group or channel (by @username, t.me link, invite link or name), message them and join. Only
 * for accounts an admin allowed (each search and join goes through the server's VPN).
 */
import { get, run, now } from '../db.js';
import { getAccountForUser, liveClient, upsertDialog, listDialogs, exploreAllowed } from './accounts.js';
import { ensureEgress } from './egress.js';
import { contentText } from './messages.js';
import { usernameOf } from './mirror.js';

const bad = (code, m) => Object.assign(new Error(m), { statusCode: code, expose: true });
const KIND = (chat) =>
  chat.type?._ === 'chatTypePrivate' || chat.type?._ === 'chatTypeSecret' ? 'private' : chat.type?._ === 'chatTypeSupergroup' && chat.type?.is_channel ? 'channel' : 'group';
const LEFT = ['chatMemberStatusLeft', 'chatMemberStatusBanned'];
const inviteOf = (q) => {
  const m = String(q || '').trim().match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]{8,64})\/?$/);
  return m ? `https://t.me/+${m[1]}` : null;
};
const PHONE = /^\+?\d{8,15}$/;

async function exploreClient(userId) {
  const account = getAccountForUser(userId);
  if (!account || account.status !== 'connected') throw bad(400, 'حساب تلگرام وصل نیست');
  if (!exploreAllowed(account)) throw bad(403, 'پیام به افراد تازه و جستجو و عضویت در کانال‌ها برای شما فعال نیست؛ از مدیر بخواهید');
  await ensureEgress().catch(() => {
    throw bad(503, 'تونل تلگرام وصل نیست');
  });
  const client = await liveClient(account);
  if (!client) throw bad(503, 'اتصال به تلگرام برقرار نیست');
  return { account, client };
}

/** What the search shows about a chat. */
async function describe(client, chat) {
  const kind = KIND(chat);
  const out = { tgChatId: String(chat.id), kind, title: chat.title || '', username: '', memberCount: null, joined: true, bot: false };
  if (chat.type?._ === 'chatTypePrivate') {
    const u = await client.invoke({ _: 'getUser', user_id: chat.type.user_id }).catch(() => null);
    out.username = u?.usernames?.active_usernames?.[0] || '';
    out.bot = u?.type?._ === 'userTypeBot';
  } else if (chat.type?._ === 'chatTypeSupergroup') {
    const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id }).catch(() => null);
    out.username = sg?.usernames?.active_usernames?.[0] || '';
    out.memberCount = sg?.member_count ?? null;
    out.joined = !!sg && !LEFT.includes(sg.status?._);
  } else if (chat.type?._ === 'chatTypeBasicGroup') {
    const g = await client.invoke({ _: 'getBasicGroup', basic_group_id: chat.type.basic_group_id }).catch(() => null);
    out.memberCount = g?.member_count ?? null;
    out.joined = !!g && !LEFT.includes(g.status?._);
  }
  return out;
}

/** Adds the chat to the user's list (like "add a chat") and returns its dialog id. */
function addDialog(account, chat) {
  const last = chat.last_message;
  const id = upsertDialog(account.id, {
    tgChatId: String(chat.id), kind: KIND(chat), title: chat.title || '', username: '',
    lastText: last ? contentText(last.content) : '', lastAt: last ? last.date * 1000 : 0, lastOut: !!last?.is_outgoing, unread: chat.unread_count || 0,
  });
  run('UPDATE tele_dialogs SET selected = 1, updated_at = ? WHERE id = ?', now(), id);
  return id;
}

/** Search: @username / t.me link, an invite link, a phone number, or words of a public chat's name. */
export async function findTelegram(userId, query) {
  const q = String(query || '').trim().slice(0, 100);
  if (q.length < 2) throw bad(400, 'حداقل ۲ حرف بنویسید');
  const { client } = await exploreClient(userId);
  const results = [];
  const seen = new Set();
  const push = async (chat) => {
    if (!chat || seen.has(chat.id)) return;
    seen.add(chat.id);
    results.push(await describe(client, chat));
  };
  const invite = inviteOf(q);
  if (invite) {
    const info = await client.invoke({ _: 'checkChatInviteLink', invite_link: invite }).catch(() => null);
    if (!info) throw bad(404, 'لینک دعوت نامعتبر یا منقضی است');
    if (info.chat_id) await push(await client.invoke({ _: 'getChat', chat_id: info.chat_id }));
    else {
      results.push({
        tgChatId: null, invite, kind: info.type?._ === 'inviteLinkChatTypeChannel' ? 'channel' : 'group', title: info.title || '', username: '',
        memberCount: info.member_count ?? null, joined: false, bot: false, needsApproval: !!info.creates_join_request,
      });
    }
    return { results };
  }
  if (PHONE.test(q.replace(/[\s-]/g, ''))) {
    const phone = q.replace(/[\s-]/g, '').replace(/^\+/, '');
    const user = await client.invoke({ _: 'searchUserByPhoneNumber', phone_number: phone, only_local: false }).catch(() => null);
    if (!user) throw bad(404, 'کسی با این شماره در تلگرام پیدا نشد (یا شماره‌اش را برای دیگران پنهان کرده)');
    await push(await client.invoke({ _: 'createPrivateChat', user_id: user.id, force: false }));
    return { results };
  }
  const uname = usernameOf(q);
  if (uname) await push(await client.invoke({ _: 'searchPublicChat', username: uname }).catch(() => null));
  if (!/^@|t\.me\//.test(q)) {
    const local = await client.invoke({ _: 'searchChats', query: q, limit: 10 }).catch(() => null);
    for (const id of local?.chat_ids || []) await push(await client.invoke({ _: 'getChat', chat_id: id }).catch(() => null));
    const found = await client.invoke({ _: 'searchPublicChats', query: q }).catch(() => null);
    for (const id of (found?.chat_ids || []).slice(0, 20)) await push(await client.invoke({ _: 'getChat', chat_id: id }).catch(() => null));
  }
  return { results };
}

async function chatOf(client, tgChatId) {
  const id = String(tgChatId || '');
  if (!/^-?\d{1,20}$/.test(id)) throw bad(400, 'گفتگو نامعتبر است');
  // TDLib knows only chats it has seen (a search shows them first).
  return client.invoke({ _: 'getChat', chat_id: Number(id) }).catch(() => {
    throw bad(404, 'گفتگو پیدا نشد؛ دوباره جستجو کنید');
  });
}

/** Opens a found chat (a person, a bot, or one already joined) in the user's list. */
export async function openTelegramChat(userId, tgChatId) {
  const { account, client } = await exploreClient(userId);
  const chat = await chatOf(client, tgChatId);
  return { dialogId: addDialog(account, chat), dialogs: listDialogs(account.id) };
}

// A chat whose admins approve new members: asked, not joined yet.
const requested = (account) => ({ requested: true, notice: 'درخواست عضویت فرستاده شد؛ بعد از تأیید مدیر آن گفتگو، با جستجوی دوباره بازش کنید', dialogs: listDialogs(account.id) });

/** Joins a public group / channel (or one by invite link) and adds it to the user's list. */
export async function joinTelegramChat(userId, { tgChatId, invite }) {
  const { account, client } = await exploreClient(userId);
  let chat;
  const fail = (e) => {
    const m = String(e?.message || e);
    if (/INVITE_REQUEST_SENT/i.test(m)) return 'requested';
    if (/CHANNELS_TOO_MUCH/i.test(m)) throw bad(400, 'این حساب تلگرام در بیشترین تعداد گروه و کانال ممکن عضو است');
    if (/USER_ALREADY_PARTICIPANT/i.test(m)) return null;
    throw bad(400, `تلگرام: ${m}`);
  };
  if (invite) {
    const link = inviteOf(invite);
    if (!link) throw bad(400, 'لینک دعوت نامعتبر است');
    chat = await client.invoke({ _: 'joinChatByInviteLink', invite_link: link }).catch(fail);
    if (chat === 'requested') return requested(account);
    if (!chat) {
      const info = await client.invoke({ _: 'checkChatInviteLink', invite_link: link });
      chat = await chatOf(client, info.chat_id);
    }
  } else {
    chat = await chatOf(client, tgChatId);
    if (KIND(chat) === 'private') throw bad(400, 'این گفتگو عضویت ندارد؛ «پیام» را بزنید');
    if ((await client.invoke({ _: 'joinChat', chat_id: chat.id }).catch(fail)) === 'requested') return requested(account);
    chat = await chatOf(client, chat.id);
  }
  return { dialogId: addDialog(account, chat), dialogs: listDialogs(account.id) };
}

/** Leaves a group / channel on Telegram and takes it off the user's list. */
export async function leaveTelegramChat(userId, dialogId) {
  const { account, client } = await exploreClient(userId);
  const d = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), account.id);
  if (!d) throw bad(404, 'گفتگو پیدا نشد');
  if (d.kind === 'private') throw bad(400, 'از گفتگوی خصوصی نمی‌شود خارج شد؛ از فهرست بردارید');
  await client.invoke({ _: 'leaveChat', chat_id: Number(d.tg_chat_id) }).catch((e) => {
    throw bad(400, `تلگرام: ${e?.message || e}`);
  });
  run('UPDATE tele_dialogs SET selected = 0, updated_at = ? WHERE id = ?', now(), d.id);
  return { dialogs: listDialogs(account.id) };
}
