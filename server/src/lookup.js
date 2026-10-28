// Who can find whom: the user list must not be easy to harvest.
// - People you already share a group / voice channel / conversation with ("acquaintances") are
//   found by part of their name, as before.
// - Anyone else only by their exact username (like Telegram).
// - Looking people up (search, opening a profile or a new private chat) has a per-minute budget;
//   going over it is refused and written to the activity log.
// Site admins who manage users are not limited (they see everyone in the admin panel anyway).
import { get, all } from './db.js';
import { hasSitePerm } from './perms.js';
import { fail, audit } from './chats.js';

export const LOOKUPS_PER_MINUTE = 20;
const recent = new Map(); // userId -> { times: number[], flagged: boolean }

export const isUserStaff = (user) => user.role === 'owner' || hasSitePerm(user, 'manage_users');

export function spendLookup(user, what) {
  if (isUserStaff(user)) return;
  const nowMs = Date.now();
  const r = recent.get(user.id) || { times: [], flagged: false };
  r.times = r.times.filter((t) => t > nowMs - 60_000);
  if (r.times.length >= LOOKUPS_PER_MINUTE) {
    if (!r.flagged) audit(user.id, 'lookup.flood', String(user.id), { what, perMinute: r.times.length });
    r.flagged = true;
    recent.set(user.id, r);
    fail(429, 'جستجوی زیادی انجام دادید؛ یک دقیقه دیگر دوباره امتحان کنید');
  }
  if (!r.times.length) r.flagged = false;
  r.times.push(nowMs);
  recent.set(user.id, r);
}

// Chats in which you can see the other members: groups without a hidden member list, voice
// channels, and private chats that have at least one message.
const VISIBLE_SHARED = `
  c.type = 'voice'
  OR (c.type = 'group' AND IFNULL(c.hide_members, 0) = 0)
  OR (c.type = 'dm' AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id))`;

export function searchAcquaintances(userId, like) {
  return all(
    `SELECT DISTINCT u.* FROM users u
       JOIN chat_members them ON them.user_id = u.id
       JOIN chat_members mine ON mine.chat_id = them.chat_id AND mine.user_id = ?
       JOIN chats c ON c.id = mine.chat_id
     WHERE u.banned = 0 AND u.id != ? AND (${VISIBLE_SHARED})
       AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
     ORDER BY u.username LIMIT 20`,
    userId,
    userId,
    like,
    like,
  );
}

/** Do these two people already share a chat (any kind except channels, where members are hidden)? */
export function knowsUser(userId, otherId) {
  return !!get(
    `SELECT 1 FROM chat_members a JOIN chat_members b ON b.chat_id = a.chat_id AND b.user_id = ?
       JOIN chats c ON c.id = a.chat_id
     WHERE a.user_id = ? AND c.type IN ('group', 'voice', 'dm') LIMIT 1`,
    otherId,
    userId,
  );
}
