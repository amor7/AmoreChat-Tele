/**
 * Telegram channels and groups mirrored into the app's own channels (owner only). The owner's
 * Telegram account reads each one every few minutes and new posts appear in an app channel, so a
 * news channel costs VPN traffic once, not once per reader, and users need no Telegram. A group's
 * messages show who wrote them.
 * Photos are fetched from Telegram only when someone first opens one; videos and files the same way,
 * but only by users the admin allowed (see access.js). Once fetched, every member has it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, now, UPLOAD_DIR } from '../db.js';
import { settingNumber } from '../settings.js';
import { createChat, addMember, postMessage, systemMessage, getMember, loadMessage } from '../chats.js';
import { toChat } from '../realtime.js';
import { randomCode } from '../auth.js';
import { liveClient, overQuota } from './accounts.js';
import { ensureEgress } from './egress.js';
import { contentText, mediaMaxBytes, fileMaxBytes, fileInfo, voiceInfo, senderOf } from './messages.js';
import { accessAllowed } from '../access.js';

const bad = (code, m) => Object.assign(new Error(m), { statusCode: code, expose: true });

/** The owner's connected Telegram account (mirrors use only that). */
export function ownerAccount(user) {
  if (user.role !== 'owner') throw bad(403, 'فقط مالک');
  const a = get('SELECT * FROM tele_accounts WHERE user_id = ?', user.id);
  if (!a || a.status !== 'connected') throw bad(400, 'اول حساب تلگرام خودتان را از منو ← تلگرام وصل کنید');
  return a;
}

// ---------- Who sees the app channel ----------
// public: listed in "explore"; all: every user is a member (new users too); link: only with its invite link.
export const VISIBILITY = ['public', 'all', 'link'];
const visibilityOf = (chat) => (!chat ? 'public' : chat.auto_join ? 'all' : chat.is_public ? 'public' : 'link');
const linkInvite = (chatId) => get('SELECT code FROM chat_invites WHERE chat_id = ? AND max_uses IS NULL AND expires_at IS NULL ORDER BY created_at DESC', chatId)?.code || null;
function newInvite(chatId, by) {
  const code = randomCode(8);
  run('INSERT INTO chat_invites (code, chat_id, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, NULL, NULL, ?)', code, chatId, by, now());
  return code;
}

/** Applies a visibility to the app channel; "all" adds every user now (and registration adds new ones). */
export function setVisibility(chatId, visibility, by) {
  if (!VISIBILITY.includes(visibility)) throw bad(400, 'حالت نمایش نامعتبر است');
  run('UPDATE chats SET is_public = ?, auto_join = ? WHERE id = ?', visibility === 'link' ? 0 : 1, visibility === 'all' ? 1 : 0, chatId);
  if (visibility === 'all') {
    for (const u of all('SELECT id FROM users WHERE banned = 0 AND id NOT IN (SELECT user_id FROM chat_members WHERE chat_id = ?) AND id NOT IN (SELECT user_id FROM chat_bans WHERE chat_id = ?)', chatId, chatId)) {
      addMember(chatId, u.id, 'member', { silent: true });
    }
  }
  if (visibility === 'link' && !linkInvite(chatId)) newInvite(chatId, by);
  toChat(chatId, 'chat:changed', { chatId });
}
/** A new invite link for a link-only channel; the old links stop working. */
export function renewInvite(chatId, by) {
  run('DELETE FROM chat_invites WHERE chat_id = ?', chatId);
  return newInvite(chatId, by);
}

const publicMirror = (m) => ({
  id: m.id, tgChatId: m.tg_chat_id, title: m.title, chatId: m.chat_id, chatTitle: m.chat_title || '',
  kind: m.kind || 'channel', withPhotos: !!m.with_photos, withFiles: !!m.with_files, enabled: !!m.enabled, lastError: m.last_error, lastRunAt: m.last_run_at,
  visibility: visibilityOf(m), inviteCode: !m.is_public ? linkInvite(m.chat_id) : null,
  members: get('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', m.chat_id).n,
});
export const listMirrors = (accountId) =>
  all('SELECT m.*, c.title AS chat_title, c.is_public, c.auto_join FROM tele_mirrors m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.account_id = ? ORDER BY m.id', accountId).map(publicMirror);

