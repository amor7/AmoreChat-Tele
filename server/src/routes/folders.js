import { get, all, run, now, parseJSON } from '../db.js';
import { fail, getMember, chatSummary } from '../chats.js';
import { toUser } from '../realtime.js';

// Pinned chats and chat folders (each user's own; like Telegram).
const MAX_PINNED = 10;
const MAX_FOLDERS = 20;
const FILTERS = ['dms', 'groups', 'channels', 'voice', 'unread'];

const folderOut = (f) => ({
  id: f.id,
  name: f.name,
  emoji: f.emoji,
  position: f.position,
  chatIds: parseJSON(f.chat_ids, []),
  filters: parseJSON(f.filters, []),
});

function clean(b, userId) {
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) fail(400, 'نام پوشه را بنویسید');
  const emoji = String(b.emoji || '').slice(0, 8);
  const filters = Array.isArray(b.filters) ? [...new Set(b.filters.filter((x) => FILTERS.includes(x)))] : [];
  // Only chats the user is actually in.
  const ids = Array.isArray(b.chatIds) ? [...new Set(b.chatIds.map(Number))].slice(0, 500) : [];
  const chatIds = ids.filter((id) => getMember(id, userId));
  if (!filters.length && !chatIds.length) fail(400, 'حداقل یک نوع گفتگو یا یک گفتگو انتخاب کنید');
  return { name, emoji, filters, chatIds };
}

const changed = (userId) => toUser(userId, 'folders:changed', {});

export default async function folderRoutes(app) {
  app.patch('/api/chats/:id/pin', async (req) => {
    const chatId = Number(req.params.id);
    const m = getMember(chatId, req.user.id);
    if (!m) fail(403, 'شما عضو این گفتگو نیستید');
    const pin = req.body?.pinned !== false;
    if (pin && !m.pinned_at) {
      const n = get('SELECT COUNT(*) AS n FROM chat_members WHERE user_id = ? AND pinned_at IS NOT NULL', req.user.id).n;
      if (n >= MAX_PINNED) fail(400, `حداکثر ${MAX_PINNED} گفتگو را می‌توانید سنجاق کنید`);
    }
    run('UPDATE chat_members SET pinned_at = ? WHERE chat_id = ? AND user_id = ?', pin ? m.pinned_at || now() : null, chatId, req.user.id);
    const chat = chatSummary(chatId, req.user.id);
    toUser(req.user.id, 'chat:new', chat);
    return { chat };
  });

  app.get('/api/folders', async (req) => ({
    folders: all('SELECT * FROM chat_folders WHERE user_id = ? ORDER BY position, id', req.user.id).map(folderOut),
  }));

  app.post('/api/folders', async (req) => {
    const n = get('SELECT COUNT(*) AS n FROM chat_folders WHERE user_id = ?', req.user.id).n;
    if (n >= MAX_FOLDERS) fail(400, `حداکثر ${MAX_FOLDERS} پوشه`);
    const f = clean(req.body || {}, req.user.id);
    const r = run(
      'INSERT INTO chat_folders (user_id, name, emoji, position, chat_ids, filters) VALUES (?, ?, ?, ?, ?, ?)',
      req.user.id,
      f.name,
      f.emoji,
      n,
      JSON.stringify(f.chatIds),
      JSON.stringify(f.filters),
    );
    changed(req.user.id);
    return { folder: folderOut(get('SELECT * FROM chat_folders WHERE id = ?', Number(r.lastInsertRowid))) };
  });

  app.patch('/api/folders/:id', async (req) => {
    const f0 = get('SELECT * FROM chat_folders WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    if (!f0) fail(404, 'پوشه پیدا نشد');
    const f = clean({ ...folderOut(f0), ...(req.body || {}) }, req.user.id);
    run('UPDATE chat_folders SET name = ?, emoji = ?, chat_ids = ?, filters = ? WHERE id = ?', f.name, f.emoji, JSON.stringify(f.chatIds), JSON.stringify(f.filters), f0.id);
    changed(req.user.id);
    return { folder: folderOut(get('SELECT * FROM chat_folders WHERE id = ?', f0.id)) };
  });

  app.delete('/api/folders/:id', async (req) => {
    const r = run('DELETE FROM chat_folders WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    if (!r.changes) fail(404, 'پوشه پیدا نشد');
    changed(req.user.id);
    return { ok: true };
  });

  app.put('/api/folders/order', async (req) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    ids.forEach((id, i) => run('UPDATE chat_folders SET position = ? WHERE id = ? AND user_id = ?', i, id, req.user.id));
    changed(req.user.id);
    return { ok: true };
  });

  // "Mark as read" from the chat list.
  app.post('/api/chats/:id/read-all', async (req) => {
    const chatId = Number(req.params.id);
    if (!getMember(chatId, req.user.id)) fail(403, 'شما عضو این گفتگو نیستید');
    const last = get('SELECT MAX(id) AS id FROM messages WHERE chat_id = ?', chatId).id || 0;
    run('UPDATE chat_members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?', last, chatId, req.user.id);
    const chat = chatSummary(chatId, req.user.id);
    toUser(req.user.id, 'chat:new', chat);
    return { chat };
  });
}
