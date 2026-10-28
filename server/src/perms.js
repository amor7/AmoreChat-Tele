import { parseJSON } from './db.js';

// Site-wide permissions an owner can grant to admins.
export const SITE_PERMS = [
  'manage_users', // ban/unban, reset passwords
  'manage_invites', // create/revoke signup invites
  'manage_settings', // registration mode, limits
  'manage_chats', // moderate/delete any group or channel
  'view_audit', // read the audit log and server stats
  'broadcast', // post in the emergency announcement channel
  'handle_reports', // review reported messages
];

// Per-chat permissions a chat owner can grant to chat admins.
export const CHAT_PERMS = [
  'edit_info',
  'delete_messages',
  'ban_members',
  'mute_members',
  'add_members',
  'pin_messages',
  'invite_links',
  'post_messages', // channels: who may post
];

export function hasSitePerm(user, perm) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (user.role !== 'admin') return false;
  return parseJSON(user.admin_perms, []).includes(perm);
}

export function hasChatPerm(user, member, perm) {
  if (hasSitePerm(user, 'manage_chats')) return true;
  if (!member) return false;
  if (member.role === 'owner') return true;
  if (member.role !== 'admin') return false;
  return parseJSON(member.perms, []).includes(perm);
}

// Posting in a channel is for the channel itself (owner, or admins given the right), like
// Telegram: site admins can moderate and delete a channel, but not post in it as a member.
export function canPostInChannel(member) {
  if (!member) return false;
  if (member.role === 'owner') return true;
  return member.role === 'admin' && parseJSON(member.perms, []).includes('post_messages');
}

export const cleanPerms = (list, allowed) =>
  Array.isArray(list) ? [...new Set(list.filter((p) => allowed.includes(p)))] : [];