const isChannel = (chat) => chat?.type?._ === 'chatTypeSupergroup' && chat.type.is_channel;
// What can be mirrored: a channel, or a group (its messages show the sender).
const sourceKind = (chat) => (isChannel(chat) ? 'channel' : chat?.type?._ === 'chatTypeSupergroup' || chat?.type?._ === 'chatTypeBasicGroup' ? 'group' : null);
// A public username from "@name", "name" or a t.me link.
export const usernameOf = (q) => {
  const m = String(q || '').trim().match(/^(?:@|(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?)?([a-zA-Z][a-zA-Z0-9_]{3,31})\/?$/);
  return m ? m[1] : null;
};
async function usernameOfChat(client, chat) {
  if (chat.type?._ !== 'chatTypeSupergroup') return '';
  const sg = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id }).catch(() => null);
  return sg?.usernames?.active_usernames?.[0] || '';
}

/**
 * The owner's Telegram channels and groups, live from Telegram (all of them, not only the chats
 * added in the Telegram page), filtered by `q`. "@name" or a t.me link also finds a public one not joined.
 */
export async function telegramChannels(user, q = '') {
  const account = ownerAccount(user);
  await ensureEgress().catch(() => {
    throw bad(503, 'تونل تلگرام وصل نیست');
  });
  const client = await liveClient(account);
  // Newer TDLib only returns chats that were loaded first; loadChats fails once all are loaded.
  for (let i = 0; i < 5; i++) {
    const more = await client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 200 }).then(() => true, () => false);
    if (!more) break;
  }
  const ids = (await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 1000 }))?.chat_ids || [];
  const term = String(q || '').trim().toLowerCase().replace(/^@/, '');
  const out = [];
  for (const id of ids) {
    const chat = await client.invoke({ _: 'getChat', chat_id: id }).catch(() => null);
    const kind = sourceKind(chat);
    if (!kind) continue;
    const username = await usernameOfChat(client, chat);
    if (term && !`${chat.title} ${username}`.toLowerCase().includes(term)) continue;
    out.push({ tgChatId: String(id), title: chat.title || '', username, kind, joined: true });
  }
  const uname = usernameOf(q);
  if (uname && !out.some((c) => c.username.toLowerCase() === uname.toLowerCase())) {
    const chat = await client.invoke({ _: 'searchPublicChat', username: uname }).catch(() => null);
    if (sourceKind(chat)) out.unshift({ tgChatId: String(chat.id), title: chat.title || '', username: uname, kind: sourceKind(chat), joined: false });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'fa')).slice(0, 300);
}

/** Newest posts of a Telegram channel (from the network, through the tunnel), oldest first. */
async function fetchNew(client, chatId, afterId, limit = 50) {
  const ask = () => client.invoke({ _: 'getChatHistory', chat_id: chatId, from_message_id: 0, offset: 0, limit, only_local: false });
  let h = await ask();
  // From the network TDLib may answer with only a few messages at first: ask again once.
  if ((h?.messages?.length || 0) < Math.min(limit, 10)) h = await ask();
  return (h?.messages || []).filter((m) => m.id > afterId && !m.sending_state).sort((a, b) => a.id - b.id);
}

// The biggest size of a photo within the limit (Telegram keeps several sizes of every photo).
function photoSize(content) {
  const sizes = (content.photo?.sizes || []).filter((s) => s.photo?.remote?.id);
  const max = mediaMaxBytes();
  return [...sizes].sort((a, b) => (b.photo.size || 0) - (a.photo.size || 0)).find((s) => !s.photo.size || s.photo.size <= max) || null;
}

/**
 * The photo, video or file of a post to fetch later (nothing is downloaded here), or null: photos
 * when the mirror takes photos, videos / files / music when it takes files and they are within the
 * file size limit (a bigger one stays a line of text with its name).
 */
