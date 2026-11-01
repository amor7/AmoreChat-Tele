import { get, all, run, now, tx } from '../db.js';
import { USERNAME_RE } from '../auth.js';
import { fail, audit, chatSummary, ensureSavedChat, systemMessage } from '../chats.js';
import { handleTaken } from '../handles.js';
import { spendLookup } from '../lookup.js';

const ownerOnly = (req) => {
  if (req.user.role !== 'owner') fail(403, 'فقط مالک سرور');
};
const listed = (handle) => get('SELECT * FROM reserved_names WHERE handle = ?', String(handle));

export default async function handleRoutes(app) {
  // What @name is: a public chat (its kept Telegram name counts) or a user. Behind links.
  app.get('/api/handles/:name', async (req) => {
    const name = String(req.params.name).replace(/^@/, '');
    spendLookup(req.user, 'discover');
    const c = get(
      `SELECT c.* FROM chats c WHERE c.is_public = 1 AND (c.handle = ?1
         OR EXISTS (SELECT 1 FROM reserved_handles r WHERE r.chat_id = c.id AND r.handle = ?1))`,
      name,
    );
    if (c) {
      const mine = chatSummary(c.id, req.user.id);
      return {
        chat: mine
          ? { ...mine, isMember: true }
          : {
              id: c.id,
              type: c.type,
              title: c.title,
              description: c.description,
              avatar: c.avatar_file_id,
              handle: c.handle,
              memberCount: get('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', c.id).n,
              isMember: false,
            },
      };
    }
    const u = get('SELECT id, username, display_name, avatar_file_id FROM users WHERE username = ? AND banned = 0', name);
    if (!u) fail(404, 'این شناسه پیدا نشد');
    return { user: { id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar_file_id } };
  });

  // --- The owner's list of names kept from everyone ---
  app.get('/api/admin/handles', async (req) => {
    ownerOnly(req);
    const q = String(req.query.q || '').trim().replace(/^@/, '');
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    return {
      total: get('SELECT COUNT(*) AS n FROM reserved_names').n,
      names: all(
        `SELECT r.handle, r.note, EXISTS (SELECT 1 FROM users u WHERE u.username = r.handle) AS inUse
           FROM reserved_names r WHERE r.handle LIKE ? ESCAPE '\\' ORDER BY r.handle LIMIT 1000`,
        like,
      ).map((r) => ({ ...r, inUse: !!r.inUse })),
      // Originals kept for channels copied from Telegram.
      kept: all(
        `SELECT r.handle, c.id AS chatId, c.title, c.handle AS chatHandle FROM reserved_handles r JOIN chats c ON c.id = r.chat_id
          WHERE r.handle LIKE ? ESCAPE '\\' ORDER BY r.handle LIMIT 1000`,
        like,
      ),
    };
  });

  app.post('/api/admin/handles', async (req) => {
    ownerOnly(req);
    const handle = String(req.body?.handle || '').trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(handle)) fail(400, 'شناسه باید ۳ تا ۳۲ حرف انگلیسی، عدد یا _ باشد و با حرف شروع شود');
    if (handleTaken(handle)) fail(409, 'این شناسه قبلاً گرفته شده است');
    run('INSERT INTO reserved_names (handle, note, created_at) VALUES (?, ?, ?)', handle, String(req.body?.note || '').slice(0, 100), now());
    audit(req.user.id, 'handle.reserve', '', { handle });
    return { ok: true };
  });

  // Free for whoever takes it first.
  app.delete('/api/admin/handles/:handle', async (req) => {
    ownerOnly(req);
    if (!listed(req.params.handle)) fail(404, 'این شناسه در لیست نیست');
    run('DELETE FROM reserved_names WHERE handle = ?', String(req.params.handle));
    audit(req.user.id, 'handle.release', '', { handle: req.params.handle });
    return { ok: true };
  });

  // Given to a user: it replaces their username, and the old one is free again.
  app.post('/api/admin/handles/:handle/gift', async (req) => {
    ownerOnly(req);
    const row = listed(req.params.handle);
    if (!row) fail(404, 'این شناسه در لیست نیست');
    const u = get('SELECT * FROM users WHERE username = ?', String(req.body?.username || '').trim().replace(/^@/, ''));
    if (!u) fail(404, 'کاربر پیدا نشد');
    if (get('SELECT 1 AS x FROM users WHERE username = ?', row.handle)) fail(409, 'این شناسه قبلاً گرفته شده است');
    tx(() => {
      run('UPDATE users SET username = ? WHERE id = ?', row.handle, u.id);
      run('DELETE FROM reserved_names WHERE handle = ?', row.handle);
    });
    audit(req.user.id, 'handle.gift', u.id, { handle: row.handle, from: u.username });
    systemMessage(ensureSavedChat(u.id), `🎁 نام کاربری شما به @${row.handle} تغییر کرد. از این پس با همین نام وارد شوید.`);
    return { ok: true, username: row.handle };
  });
}
