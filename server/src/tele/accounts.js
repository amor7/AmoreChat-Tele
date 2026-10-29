import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { settingNumber } from '../settings.js';
import { ensureEgress, egressStatus } from './egress.js';
import { teleAlert } from './alerts.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'tele-sessions');
const live = new Map();
// TDLib updates (e.g. a sent message got its final id) for code that keeps state per account.
const updateHandlers = [];
export const onTeleUpdate = (fn) => updateHandlers.push(fn);

const opening = new Map();
// Nobody used Telegram for this long: close the TDLib connection. A connected client receives
// updates for every chat of the account, so this is what saves the server's VPN traffic.
const IDLE_MS = Math.max(1, Number(process.env.TELE_IDLE_MINUTES) || 10) * 60000;
// Telegram's test servers (separate accounts, fixed login codes): only for the automated tests.
const TEST_DC = process.env.TELE_TEST_DC === '1';

/**
 * The account's TDLib client, opened again from its saved session when needed (after a server
 * restart, or after it was closed for being idle). No new login is needed for that.
 */
export async function liveClient(account, { ignoreQuota = false } = {}) {
  if (!ignoreQuota) assertQuota(account);
  const handle = live.get(account.id);
  if (handle?.client) {
    handle.lastUsed = Date.now();
    return handle.client;
  }
  if (account.status !== 'connected') return null;
  if (!opening.has(account.id)) {
    const p = (async () => {
      const cred = apiCredentials();
      if (!cred.ok) throw Object.assign(new Error('TELEGRAM_API_ID و HASH تنظیم نشده'), { statusCode: 503, expose: true });
      const client = await createTdlibClient(account, cred);
      const state = await authState(client).catch(async (e) => {
        await client.close().catch(() => {});
        throw e;
      });
      if (state !== 'authorizationStateReady') {
        // The saved session is no longer valid (logged out from another device, expired…).
        await client.close().catch(() => {});
        run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), account.id);
        throw Object.assign(new Error('نشست تلگرام معتبر نیست؛ دوباره وارد شوید'), { statusCode: 409, expose: true });
      }
      live.set(account.id, { client, phase: 'ready', userId: account.user_id, lastUsed: Date.now() });
      return client;
    })().finally(() => opening.delete(account.id));
    opening.set(account.id, p);
  }
  return opening.get(account.id);
}
export const isLive = (accountId) => !!live.get(Number(accountId))?.client;

setInterval(async () => {
  for (const [id, h] of live) {
    await flushUsage(id);
    // Over the monthly cap: close the connection (an open one keeps receiving updates).
    const account = get('SELECT * FROM tele_accounts WHERE id = ?', id);
    if (account && overQuota(account)) {
      noteOverQuota(account);
      closeLive(id);
      continue;
    }
    // A login left at the code/password step is dropped after half an hour.
    const limit = h.phase === 'ready' ? IDLE_MS : 30 * 60000;
    if (Date.now() - (h.lastUsed || 0) > limit) closeLive(id);
  }
}, Number(process.env.TELE_SWEEP_MS) || 60000).unref();

// ---------- Traffic per account and month, and the monthly cap ----------
const thisMonth = () => new Date().toISOString().slice(0, 7);

/**
 * Adds what the open TDLib client moved since the last count to this month's usage. TDLib counts
 * everything it sends and receives (messages, updates, files), which is the VPN traffic.
 */
function flushUsage(accountId) {
  const h = live.get(Number(accountId));
  if (!h?.client) return Promise.resolve(null);
  // One count at a time per client, so the same bytes are never added twice.
  h.flushing = (h.flushing || Promise.resolve()).then(async () => {
    let s;
    try {
      s = await h.client.invoke({ _: 'getNetworkStatistics', only_current: true });
    } catch {
      return null;
    }
    let sent = 0;
    let received = 0;
    for (const e of s.entries || []) {
      sent += Number(e.sent_bytes) || 0;
      received += Number(e.received_bytes) || 0;
    }
    const base = h.counted || { sent: 0, received: 0 };
    const ds = Math.max(0, sent - base.sent);
    const dr = Math.max(0, received - base.received);
    h.counted = { sent, received };
    if (ds || dr) {
      run(
        `INSERT INTO tele_usage (account_id, month, sent, received) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, month) DO UPDATE SET sent = sent + excluded.sent, received = received + excluded.received`,
        Number(accountId), thisMonth(), ds, dr,
      );
    }
    return { sent, received, since: s.since_date ? s.since_date * 1000 : null };
  });
  return h.flushing;
}

/** Data this account's TDLib client moved since it was opened (null when it is not open). */
export const trafficOf = (accountId) => flushUsage(accountId);

