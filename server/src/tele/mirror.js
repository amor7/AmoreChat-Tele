/**
 * Telegram channels mirrored into the app's own channels (owner only). The owner's Telegram account
 * reads each channel every few minutes and new posts appear in an app channel everyone can follow,
 * so a news channel costs VPN traffic once, not once per reader, and users need no Telegram.
 */
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, now, UPLOAD_DIR } from '../db.js';
import { settingNumber } from '../settings.js';
import { createChat, addMember, postMessage, systemMessage } from '../chats.js';
import { liveClient, overQuota } from './accounts.js';
import { ensureEgress } from './egress.js';
import { contentText, mediaMaxBytes } from './messages.js';

const bad = (code, m) => Object.assign(new Error(m), { statusCode: code, expose: true });

/** The owner's connected Telegram account (mirrors use only that). */
export function ownerAccount(user) {
  if (user.role !== 'owner') throw bad(403, 'فقط مالک');
  const a = get('SELECT * FROM tele_accounts WHERE user_id = ?', user.id);
  if (!a || a.status !== 'connected') throw bad(400, 'اول حساب تلگرام خودتان را از منو ← تلگرام وصل کنید');
  return a;
}

const publicMirror = (m) => ({
  id: m.id, tgChatId: m.tg_chat_id, title: m.title, chatId: m.chat_id, chatTitle: m.chat_title || '',
  withPhotos: !!m.with_photos, enabled: !!m.enabled, lastError: m.last_error, lastRunAt: m.last_run_at,
});
export const listMirrors = (accountId) =>
  all('SELECT m.*, c.title AS chat_title FROM tele_mirrors m LEFT JOIN chats c ON c.id = m.chat_id WHERE m.account_id = ? ORDER BY m.id', accountId).map(publicMirror);

/** Newest posts of a Telegram channel (from the network, through the tunnel), oldest first. */
async function fetchNew(client, chatId, afterId, limit = 50) {
  const ask = () => client.invoke({ _: 'getChatHistory', chat_id: chatId, from_message_id: 0, offset: 0, limit, only_local: false });
  let h = await ask();
  // From the network TDLib may answer with only a few messages at first: ask again once.
  if ((h?.messages?.length || 0) < Math.min(limit, 10)) h = await ask();
  return (h?.messages || []).filter((m) => m.id > afterId && !m.sending_state).sort((a, b) => a.id - b.id);
}

async function photoFile(client, content) {
  const sizes = (content.photo?.sizes || []).filter((s) => s.photo?.remote?.id);
  const max = mediaMaxBytes();
  const size = [...sizes].sort((a, b) => (b.photo.size || 0) - (a.photo.size || 0)).find((s) => !s.photo.size || s.photo.size <= max);
  if (!size) return null;
  let file = await client.invoke({ _: 'getRemoteFile', remote_file_id: size.photo.remote.id, file_type: { _: 'fileTypePhoto' } });
  if (!file.local?.is_downloading_completed) file = await client.invoke({ _: 'downloadFile', file_id: file.id, priority: 8, offset: 0, limit: 0, synchronous: true });
  return file.local?.path && fs.existsSync(file.local.path) ? { path: file.local.path, w: size.width, h: size.height } : null;
}

/** Posts a channel's messages newer than the last one copied. */
async function runMirror(m, owner, client, { limit = 50 } = {}) {
  const posts = await fetchNew(client, Number(m.tg_chat_id), m.last_msg_id, limit);
  const { registerFile, newRel } = await import('../routes/files.js');
  for (const p of posts) {
    let type = 'text';
    let fileId = null;
    let text = contentText(p.content);
    if (p.content?._ === 'messagePhoto' && m.with_photos) {
      try {
        const ph = await photoFile(client, p.content);
        if (ph) {
          const rel = newRel() + path.extname(ph.path);
          fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, rel)), { recursive: true });
          fs.copyFileSync(ph.path, path.join(UPLOAD_DIR, rel));
          fileId = (await registerFile(owner, { rel, mime: /\.png$/i.test(ph.path) ? 'image/png' : 'image/jpeg', name: 'telegram-photo.jpg', q: { w: ph.w, h: ph.h } })).id;
          type = 'image';
          text = text.replace(/^📷 عکس\n?/, '');
        }
      } catch {
        /* the post goes as text */
      }
    }
    if (type === 'text' && !text.trim()) continue;
    postMessage({ chatId: m.chat_id, senderId: owner.id, type, text: text.slice(0, 4000), fileId, forwardedFrom: `تلگرام · ${m.title}`.slice(0, 120) });
    run('UPDATE tele_mirrors SET last_msg_id = ? WHERE id = ?', p.id, m.id);
  }
  return posts.length;
}

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
 * New mirror: a Telegram channel the owner's account follows → an app channel (an existing one the
 * owner owns, or a new public one). The last `importLast` posts are copied right away.
 */
export async function createMirror(user, { tgChatId, chatId = null, newTitle = '', withPhotos = false, importLast = 3 }) {
  const account = ownerAccount(user);
  const tgId = String(tgChatId || '');
  if (!/^-?\d{1,20}$/.test(tgId)) throw bad(400, 'کانال تلگرام نامعتبر است');
  if (get('SELECT 1 FROM tele_mirrors WHERE account_id = ? AND tg_chat_id = ?', account.id, tgId)) throw bad(400, 'این کانال قبلاً اضافه شده است');
  const n = Number(importLast);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw bad(400, 'تعداد پست‌های اولیه باید بین ۰ و ۲۰ باشد');
  await ensureEgress().catch(() => {
    throw bad(503, 'تونل تلگرام وصل نیست');
  });
  const client = await liveClient(account);
  let tgChat;
  try {
    tgChat = await client.invoke({ _: 'getChat', chat_id: Number(tgId) });
  } catch {
    throw bad(404, 'این کانال در حساب تلگرام شما نیست');
  }
  if (!(tgChat.type?._ === 'chatTypeSupergroup' && tgChat.type.is_channel)) throw bad(400, 'فقط کانال تلگرام قابل انتشار است');
  let target;
  if (chatId) {
    target = get("SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? AND cm.role = 'owner' WHERE c.id = ? AND c.type = 'channel'", user.id, Number(chatId));
    if (!target) throw bad(400, 'کانال مقصد باید یکی از کانال‌های خود شما باشد');
  } else {
    const title = String(newTitle || `📰 ${tgChat.title}`).trim().slice(0, 100);
    const id = createChat({ type: 'channel', title, description: `پست‌های کانال تلگرام «${tgChat.title}»`, createdBy: user.id, isPublic: true });
    addMember(id, user.id, 'owner', { silent: true });
    systemMessage(id, `کانال «${title}» ساخته شد؛ پست‌های کانال تلگرام «${tgChat.title}» خودکار اینجا منتشر می‌شوند.`);
    target = get('SELECT * FROM chats WHERE id = ?', id);
  }
  // Start after the newest post, minus the ones to copy now.
  const recent = await fetchNew(client, Number(tgId), 0, Math.max(n, 1));
  const start = n > 0 && recent.length ? recent[Math.max(0, recent.length - n)].id - 1 : recent.at(-1)?.id || 0;
  const r = run(
    'INSERT INTO tele_mirrors (account_id, tg_chat_id, title, chat_id, last_msg_id, with_photos, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    account.id, tgId, String(tgChat.title || '').slice(0, 100), target.id, start, withPhotos ? 1 : 0, now(),
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
