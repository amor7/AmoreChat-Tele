/**
 * Per-user Telegram account sessions for Tele.
 * Uses TDLib when `tdl` + prebuilt-tdlib are installed and TELEGRAM_API_ID/HASH are set.
 * Until then, login endpoints return clear errors so the UI can guide the admin.
 */
import fs from 'node:fs';
import path from 'node:path';
import { get, all, run, now, DATA_DIR } from '../db.js';
import { ensureEgress, egressStatus } from './egress.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'tele-sessions');

// In-memory clients: accountId → runtime handle
const live = new Map();

function apiCredentials() {
  const apiId = Number(process.env.TELEGRAM_API_ID || 0);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '').trim();
  return { apiId, apiHash, ok: apiId > 0 && apiHash.length >= 16 };
}

export function teleRuntimeInfo() {
  const cred = apiCredentials();
  let tdl = false;
  try {
    require.resolve('tdl');
    tdl = true;
  } catch {
    try {
      // ESM-friendly check
      tdl = !!import.meta.resolve?.('tdl');
    } catch {
      tdl = false;
    }
  }
  return {
    apiConfigured: cred.ok,
    tdlAvailable: tdl,
    egress: egressStatus(),
  };
}

function sessionDir(accountId) {
  const dir = path.join(SESSIONS_ROOT, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAccountForUser(userId) {
  return get('SELECT * FROM tele_accounts WHERE user_id = ?', userId);
}

export function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone ? maskPhone(row.phone) : '',
    tgUserId: row.tg_user_id,
    displayName: row.display_name,
    username: row.username,
    status: row.status,
    allowShared: !!row.allow_shared,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskPhone(p) {
  const s = String(p);
  if (s.length < 6) return '***';
  return s.slice(0, 4) + '***' + s.slice(-2);
}

export function listDialogs(accountId, { selectedOnly = false } = {}) {
  const rows = selectedOnly
    ? all('SELECT * FROM tele_dialogs WHERE account_id = ? AND selected = 1 ORDER BY title', accountId)
    : all('SELECT * FROM tele_dialogs WHERE account_id = ? ORDER BY selected DESC, title', accountId);
  return rows.map((d) => ({
    id: d.id,
    tgChatId: d.tg_chat_id,
    kind: d.kind,
    title: d.title,
    username: d.username,
    selected: !!d.selected,
    lastSyncedMsgId: d.last_synced_msg_id,
  }));
}

export function setDialogSelected(accountId, dialogId, selected) {
  const d = get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', dialogId, accountId);
  if (!d) throw Object.assign(new Error('گفتگو پیدا نشد'), { statusCode: 404 });
  run('UPDATE tele_dialogs SET selected = ?, updated_at = ? WHERE id = ?', selected ? 1 : 0, now(), d.id);
  return listDialogs(accountId);
}

/**
 * Start phone login. Returns { status: 'code_required' | 'ready' | 'password_required', accountId }.
 * Full TDLib wiring is activated when packages + env are present.
 */
export async function beginLogin(userId, phone) {
  const phoneClean = String(phone || '').replace(/\s+/g, '');
  if (!/^\+?\d{8,15}$/.test(phoneClean)) {
    throw Object.assign(new Error('شماره موبایل نامعتبر است'), { statusCode: 400 });
  }

  const cred = apiCredentials();
  if (!cred.ok) {
    throw Object.assign(
      new Error('TELEGRAM_API_ID و TELEGRAM_API_HASH روی سرور تنظیم نشده‌اند'),
      { statusCode: 503 },
    );
  }

  // Fail-closed: require a working egress path before talking to Telegram.
  try {
    await ensureEgress();
  } catch (e) {
    throw Object.assign(new Error(`تونل تلگرام آماده نیست: ${e.message}`), { statusCode: 503 });
  }

  let row = getAccountForUser(userId);
  const t = now();
  if (!row) {
    const r = run(
      `INSERT INTO tele_accounts (user_id, phone, status, session_dir, created_at, updated_at)
       VALUES (?, ?, 'awaiting_code', '', ?, ?)`,
      userId,
      phoneClean,
      t,
      t,
    );
    row = get('SELECT * FROM tele_accounts WHERE id = ?', Number(r.lastInsertRowid));
  } else {
    run(
      `UPDATE tele_accounts SET phone = ?, status = 'awaiting_code', updated_at = ? WHERE id = ?`,
      phoneClean,
      t,
      row.id,
    );
    row = getAccountForUser(userId);
  }

  const dir = sessionDir(row.id);
  run('UPDATE tele_accounts SET session_dir = ? WHERE id = ?', dir, row.id);

  // Try real TDLib if available.
  try {
    const client = await createTdlibClient(row, cred);
    live.set(row.id, { client, phase: 'awaiting_code', userId });
    // TDLib will request code via updates; for interactive flow we also call setAuthenticationPhoneNumber.
    await client.invoke({
      _: 'setAuthenticationPhoneNumber',
      phone_number: phoneClean,
      settings: { _: 'phoneNumberAuthenticationSettings', allow_flash_call: false, is_current_phone_number: false, allow_sms_retriever_api: false },
    });
    return { status: 'code_required', account: publicAccount(getAccountForUser(userId)) };
  } catch (e) {
    // Package missing or binary missing — keep DB state so UI still works once deps land.
    if (/Cannot find module|tdl|prebuilt|libtdjson/i.test(String(e.message))) {
      run(`UPDATE tele_accounts SET status = 'awaiting_code', updated_at = ? WHERE id = ?`, now(), row.id);
      return {
        status: 'code_required',
        account: publicAccount(getAccountForUser(userId)),
        notice:
          'TDLib هنوز روی سرور نصب نشده (npm i tdl prebuilt-tdlib). پس از نصب، همین API کد را از تلگرام می‌گیرد.',
      };
    }
    throw e;
  }
}

export async function submitCode(userId, code) {
  const row = getAccountForUser(userId);
  if (!row) throw Object.assign(new Error('ابتدا شماره را وارد کنید'), { statusCode: 400 });
  const handle = live.get(row.id);
  if (!handle?.client) {
    // Without live client, accept and store pending — real verify needs TDLib.
    run(`UPDATE tele_accounts SET status = 'awaiting_tdlib', updated_at = ? WHERE id = ?`, now(), row.id);
    return {
      status: 'awaiting_tdlib',
      account: publicAccount(getAccountForUser(userId)),
      notice: 'برای تکمیل ورود، tdl و prebuilt-tdlib را نصب و سرور را ری‌استارت کنید.',
    };
  }
  try {
    await handle.client.invoke({ _: 'checkAuthenticationCode', code: String(code).trim() });
    run(`UPDATE tele_accounts SET status = 'connected', updated_at = ? WHERE id = ?`, now(), row.id);
    handle.phase = 'ready';
    return { status: 'ready', account: publicAccount(getAccountForUser(userId)) };
  } catch (e) {
    if (/PASSWORD|password/i.test(String(e.message))) {
      run(`UPDATE tele_accounts SET status = 'awaiting_password', updated_at = ? WHERE id = ?`, now(), row.id);
      return { status: 'password_required', account: publicAccount(getAccountForUser(userId)) };
    }
    throw Object.assign(new Error(e.message || 'کد نامعتبر'), { statusCode: 400 });
  }
}

export async function submitPassword(userId, password) {
  const row = getAccountForUser(userId);
  if (!row) throw Object.assign(new Error('حساب پیدا نشد'), { statusCode: 404 });
  const handle = live.get(row.id);
  if (!handle?.client) {
    throw Object.assign(new Error('نشست TDLib فعال نیست'), { statusCode: 503 });
  }
  await handle.client.invoke({ _: 'checkAuthenticationPassword', password: String(password) });
  run(`UPDATE tele_accounts SET status = 'connected', updated_at = ? WHERE id = ?`, now(), row.id);
  handle.phase = 'ready';
  return { status: 'ready', account: publicAccount(getAccountForUser(userId)) };
}

export async function disconnectAccount(userId) {
  const row = getAccountForUser(userId);
  if (!row) return { ok: true };
  const handle = live.get(row.id);
  if (handle?.client) {
    try {
      await handle.client.invoke({ _: 'logOut' });
      await handle.client.close?.();
    } catch {
      /* ignore */
    }
    live.delete(row.id);
  }
  run(
    `UPDATE tele_accounts SET status = 'disconnected', session_dir = '', tg_user_id = NULL, display_name = '', username = '', updated_at = ? WHERE id = ?`,
    now(),
    row.id,
  );
  run('DELETE FROM tele_dialogs WHERE account_id = ?', row.id);
  // Wipe session files
  try {
    if (row.session_dir && row.session_dir.startsWith(SESSIONS_ROOT)) {
      fs.rmSync(row.session_dir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
  return { ok: true };
}

async function createTdlibClient(row, cred) {
  const tdl = await import('tdl');
  // prebuilt-tdlib optional
  try {
    const { getTdjson } = await import('prebuilt-tdlib');
    tdl.configure({ tdjson: getTdjson() });
  } catch {
    /* use system libtdjson */
  }

  const socks = await ensureEgress();
  const client = tdl.createClient({
    apiId: cred.apiId,
    apiHash: cred.apiHash,
    databaseDirectory: path.join(row.session_dir || sessionDir(row.id), 'db'),
    filesDirectory: path.join(row.session_dir || sessionDir(row.id), 'files'),
  });

  // Force proxy — TDLib proxy type socks5
  client.on('update', async (u) => {
    if (u?._ === 'updateAuthorizationState') {
      /* lifecycle handled by invoke flow */
    }
  });

  await client.connect();
  // Add proxy before auth if API supports it
  try {
    await client.invoke({
      _: 'addProxy',
      server: socks.host,
      port: socks.port,
      enable: true,
      type: { _: 'proxyTypeSocks5' },
    });
  } catch {
    // Older TDLib: set option / use mtproto proxy separately
  }
  return client;
}
