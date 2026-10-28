import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { ensureEgress, egressStatus } from './egress.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'tele-sessions');
const live = new Map();

export function getLiveClient(accountId) {
  return live.get(Number(accountId))?.client || null;
}
export function upsertDialog(accountId, { tgChatId, kind, title, username }) {
  const existing = get('SELECT * FROM tele_dialogs WHERE account_id = ? AND tg_chat_id = ?', accountId, String(tgChatId));
  const t = now();
  if (existing) {
    run(`UPDATE tele_dialogs SET kind = ?, title = ?, username = ?, updated_at = ? WHERE id = ?`, kind || existing.kind, title || existing.title, username || existing.username, t, existing.id);
    return existing.id;
  }
  const r = run(`INSERT INTO tele_dialogs (account_id, tg_chat_id, kind, title, username, selected, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)`, accountId, String(tgChatId), kind || 'private', title || '', username || '', t, t);
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
  return all('SELECT * FROM tele_dialogs WHERE account_id = ? ORDER BY selected DESC, title', accountId).map((d) => ({
    id: d.id, tgChatId: d.tg_chat_id, kind: d.kind, title: d.title, username: d.username, selected: !!d.selected, lastSyncedMsgId: d.last_synced_msg_id,
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
  try { await ensureEgress(); } catch (e) { throw Object.assign(new Error('تونل آماده نیست: ' + e.message), { statusCode: 503 }); }
  let row = getAccountForUser(userId);
  const t = now();
  if (!row) {
    const r = run(`INSERT INTO tele_accounts (user_id, phone, status, session_dir, created_at, updated_at) VALUES (?,?,?,?,?,?)`, userId, phoneClean, 'awaiting_code', '', t, t);
    row = get('SELECT * FROM tele_accounts WHERE id = ?', Number(r.lastInsertRowid));
  } else {
    run(`UPDATE tele_accounts SET phone = ?, status = 'awaiting_code', updated_at = ? WHERE id = ?`, phoneClean, t, row.id);
    row = getAccountForUser(userId);
  }
  const dir = sessionDir(row.id);
  run(`UPDATE tele_accounts SET session_dir = ? WHERE id = ?`, dir, row.id);
  row = getAccountForUser(userId);
  try {
    const client = await createTdlibClient(row, cred);
    live.set(row.id, { client, phase: 'awaiting_code', userId });
    await client.invoke({ _: 'setAuthenticationPhoneNumber', phone_number: phoneClean, settings: { _: 'phoneNumberAuthenticationSettings', allow_flash_call: false, is_current_phone_number: false, allow_sms_retriever_api: false } });
    return { status: 'code_required', account: publicAccount(getAccountForUser(userId)) };
  } catch (e) {
    if (/tdl|prebuilt|libtdjson|Cannot find/i.test(String(e.message))) {
      return { status: 'code_required', account: publicAccount(getAccountForUser(userId)), notice: 'TDLib نصب نشده: npm i tdl prebuilt-tdlib' };
    }
    throw e;
  }
}
export async function submitCode(userId, code) {
  const row = getAccountForUser(userId);
  if (!row) throw Object.assign(new Error('ابتدا شماره را وارد کنید'), { statusCode: 400 });
  const handle = live.get(row.id);
  if (!handle?.client) {
    run(`UPDATE tele_accounts SET status = 'awaiting_tdlib', updated_at = ? WHERE id = ?`, now(), row.id);
    return { status: 'awaiting_tdlib', account: publicAccount(getAccountForUser(userId)), notice: 'TDLib لازم است' };
  }
  try {
    await handle.client.invoke({ _: 'checkAuthenticationCode', code: String(code).trim() });
    run(`UPDATE tele_accounts SET status = 'connected', updated_at = ? WHERE id = ?`, now(), row.id);
    handle.phase = 'ready';
    try {
      const me = await handle.client.invoke({ _: 'getMe' });
      run(`UPDATE tele_accounts SET tg_user_id = ?, display_name = ?, username = ? WHERE id = ?`, me.id, [me.first_name, me.last_name].filter(Boolean).join(' '), me.username || '', row.id);
    } catch {}
    return { status: 'ready', account: publicAccount(getAccountForUser(userId)) };
  } catch (e) {
    if (/PASSWORD|password/i.test(String(e.message))) {
      run(`UPDATE tele_accounts SET status = 'awaiting_password' WHERE id = ?`, row.id);
      return { status: 'password_required', account: publicAccount(getAccountForUser(userId)) };
    }
    throw Object.assign(new Error(e.message || 'کد نامعتبر'), { statusCode: 400 });
  }
}
export async function submitPassword(userId, password) {
  const row = getAccountForUser(userId);
  const handle = live.get(row?.id);
  if (!handle?.client) throw Object.assign(new Error('نشست TDLib نیست'), { statusCode: 503 });
  await handle.client.invoke({ _: 'checkAuthenticationPassword', password: String(password) });
  run(`UPDATE tele_accounts SET status = 'connected' WHERE id = ?`, row.id);
  handle.phase = 'ready';
  return { status: 'ready', account: publicAccount(getAccountForUser(userId)) };
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
  const client = tdl.createClient({ apiId: cred.apiId, apiHash: cred.apiHash, databaseDirectory: path.join(row.session_dir || sessionDir(row.id), 'db'), filesDirectory: path.join(row.session_dir || sessionDir(row.id), 'files') });
  await client.connect();
  try { await client.invoke({ _: 'addProxy', server: socks.host, port: socks.port, enable: true, type: { _: 'proxyTypeSocks5' } }); } catch {}
  return client;
}