/** This month's traffic of an account, in bytes. */
export function usageOf(accountId, month = thisMonth()) {
  const r = get('SELECT sent, received FROM tele_usage WHERE account_id = ? AND month = ?', Number(accountId), month);
  return { sent: r?.sent || 0, received: r?.received || 0, used: (r?.sent || 0) + (r?.received || 0) };
}
/** The account's monthly cap in MB (its own, else the default); 0 = none. */
export const quotaOf = (account) => Math.max(0, Number(account.quota_mb ?? settingNumber('tele_quota_mb')) || 0);
export const overQuota = (account) => {
  const q = quotaOf(account);
  return q > 0 && usageOf(account.id).used >= q * 1048576;
};
function assertQuota(account) {
  if (!overQuota(account)) return;
  throw Object.assign(new Error(`سقف مصرف ماهانه تلگرام شما (${quotaOf(account)} مگابایت) تمام شده است؛ پیام‌های ذخیره‌شده دیده می‌شوند. برای افزایش سقف به مدیر خبر دهید.`), { statusCode: 429, expose: true, quota: true });
}
// Once per account and month.
function noteOverQuota(account) {
  if (account.quota_alerted === thisMonth()) return;
  run('UPDATE tele_accounts SET quota_alerted = ? WHERE id = ?', thisMonth(), account.id);
  const u = get('SELECT display_name, username FROM users WHERE id = ?', account.user_id);
  teleAlert('quota', `📊 ${u?.display_name || '?'} (@${u?.username || '?'}) به سقف مصرف ماهانه تلگرام (${quotaOf(account)} مگابایت) رسید؛ تلگرامش تا ماه بعد یا افزایش سقف فقط پیام‌های ذخیره‌شده را نشان می‌دهد.`);
}

