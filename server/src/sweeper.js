import { get, all, run, now } from './db.js';
import { settingNumber } from './settings.js';
import { purgeFile } from './media.js';
import { toChat } from './realtime.js';
import { loadMessage } from './chats.js';

// A file can be shared by several messages (forwards) and used as an avatar;
// only delete it from disk once nothing visible points at it anymore.
export function purgeIfOrphan(fileId) {
  if (!fileId) return;
  const used = get(
    `SELECT 1 AS x WHERE
       EXISTS (SELECT 1 FROM messages WHERE file_id = ?1 AND deleted = 0)
       OR EXISTS (SELECT 1 FROM users WHERE avatar_file_id = ?1)
       OR EXISTS (SELECT 1 FROM chats WHERE avatar_file_id = ?1)`,
    fileId,
  );
  if (!used) purgeFile(fileId);
}

export function deleteMessage(m) {
  run("UPDATE messages SET deleted = 1, text = '', pinned = 0 WHERE id = ?", m.id);
  run('DELETE FROM reactions WHERE message_id = ?', m.id);
  purgeIfOrphan(m.file_id);
  toChat(m.chat_id, 'message:delete', { id: m.id, chatId: m.chat_id });
}

function sweepExpired() {
  for (const m of all('SELECT id, chat_id, file_id FROM messages WHERE expires_at <= ? AND deleted = 0 LIMIT 500', now())) {
    deleteMessage(m);
  }
}

function sweepOldMedia() {
  const days = settingNumber('media_retention_days');
  if (!days) return;
  const cutoff = now() - days * 86400000;
  const old = all(
    `SELECT f.id FROM files f
     WHERE f.purged = 0 AND f.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM users WHERE avatar_file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM chats WHERE avatar_file_id = f.id)
     LIMIT 500`,
    cutoff,
  );
  for (const { id } of old) {
    if (!purgeFile(id)) continue;
    for (const m of all('SELECT id, chat_id FROM messages WHERE file_id = ? AND deleted = 0', id)) {
      toChat(m.chat_id, 'message:edit', loadMessage(m.id));
    }
  }
}

export function startSweeper(log) {
  const interval = Number(process.env.SWEEP_MS) || 30_000;
  let ticks = 0;
  setInterval(() => {
    try {
      sweepExpired();
      // Media retention is cheap but not urgent: check roughly hourly.
      if (ticks++ % Math.max(1, Math.round(3600_000 / interval)) === 0) sweepOldMedia();
    } catch (e) {
      log.error(e, 'sweeper failed');
    }
  }, interval).unref();
}
