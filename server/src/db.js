import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_FILE = path.join(DATA_DIR, 'amorechat.db');
export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

// Prepared statements are cached by SQL text.
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => Date.now();

// Each entry runs once, in order; PRAGMA user_version tracks progress.
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    admin_perms TEXT NOT NULL DEFAULT '[]',
    bio TEXT NOT NULL DEFAULT '',
    avatar_file_id INTEGER,
    banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE invites (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    created_by INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'file',
    width INTEGER,
    height INTEGER,
    duration REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX files_owner ON files(owner_id);
  CREATE TABLE chats (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    avatar_file_id INTEGER,
    is_public INTEGER NOT NULL DEFAULT 0,
    is_emergency INTEGER NOT NULL DEFAULT 0,
    slow_mode INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    dm_key TEXT UNIQUE,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    perms TEXT NOT NULL DEFAULT '[]',
    muted_until INTEGER,
    last_read INTEGER NOT NULL DEFAULT 0,
    last_post_at INTEGER,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE INDEX chat_members_user ON chat_members(user_id);
  CREATE TABLE chat_bans (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    by_id INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE TABLE chat_invites (
    code TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    created_by INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id INTEGER,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    file_id INTEGER,
    reply_to INTEGER,
    edited_at INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_chat ON messages(chat_id, id);
  CREATE INDEX messages_file ON messages(file_id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
  // v2: media processing, reactions, reports, forwarding, auto-delete, full-text search
  `
  ALTER TABLE files ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
  ALTER TABLE files ADD COLUMN variants TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE files ADD COLUMN thumb TEXT;
  ALTER TABLE files ADD COLUMN waveform TEXT;
  ALTER TABLE files ADD COLUMN purged INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE files ADD COLUMN max_quality TEXT;
  ALTER TABLE messages ADD COLUMN forwarded_from TEXT;
  ALTER TABLE messages ADD COLUMN expires_at INTEGER;
  CREATE INDEX messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
  ALTER TABLE chats ADD COLUMN auto_delete INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    handled_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX reports_status ON reports(status);
  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
  END;
  INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
  `,
  // v3: per-user limit/permission overrides (JSON; missing keys fall back to site defaults)
  `
  ALTER TABLE users ADD COLUMN limits TEXT NOT NULL DEFAULT '{}';
  `,
  // v4: account security (devices, two-step login, lockout), mentions, per-chat mute
  `
  ALTER TABLE sessions ADD COLUMN id TEXT;
  ALTER TABLE sessions ADD COLUMN last_seen INTEGER;
  ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT '';
  UPDATE sessions SET id = substr(token_hash, 1, 16), last_seen = created_at;
  CREATE UNIQUE INDEX sessions_id ON sessions(id);
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until INTEGER;
  ALTER TABLE chat_members ADD COLUMN notify_muted_until INTEGER;
  ALTER TABLE messages ADD COLUMN mentions TEXT;
  `,
  // v5: Telegram-style voice chats ("stage": admins speak, others raise a hand) and hidden member lists
  `
  ALTER TABLE chats ADD COLUMN voice_stage INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chats ADD COLUMN hide_members INTEGER NOT NULL DEFAULT 0;
  `,
  // v6: resumable uploads (chunks are appended to DATA_DIR/partial/<id> until complete)
  `
  CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // v7: server health (one sample a minute) and alerts; chat folders and pinned chats
  `
  CREATE TABLE metrics (
    ts INTEGER PRIMARY KEY,
    cpu REAL, load REAL, mem_used INTEGER, mem_total INTEGER, disk_used INTEGER, disk_total INTEGER,
    net_rx REAL, net_tx REAL, online INTEGER, calls INTEGER, voice INTEGER, media INTEGER, app_mem INTEGER
  );
  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX alerts_open ON alerts(key, resolved_at);
  ALTER TABLE chat_members ADD COLUMN pinned_at INTEGER;
  CREATE TABLE chat_folders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    chat_ids TEXT NOT NULL DEFAULT '[]',
    filters TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX chat_folders_user ON chat_folders(user_id);
  `,
  // v8: Tele — outbound proxy inventory + placeholders for per-user Telegram accounts
  `
  CREATE TABLE tele_proxies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 100,
    group_name TEXT NOT NULL DEFAULT '',
    last_status TEXT NOT NULL DEFAULT 'unknown',
    last_latency_ms INTEGER,
    last_checked_at INTEGER,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tele_proxies_enabled ON tele_proxies(enabled, priority);

  CREATE TABLE tele_accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT NOT NULL DEFAULT '',
    tg_user_id INTEGER,
    display_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'disconnected',
    session_dir TEXT NOT NULL DEFAULT '',
    allow_shared INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id)
  );
  CREATE INDEX tele_accounts_user ON tele_accounts(user_id);

  CREATE TABLE tele_dialogs (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES tele_accounts(id) ON DELETE CASCADE,
    tg_chat_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'private',
    title TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    selected INTEGER NOT NULL DEFAULT 0,
    last_synced_msg_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(account_id, tg_chat_id)
  );
  CREATE INDEX tele_dialogs_selected ON tele_dialogs(account_id, selected);
  `,
  // v9: Tele mirrored messages (bounded history + send/receive bridge)
  `
  CREATE TABLE tele_messages (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES tele_accounts(id) ON DELETE CASCADE,
    dialog_id INTEGER NOT NULL REFERENCES tele_dialogs(id) ON DELETE CASCADE,
    tg_msg_id INTEGER,
    direction TEXT NOT NULL DEFAULT 'in',
    kind TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    media_path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(account_id, dialog_id, tg_msg_id)
  );
  CREATE INDEX tele_messages_dialog ON tele_messages(account_id, dialog_id, id);
  `,
  // v10: Tele messenger view: who sent each message, and the chat list preview / unread count
  `
  ALTER TABLE tele_messages ADD COLUMN sender_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE tele_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE tele_dialogs ADD COLUMN last_text TEXT NOT NULL DEFAULT '';
  ALTER TABLE tele_dialogs ADD COLUMN last_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tele_dialogs ADD COLUMN last_out INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tele_dialogs ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX tele_messages_tg ON tele_messages(account_id, dialog_id, tg_msg_id);
  `,
];

const current = db.prepare('PRAGMA user_version').get().user_version;
for (let v = current; v < migrations.length; v++) {
  tx(() => {
    db.exec(migrations[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  });
}

export const parseJSON = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
