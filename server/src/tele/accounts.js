import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { ensureEgress, egressStatus } from './egress.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'tele-sessions');
const live = new Map();

export function getLiveClient(accountId) {
  return live.get(Number(accountId))?.client || null;
}
export function upsertDialog(accountId, { tgChatId, kind, title, username, lastText, lastAt, lastOut, unread }) {
  const existing = get('SELECT * FROM tele_dialogs WHERE account_id = ? AND tg_chat_id = ?', accountId, String(tgChatId));
  const t = now();
  if (existing) {
    run(
      `UPDATE tele_dialogs SET kind = ?, title = ?, username = ?, last_text = ?, last_at = ?, last_out = ?, unread = ?, updated_at = ? WHERE id = ?`,
      kind || existing.kind, title || existing.title, username || existing.username,
      lastText ?? existing.last_text, lastAt ?? existing.last_at, lastOut == null ? existing.last_out : lastOut ? 1 : 0, unread ?? existing.unread, t, existing.id,
    );
    return existing.id;
  }
  const r = run(
    `INSERT INTO tele_dialogs (account_id, tg_chat_id, kind, title, username, selected, last_text, last_at, last_out, unread, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?,?,?,?,?)`,
    accountId, String(tgChatId), kind || 'private', title || '', username || '', lastText || '', lastAt || 0, lastOut ? 1 : 0, unread || 0, t, t,
  );
  return Number(r.lastInsertRowid);
}
function apiCredentials() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  return { apiId, apiHash, ok: apiId > 0 && apiHash.length >= 16 };
}
export function teleRuntimeInfo() {
  let tdl = false;
  try { require.resolve('tdl'); tdl = true; } catch { try { tdl = !!import.meta.resolve?.('tdl'); } catch { tdl = false; } }
  return { apiConfigured: apiCredentials().ok, tdlAvailable: tdl, egress: egressStatus() };
}
function sessionDir(accountId) {
  const dir = path.join(SESSIONS_ROOT, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function getAccountForUser(userId) { return get('SELECT * FROM tele_accounts WHERE user_id = ?', userId); }
export function publicAccount(row) {
  if (!row) return null;
  const s = String(row.phone || '');
  const phone = s.length < 6 ? '***' : s.slice(0, 4) + '***' + s.slice(-2);
  return { id: row.id, phone, tgUserId: row.tg_user_id, displayName: row.display_name, username: row.username, status: row.status, allowShared: !!row.allow_shared, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function listDialogs(accountId) {
  return all('SELECT * FROM tele_dialogs WHERE account_id = ? ORDER BY last_at DESC, title', accountId).map((d) => ({
    id: d.id, tgChatId: d.tg_chat_id, kind: d.kind, title: d.title, username: d.username, selected: !!d.selected, lastSyncedMsgId: d.last_synced_msg_id,
    lastText: d.last_text, lastAt: d.last_at || null, lastOut: !!d.last_out, unread: d.unread,
  }));
}
export function setDialogSelected(accountId, dialogId, selected) {
  const d = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', Number(dialogId), accountId);
  if (!d) throw Object.assign(new Error('گفتگو پیدا نشد'), { statusCode: 404 });
  run('UPDATE tele_dialogs SET selected = ?, updated_at = ? WHERE id = ?', selected ? 1 : 0, now(), d.id);
  return listDialogs(accountId);
}
export async function beginLogin(userId, phone) {
  const phoneClean = String(phone || '').replace(/\s+/g, '');
  if (!/^\+?\d{8,15}$/.test(phoneClean)) throw Object.assign(new Error('شماره نامعتبر'), { statusCode: 400 });
  const cred = apiCredentials();
  if (!cred.ok) throw Object.assign(new Error('TELEGRAM_API_ID و HASH تنظیم نشده'), { statusCode: 503 });
  try { await ensureEgress(); } catch (e) { throw Object.assign(new Error('تونل آماده نیست: ' + e.message), { statusCode: 503, expose: true }); }
  let row = getAccountForUser(userId);
  const t = now();
  // The status moves to awaiting_code only once Telegram has accepted the number, so a failed
  // attempt never leaves the panel on the code step.
  if (!row) {
    const r = run(`INSERT INTO tele_accounts (user_id, phone, status, session_dir, created_at, updated_at) VALUES (?,?,?,?,?,?)`, userId, phoneClean, 'disconnected', '', t, t);
    row = get('SELECT * FROM tele_accounts WHERE id = ?', Number(r.lastInsertRowid));
  } else {
    run(`UPDATE tele_accounts SET phone = ?, updated_at = ? WHERE id = ?`, phoneClean, t, row.id);
  }
  const dir = sessionDir(row.id);
  run(`UPDATE tele_accounts SET session_dir = ? WHERE id = ?`, dir, row.id);
  row = getAccountForUser(userId);
  // A client from an earlier attempt still holds the session database: TDLib can't open it twice.
  await closeLive(row.id);
  let client = null;
  try {
    client = await createTdlibClient(row, cred);
    let state = await authState(client);
    if (state === 'authorizationStateWaitPhoneNumber') {
      await client.invoke({
        _: 'setAuthenticationPhoneNumber',
        phone_number: phoneClean,
        settings: { _: 'phoneNumberAuthenticationSettings', allow_flash_call: false, allow_missed_call: false, is_current_phone_number: false, has_unknown_phone_number: false, allow_sms_retriever_api: false, authentication_tokens: [] },
      });
      state = await authState(client);
    }
    const status = { authorizationStateWaitCode: 'awaiting_code', authorizationStateWaitPassword: 'awaiting_password', authorizationStateReady: 'connected' }[state];
    if (!status) throw new Error(`وضعیت غیرمنتظره TDLib: ${state}`);
    live.set(row.id, { client, phase: status, userId });
    run(`UPDATE tele_accounts SET status = ?, updated_at = ? WHERE id = ?`, status, now(), row.id);
    const result = { awaiting_code: 'code_required', awaiting_password: 'password_required', connected: 'ready' }[status];
    return { status: result, account: publicAccount(getAccountForUser(userId)) };
  } catch (e) {
    if (client) await client.close().catch(() => {});
    live.delete(row.id);
    run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), row.id);
    const msg = String(e?.message || e);
    if (/Cannot find (module|package)|libtdjson|ERR_MODULE_NOT_FOUND/i.test(msg)) {
      throw Object.assign(new Error('TDLib روی سرور نصب نیست (tdl / prebuilt-tdlib)'), { statusCode: 503, expose: true });
    }
    throw Object.assign(new Error('ورود به تلگرام ناموفق بود: ' + msg), { statusCode: 502, expose: true });
  }
}
async function closeLive(accountId) {
  const handle = live.get(accountId);
  live.delete(accountId);
  if (handle?.client) await handle.client.close().catch(() => {});
}
// Current authorization state once TDLib is past its startup steps (tdl sends the parameters).
async function authState(client, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = (await client.invoke({ _: 'getAuthorizationState' }))._;
    if (s !== 'authorizationStateWaitTdlibParameters' && s !== 'authorizationStateWaitEncryptionKey') return s;
    if (Date.now() > until) throw new Error('TDLib آماده نشد');
    await new Promise((r) => setTimeout(r, 200));
  }
}
export async function submitCode(userId, code) {
  const row = getAccountForUser(userId);
  if (!row) throw Object.assign(new Error('ابتدا شماره را وارد کنید'), { statusCode: 400 });
  const handle = live.get(row.id);
  if (!handle?.client) return loginExpired(row);
  try {
    await handle.client.invoke({ _: 'checkAuthenticationCode', code: String(code).trim() });
  } catch (e) {
    throw Object.assign(new Error(/CODE_INVALID/i.test(String(e.message)) ? 'کد نامعتبر' : e.message || 'کد نامعتبر'), { statusCode: 400 });
  }
  // With two-step verification TDLib asks for the password next instead of failing.
  if ((await authState(handle.client)) === 'authorizationStateWaitPassword') {
    handle.phase = 'awaiting_password';
    run(`UPDATE tele_accounts SET status = 'awaiting_password', updated_at = ? WHERE id = ?`, now(), row.id);
    return { status: 'password_required', account: publicAccount(getAccountForUser(userId)) };
  }
  return loggedIn(row, handle);
}
export async function submitPassword(userId, password) {
  const row = getAccountForUser(userId);
  if (!row) throw Object.assign(new Error('ابتدا شماره را وارد کنید'), { statusCode: 400 });
  const handle = live.get(row.id);
  if (!handle?.client) return loginExpired(row);
  try {
    await handle.client.invoke({ _: 'checkAuthenticationPassword', password: String(password) });
  } catch (e) {
    throw Object.assign(new Error(/PASSWORD_HASH_INVALID/i.test(String(e.message)) ? 'رمز دومرحله‌ای اشتباه است' : e.message || 'رمز نامعتبر'), { statusCode: 400 });
  }
  return loggedIn(row, handle);
}
async function loggedIn(row, handle) {
  handle.phase = 'ready';
  run(`UPDATE tele_accounts SET status = 'connected', updated_at = ? WHERE id = ?`, now(), row.id);
  try {
    const me = await handle.client.invoke({ _: 'getMe' });
    run(`UPDATE tele_accounts SET tg_user_id = ?, display_name = ?, username = ? WHERE id = ?`, me.id, [me.first_name, me.last_name].filter(Boolean).join(' '), me.username || '', row.id);
  } catch {}
  return { status: 'ready', account: publicAccount(getAccountForUser(row.user_id)) };
}
// The TDLib client of this login is gone (server restarted between the steps): start over.
function loginExpired(row) {
  run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), row.id);
  throw Object.assign(new Error('مهلت ورود تمام شد؛ دوباره شماره را ارسال کنید'), { statusCode: 409 });
}
// A login left half-way (awaiting code/password) has no TDLib client after a restart: show the
// phone step again instead of a code field that can't work.
export function clearStaleLogin(row) {
  if (row && /^awaiting_/.test(row.status) && !live.get(row.id)?.client) {
    run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), row.id);
    return get('SELECT * FROM tele_accounts WHERE id = ?', row.id);
  }
  return row;
}
export async function disconnectAccount(userId) {
  const row = getAccountForUser(userId);
  if (!row) return { ok: true };
  const handle = live.get(row.id);
  if (handle?.client) { try { await handle.client.invoke({ _: 'logOut' }); } catch {} live.delete(row.id); }
  run(`UPDATE tele_accounts SET status = 'disconnected', session_dir = '', tg_user_id = NULL, display_name = '', username = '' WHERE id = ?`, row.id);
  run('DELETE FROM tele_dialogs WHERE account_id = ?', row.id);
  try { if (row.session_dir?.startsWith(SESSIONS_ROOT)) fs.rmSync(row.session_dir, { recursive: true, force: true }); } catch {}
  return { ok: true };
}
async function createTdlibClient(row, cred) {
  const tdl = await import('tdl');
  try { const { getTdjson } = await import('prebuilt-tdlib'); tdl.configure({ tdjson: getTdjson() }); } catch {}
  const socks = await ensureEgress();
  // tdl 8 connects in createClient (there is no connect()) and answers setTdlibParameters itself.
  const client = tdl.createClient({ apiId: cred.apiId, apiHash: cred.apiHash, databaseDirectory: path.join(row.session_dir || sessionDir(row.id), 'db'), filesDirectory: path.join(row.session_dir || sessionDir(row.id), 'files') });
  client.on('error', (e) => console.warn('[tele] tdlib:', e?.message || e));
  try {
    await authState(client);
    await useProxy(client, socks);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}
// Fail closed: without the local SOCKS proxy TDLib would reach Telegram directly, so a failure here
// aborts the login. Newer TDLib takes addProxy(proxy, enable, comment), older addProxy(server, port, enable, type).
async function useProxy(client, socks) {
  const type = { _: 'proxyTypeSocks5', username: '', password: '' };
  try {
    await client.invoke({ _: 'addProxy', proxy: { _: 'proxy', server: socks.host, port: socks.port, type }, enable: true, comment: 'AmoreChat egress' });
  } catch (e) {
    try {
      await client.invoke({ _: 'addProxy', server: socks.host, port: socks.port, enable: true, type });
    } catch {
      throw new Error('تنظیم پروکسی در TDLib ناموفق بود: ' + (e?.message || e));
    }
  }
}
