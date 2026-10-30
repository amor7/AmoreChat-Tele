/**
 * Features the admin opens per user: everyone, nobody, only the listed users, or everyone but them.
 * Each list is a table of user ids; what being listed means follows the mode in its setting.
 * The owner always may.
 */
import { get } from './db.js';
import { getSetting } from './settings.js';

export const ACCESS_MODES = ['all', 'none', 'allow', 'deny'];

// setting: the mode; table: the listed users; fallback: the mode when the setting is unset or bad.
export const ACCESS_LISTS = {
  // The Telegram part of the app.
  tele: { setting: 'tele_access', table: 'tele_access', fallback: 'all' },
  // Fetching videos and files of mirrored Telegram channels (once fetched, every member has them).
  mirror_files: { setting: 'mirror_files_access', table: 'mirror_file_access', fallback: 'allow' },
};

export function accessMode(list) {
  const l = ACCESS_LISTS[list];
  const m = getSetting(l.setting);
  return ACCESS_MODES.includes(m) ? m : l.fallback;
}

export function accessAllowed(list, userOrId) {
  const user = typeof userOrId === 'object' && userOrId ? userOrId : get('SELECT id, role FROM users WHERE id = ?', Number(userOrId));
  if (!user) return false;
  if (user.role === 'owner') return true;
  const mode = accessMode(list);
  if (mode === 'all' || mode === 'none') return mode === 'all';
  const listed = !!get(`SELECT 1 FROM ${ACCESS_LISTS[list].table} WHERE user_id = ?`, user.id);
  return mode === 'allow' ? listed : !listed;
}