function pendingOf(content, m) {
  if (content?._ === 'messagePhoto') {
    const size = m.with_photos ? photoSize(content) : null;
    return size && { kind: 'photo', fileType: 'fileTypePhoto', remote: size.photo.remote.id, w: size.width, h: size.height, size: size.photo.size, name: '', mime: '', duration: null, label: /^📷 عکس\n?/ };
  }
  if (!m.with_files) return null;
  const f = fileInfo(content) || voiceInfo(content);
  if (!f?.remote || (f.size && f.size > fileMaxBytes())) return null;
  const voice = f.type === 'voice';
  const kind = f.video ? 'video' : voice || content._ === 'messageAudio' ? 'audio' : 'file';
  return {
    kind, fileType: voice ? 'fileTypeVoiceNote' : f.fileType, remote: f.remote, w: f.w || null, h: f.h || null, size: f.size || null,
    name: voice ? 'telegram-voice.ogg' : f.name, mime: f.mime || '', duration: f.duration || null, label: /^(📎|🎬|🎵|🎤|GIF)[^\n]*\n?/,
  };
}
// Service messages of groups (joined, left, pinned, title changed…) are not copied.
const SERVICE = /^message(Chat|Pin|Supergroup|BasicGroup|ContactRegistered|ForumTopic|VideoChat|Game|Unsupported|ScreenshotTaken|Custom|Gift|Boost|Giveaway|ProximityAlert|WebApp|Bot)/;

/** Posts a channel's (or group's) messages newer than the last one copied. */
async function runMirror(m, owner, client, { limit = m.kind === 'group' ? 100 : 50 } = {}) {
  const posts = await fetchNew(client, Number(m.tg_chat_id), m.last_msg_id, limit);
  for (const p of posts) {
    let text = SERVICE.test(p.content?._ || '') ? '' : contentText(p.content);
    // A photo / file is only noted here (no download): it is fetched when someone first opens it.
    const media = text ? pendingOf(p.content, m) : null;
    if (media) text = text.replace(media.label, '');
    if (!media && !text.trim()) {
      run('UPDATE tele_mirrors SET last_msg_id = ? WHERE id = ?', p.id, m.id);
      continue;
    }
    const who = m.kind === 'group' ? (await senderOf(client, p.sender_id)).name : '';
    const msg = postMessage({ chatId: m.chat_id, senderId: owner.id, type: 'text', text: text.slice(0, 4000), forwardedFrom: `تلگرام · ${m.title}${who ? ` · ${who}` : ''}`.slice(0, 120) });
    if (media) {
      run(
        'INSERT INTO tele_mirror_photos (message_id, account_id, remote_id, w, h, size, kind, file_type, name, mime, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        msg.id, m.account_id, media.remote, media.w || null, media.h || null, media.size || null, media.kind, media.fileType, String(media.name || '').slice(0, 200), media.mime, media.duration,
      );
      // The post was sent before its media note existed: send it again with the placeholder.
      toChat(m.chat_id, 'message:edit', loadMessage(msg.id));
    }
    run('UPDATE tele_mirrors SET last_msg_id = ? WHERE id = ?', p.id, m.id);
  }
  return posts.length;
}

const loading = new Map();
const IMAGE_MIME = (rel) => (/\.png$/i.test(rel) ? 'image/png' : /\.webp$/i.test(rel) ? 'image/webp' : 'image/jpeg');
/**
 * A mirrored post's photo, video or file, fetched from Telegram by the first member who opens it
 * (through the owner's account); the post then becomes an ordinary image / video / file post for
 * everyone. Videos and files only by users the admin allowed.
 */
