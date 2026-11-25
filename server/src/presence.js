// Online / last seen, like Telegram: each user chooses who sees it — everyone, people they share a
// group / voice channel / private chat with ("contacts"), or nobody. It works both ways: whoever
// hides it from someone doesn't see that person's either. Hidden shows as "recently" (last 3 days)
// or "a long time ago". Profile photos are not part of this: everyone always sees them.
import { get, all, now } from './db.js';
import { isOnline } from './realtime.js';
import { knowsUser, VISIBLE_SHARED } from './lookup.js';

export const LAST_SEEN_MODES = ['everyone', 'contacts', 'nobody'];
const RECENT_MS = 3 * 24 * 3600 * 1000;
const modeOf = (u) => (LAST_SEEN_MODES.includes(u?.last_seen_privacy) ? u.last_seen_privacy : 'everyone');

/** May `viewer` see `target`'s online status? `known`: they share a chat (worked out when needed). */
export function canSeePresence(viewer, target, known) {
  if (!viewer || !target) return false;
  if (viewer.id === target.id) return true;
  const a = modeOf(target);
  const b = modeOf(viewer);
  if (a === 'nobody' || b === 'nobody') return false;
  if (a === 'everyone' && b === 'everyone') return true;
  return known ?? knowsUser(viewer.id, target.id);
}

/** The online fields for `target` as `viewer` may see them (target: a users row). */
export function presenceOf(viewer, target, known) {
  if (canSeePresence(viewer, target, known)) return { online: isOnline(target.id), lastSeen: target.last_seen };
  return { online: false, lastSeen: null, lastSeenHidden: true, recently: (target.last_seen || 0) > now() - RECENT_MS };
}

/** Who gets live online / offline events for this user: people who share a chat with them and may see it. */
export function presenceAudience(userId) {
  const me = get('SELECT id, last_seen_privacy FROM users WHERE id = ?', userId);
  if (!me || modeOf(me) === 'nobody') return [];
  return all(
    `SELECT DISTINCT u.id FROM chat_members a
       JOIN chat_members b ON b.chat_id = a.chat_id AND b.user_id != a.user_id
       JOIN chats c ON c.id = a.chat_id
       JOIN users u ON u.id = b.user_id
     WHERE a.user_id = ? AND (${VISIBLE_SHARED}) AND IFNULL(u.last_seen_privacy, 'everyone') != 'nobody'`,
    userId,
  ).map((r) => r.id);
}