// ---------- Session encryption ----------
// TDLib keeps each account's session (its login keys) and message cache in a database. It is stored
// encrypted with a key made from TELE_SESSION_KEY (.env, outside the data folder), so a copy of the
// data folder or a backup alone does not give anyone the Telegram accounts. Encryption is local
// only: it adds no network traffic.
let secret = null;
function sessionSecret() {
  if (secret) return secret;
  secret = String(process.env.TELE_SESSION_KEY || '').trim();
  if (!secret) {
    // No key in the environment (e.g. run without docker compose): one kept next to the sessions.
    const file = path.join(SESSIONS_ROOT, '.key');
    try {
      secret = fs.readFileSync(file, 'utf8').trim();
    } catch {
      secret = '';
    }
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(SESSIONS_ROOT, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  return secret;
}
// TDLib takes the key as bytes (base64 in JSON); a different one per account.
const dbKey = (accountId) => crypto.createHash('sha256').update(`${sessionSecret()}:tele-session:${accountId}`).digest('base64');
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // the Telegram session (auth keys): this user only
  return dir;
}
export function getAccountForUser(userId) { return get('SELECT * FROM tele_accounts WHERE user_id = ?', userId); }
export function publicAccount(row) {
  if (!row) return null;
  const s = String(row.phone || '');
  const phone = s.length < 6 ? '***' : s.slice(0, 4) + '***' + s.slice(-2);
  return { id: row.id, phone, tgUserId: row.tg_user_id, displayName: row.display_name, username: row.username, status: row.status, allowShared: !!row.allow_shared, allowMedia: !!row.allow_media, allowVoice: !!row.allow_voice, createdAt: row.created_at, updatedAt: row.updated_at };
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
    live.set(row.id, { client, phase: status === 'connected' ? 'ready' : status, userId, lastUsed: Date.now() });
    run(`UPDATE tele_accounts SET status = ?, updated_at = ? WHERE id = ?`, status, now(), row.id);
    // The saved session was still logged in: no code needed, but keep who the account is.
    if (status === 'connected') return loggedIn(row, live.get(row.id));
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
  await flushUsage(accountId).catch(() => null);
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
    if (Date.now() > until) {
      throw new Error(s === 'authorizationStateWaitTdlibParameters' ? 'نشست تلگرام باز نشد (کلید رمزنگاری نشست، TELE_SESSION_KEY، عوض شده؟)' : 'TDLib آماده نشد');
    }
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
  let state = await authState(handle.client);
  // With two-step verification TDLib asks for the password next instead of failing.
  if (state === 'authorizationStateWaitPassword') {
    handle.phase = 'awaiting_password';
    run(`UPDATE tele_accounts SET status = 'awaiting_password', updated_at = ? WHERE id = ?`, now(), row.id);
    return { status: 'password_required', account: publicAccount(getAccountForUser(userId)) };
  }
  // A number with no Telegram account yet: not created from here (except on the test servers).
  if (state === 'authorizationStateWaitRegistration' && TEST_DC) {
    const name = get('SELECT display_name FROM users WHERE id = ?', userId)?.display_name || 'Test';
    await handle.client.invoke({ _: 'registerUser', first_name: name.slice(0, 64), last_name: '', disable_notification: true });
    state = await authState(handle.client);
  }
  if (state !== 'authorizationStateReady') {
    await closeLive(row.id);
    run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), row.id);
    const msg = state === 'authorizationStateWaitRegistration' ? 'این شماره حساب تلگرام ندارد؛ اول در اپ تلگرام ثبت‌نام کنید' : `ورود کامل نشد (${state})`;
    throw Object.assign(new Error(msg), { statusCode: 400, expose: true });
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
  const state = await authState(handle.client);
  if (state !== 'authorizationStateReady') {
    await closeLive(row.id);
    run(`UPDATE tele_accounts SET status = 'disconnected', updated_at = ? WHERE id = ?`, now(), row.id);
    throw Object.assign(new Error(`ورود کامل نشد (${state})`), { statusCode: 400, expose: true });
  }
  return loggedIn(row, handle);
}
async function loggedIn(row, handle) {
  handle.phase = 'ready';
  handle.lastUsed = Date.now();
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
  // Closed for being idle: open it once more, so the session is also ended on Telegram's side.
  const client = live.get(row.id)?.client || (row.status === 'connected' ? await liveClient(row, { ignoreQuota: true }).catch(() => null) : null);
  if (client) { try { await client.invoke({ _: 'logOut' }); } catch {} }
  await closeLive(row.id);
  run(`UPDATE tele_accounts SET status = 'disconnected', session_dir = '', tg_user_id = NULL, display_name = '', username = '', db_encrypted = 0 WHERE id = ?`, row.id);
  run('DELETE FROM tele_dialogs WHERE account_id = ?', row.id);
  try { if (row.session_dir?.startsWith(SESSIONS_ROOT)) fs.rmSync(row.session_dir, { recursive: true, force: true }); } catch {}
  return { ok: true };
}
async function createTdlibClient(row, cred) {
  const tdl = await import('tdl');
  try { const { getTdjson } = await import('prebuilt-tdlib'); tdl.configure({ tdjson: getTdjson() }); } catch {}
  const socks = await ensureEgress();
  const dir = row.session_dir || sessionDir(row.id);
  // Encrypted already, or a session from before encryption (opened without a key, then encrypted).
  const encrypted = !!row.db_encrypted && fs.existsSync(path.join(dir, 'db', 'td.binlog'));
  // tdl 8 connects in createClient (there is no connect()) and answers setTdlibParameters itself.
  const client = tdl.createClient({
    apiId: cred.apiId, apiHash: cred.apiHash, databaseDirectory: path.join(dir, 'db'), filesDirectory: path.join(dir, 'files'),
    databaseEncryptionKey: encrypted ? dbKey(row.id) : '', useTestDc: TEST_DC,
  });
  client.on('error', (e) => console.warn('[tele] tdlib:', e?.message || e));
  client.on('update', (u) => {
    for (const fn of updateHandlers) {
      try {
        fn(row.id, u);
      } catch (e) {
        console.warn('[tele] update handler:', e?.message || e);
      }
    }
  });
  try {
    await authState(client);
    if (!encrypted) {
      await client.invoke({ _: 'setDatabaseEncryptionKey', new_encryption_key: dbKey(row.id) });
      run('UPDATE tele_accounts SET db_encrypted = 1 WHERE id = ?', row.id);
    }
    await useProxy(client, socks);
    await saveData(client);
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}
// Every byte goes through the server's VPN: never download media on its own, don't appear online
// (that keeps the session "active" and brings more updates).
async function saveData(client) {
  const settings = {
    _: 'autoDownloadSettings', is_auto_download_enabled: false, max_photo_file_size: 0, max_video_file_size: 0, max_other_file_size: 0,
    video_upload_bitrate: 0, preload_large_videos: false, preload_next_audio: false, preload_stories: false, use_less_data_for_calls: true,
  };
  for (const type of ['networkTypeMobile', 'networkTypeWiFi', 'networkTypeOther']) {
    await client.invoke({ _: 'setAutoDownloadSettings', settings, type: { _: type } }).catch(() => {});
  }
  await client.invoke({ _: 'setOption', name: 'online', value: { _: 'optionValueBoolean', value: false } }).catch(() => {});
}
// Fail closed: without the local SOCKS proxy TDLib would reach Telegram directly, so a failure here
// aborts the login. Newer TDLib takes addProxy(proxy, enable, comment), older addProxy(server, port, enable, type).
async function useProxy(client, socks) {
  const type = { _: 'proxyTypeSocks5', username: '', password: '' };
  // The session database keeps proxies: reuse ours instead of adding a copy on every open, and
  // drop any other proxy so TDLib can never pick one that bypasses the tunnel.
  try {
    const { proxies = [] } = await client.invoke({ _: 'getProxies' });
    let ours = null;
    for (const p of proxies) {
      const pr = p.proxy || p;
      if (!ours && pr.server === socks.host && pr.port === socks.port && pr.type?._ === 'proxyTypeSocks5') ours = p;
      else await client.invoke({ _: 'removeProxy', proxy_id: p.id }).catch(() => {});
    }
    if (ours) {
      await client.invoke({ _: 'enableProxy', proxy_id: ours.id });
      return;
    }
  } catch {
    /* older TDLib: just add it below */
  }
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