export function loadMirrorMedia(user, messageId) {
  const id = Number(messageId);
  const p = get('SELECT * FROM tele_mirror_photos WHERE message_id = ?', id);
  const msg = get('SELECT * FROM messages WHERE id = ?', id);
  // Fetched a moment ago by someone else (two people opening it at once): that post is the answer.
  const fetched = !p && msg?.file_id && String(msg.forwarded_from || '').startsWith('تلگرام · ');
  if (!msg || msg.deleted || (!p && !fetched)) throw bad(404, 'فایل پیدا نشد');
  const chat = get('SELECT * FROM chats WHERE id = ?', msg.chat_id);
  if (!getMember(msg.chat_id, user.id) && !chat?.is_public) throw bad(403, 'شما عضو این کانال نیستید');
  if (fetched) return loadMessage(id);
  if (p.kind !== 'photo' && !accessAllowed('mirror_files', user)) throw bad(403, 'دریافت ویدیو و فایل کانال‌ها برای شما فعال نیست؛ وقتی کسی که اجازه دارد آن را باز کند، برای شما هم باز می‌شود');
  if (!loading.has(id)) {
    loading.set(
      id,
      (async () => {
        const account = get('SELECT * FROM tele_accounts WHERE id = ?', p.account_id);
        const owner = account && get('SELECT * FROM users WHERE id = ?', account.user_id);
        if (!account || account.status !== 'connected' || !owner) throw bad(503, 'حساب تلگرام مالک وصل نیست؛ عکس فعلاً در دسترس نیست');
        if (overQuota(account)) throw bad(429, 'سقف مصرف ماهانه تلگرام تمام شده؛ عکس فعلاً در دسترس نیست');
        await ensureEgress().catch(() => {
          throw bad(503, 'تونل تلگرام وصل نیست؛ کمی بعد دوباره امتحان کنید');
        });
        const client = await liveClient(account);
        let file;
        try {
          file = await client.invoke({ _: 'getRemoteFile', remote_file_id: p.remote_id, file_type: { _: p.file_type || 'fileTypePhoto' } });
          if (!file.local?.is_downloading_completed) file = await client.invoke({ _: 'downloadFile', file_id: file.id, priority: 16, offset: 0, limit: 0, synchronous: true });
        } catch (e) {
          throw bad(502, 'دریافت از تلگرام ناموفق بود: ' + (e?.message || e));
        }
        if (!file.local?.path || !fs.existsSync(file.local.path)) throw bad(502, 'دریافت از تلگرام ناموفق بود');
        const { registerFile, newRel } = await import('../routes/files.js');
        const photo = p.kind === 'photo';
        const ext = path.extname(file.local.path) || path.extname(p.name || '') || (photo ? '.jpg' : p.kind === 'video' ? '.mp4' : '');
        const rel = newRel() + ext.slice(0, 12);
        fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, rel)), { recursive: true });
        fs.copyFileSync(file.local.path, path.join(UPLOAD_DIR, rel));
        const mime = photo ? IMAGE_MIME(rel) : p.mime || (p.kind === 'video' ? 'video/mp4' : 'application/octet-stream');
        const f = await registerFile(owner, { rel, mime, name: photo ? 'telegram-photo.jpg' : p.name || 'telegram-file', q: { w: p.w, h: p.h, dur: p.duration } });
        const type = f.kind === 'image' ? 'image' : f.kind === 'video' ? 'video' : 'file';
        run('UPDATE messages SET type = ?, file_id = ? WHERE id = ?', type, f.id, id);
        run('DELETE FROM tele_mirror_photos WHERE message_id = ?', id);
        const updated = loadMessage(id);
        toChat(msg.chat_id, 'message:edit', updated);
        return updated;
      })().finally(() => loading.delete(id)),
    );
  }
  return loading.get(id);
}
export const loadMirrorPhoto = loadMirrorMedia;

let running = false;
/** One round over all enabled mirrors (also from the "run now" button). */
export async function runMirrors({ only = null } = {}) {
  if (running) return { busy: true };
  running = true;
  let posted = 0;
  try {
    const list = all(`SELECT * FROM tele_mirrors WHERE enabled = 1${only ? ' AND id = ?' : ''}`, ...(only ? [only] : []));
    for (const m of list) {
      const account = get('SELECT * FROM tele_accounts WHERE id = ?', m.account_id);
      const owner = account && get('SELECT * FROM users WHERE id = ?', account.user_id);
      try {
        if (!account || account.status !== 'connected' || owner?.role !== 'owner') throw new Error('حساب تلگرام مالک وصل نیست');
        if (overQuota(account)) throw new Error('سقف مصرف ماهانه حساب مالک تمام شده است');
        await ensureEgress();
        const client = await liveClient(account);
        if (!client) throw new Error('اتصال به تلگرام برقرار نیست');
        posted += await runMirror(m, owner, client);
        run("UPDATE tele_mirrors SET last_error = '', last_run_at = ? WHERE id = ?", now(), m.id);
      } catch (e) {
        run('UPDATE tele_mirrors SET last_error = ?, last_run_at = ? WHERE id = ?', String(e?.message || e).slice(0, 300), now(), m.id);
      }
    }
  } finally {
    running = false;
  }
  return { posted };
}

/**
 * New mirror: a Telegram channel (one the owner's account follows, or a public one by @username) →
 * an app channel (an existing one the owner owns, or a new one). The last `importLast` posts are
 * copied right away. `visibility` sets who sees the app channel (see VISIBILITY).
 */
export async function createMirror(user, { tgChatId, chatId = null, newTitle = '', withPhotos = false, withFiles = false, importLast = 3, visibility = 'public' }) {
  const account = ownerAccount(user);
  const tgId = String(tgChatId || '');
  if (!/^-?\d{1,20}$/.test(tgId)) throw bad(400, 'کانال تلگرام نامعتبر است');
  if (get('SELECT 1 FROM tele_mirrors WHERE account_id = ? AND tg_chat_id = ?', account.id, tgId)) throw bad(400, 'این کانال قبلاً اضافه شده است');
  const n = Number(importLast);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw bad(400, 'تعداد پست‌های اولیه باید بین ۰ و ۲۰ باشد');
  if (!VISIBILITY.includes(visibility)) throw bad(400, 'حالت نمایش نامعتبر است');
  await ensureEgress().catch(() => {
    throw bad(503, 'تونل تلگرام وصل نیست');
  });
  const client = await liveClient(account);
  let tgChat;
  try {
    tgChat = await client.invoke({ _: 'getChat', chat_id: Number(tgId) });
  } catch {
    throw bad(404, 'این کانال یا گروه در حساب تلگرام شما نیست');
  }
  const kind = sourceKind(tgChat);
  if (!kind) throw bad(400, 'فقط کانال یا گروه تلگرام قابل انتشار است');
  const what = kind === 'group' ? 'گروه' : 'کانال';
  let target;
  if (chatId) {
    target = get("SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? AND cm.role = 'owner' WHERE c.id = ? AND c.type = 'channel'", user.id, Number(chatId));
    if (!target) throw bad(400, 'کانال مقصد باید یکی از کانال‌های خود شما باشد');
  } else {
    const title = String(newTitle || `📰 ${tgChat.title}`).trim().slice(0, 100);
    const id = createChat({ type: 'channel', title, description: `${kind === 'group' ? 'پیام‌های' : 'پست‌های'} ${what} تلگرام «${tgChat.title}»`, createdBy: user.id, isPublic: visibility !== 'link' });
    addMember(id, user.id, 'owner', { silent: true });
    systemMessage(id, `کانال «${title}» ساخته شد؛ ${kind === 'group' ? 'پیام‌های' : 'پست‌های'} ${what} تلگرام «${tgChat.title}» خودکار اینجا منتشر می‌شوند.`);
    target = get('SELECT * FROM chats WHERE id = ?', id);
  }
  setVisibility(target.id, visibility, user.id);
  // Start after the newest post, minus the ones to copy now.
  const recent = await fetchNew(client, Number(tgId), 0, Math.max(n, 1));
  const start = n > 0 && recent.length ? recent[Math.max(0, recent.length - n)].id - 1 : recent.at(-1)?.id || 0;
  const r = run(
    'INSERT INTO tele_mirrors (account_id, tg_chat_id, title, chat_id, last_msg_id, with_photos, with_files, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    account.id, tgId, String(tgChat.title || '').slice(0, 100), target.id, start, withPhotos ? 1 : 0, withFiles ? 1 : 0, kind, now(),
  );
  const id = Number(r.lastInsertRowid);
  if (n > 0) await runMirrors({ only: id });
  return listMirrors(account.id).find((m) => m.id === id);
}

export function startMirrorLoop() {
  let last = 0;
  setInterval(() => {
    const every = Math.max(1, settingNumber('tele_mirror_minutes') || 5) * 60000;
    if (Date.now() - last < every || !get('SELECT 1 FROM tele_mirrors WHERE enabled = 1')) return;
    last = Date.now();
    runMirrors().catch(() => {});
  }, Number(process.env.TELE_MIRROR_CHECK_MS) || 30000).unref();
}
