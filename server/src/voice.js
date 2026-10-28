import { get, all, parseJSON } from './db.js';
import { toAll, toChat, toUser, toChatExcept } from './realtime.js';
import { hasSitePerm, hasChatPerm } from './perms.js';
import { rtcEnabled, listRooms, listParticipants, userIdOf, removeParticipant } from './livekit.js';

// Who is in which LiveKit room, kept current from webhooks (and a periodic resync).
// roomName -> Map(userId -> { userId, name, avatar, joinedAt, camera, screen })
const rooms = new Map();
const listeners = [];
export const onParticipantLeft = (fn) => listeners.push(fn);

export const chatRoom = (chatId) => `chat-${chatId}`;
export const chatIdOfRoom = (room) => (/^chat-\d+$/.test(room || '') ? Number(room.slice(5)) : null);

export function roomParticipants(room) {
  return [...(rooms.get(room)?.values() || [])];
}

// ---------- "Stage" voice chats (channels always, groups when enabled) ----------
// Admins start the voice chat and speak; everyone else listens, raises a hand and
// speaks once an admin allows it. Kept in memory: it lives as long as the room does.
export const isStage = (chat) => !!chat && (chat.type === 'channel' || (chat.type === 'group' && !!chat.voice_stage));
const listenersHidden = (chat) => chat.type === 'channel' || !!chat.hide_members;

export function isStageAdmin(user, chat, member) {
  // A channel's voice chat is run by the channel's own admins (site admins are not members).
  if (chat.type !== 'channel' && hasSitePerm(user, 'manage_chats')) return true;
  if (!member) return false;
  if (chat.is_emergency) return member.role === 'owner' || hasSitePerm(user, 'broadcast');
  if (member.role === 'owner') return true;
  return member.role === 'admin' && (hasChatPerm(user, member, 'mute_members') || hasChatPerm(user, member, 'post_messages'));
}

const stages = new Map(); // room -> { speakers: Set, hands: Map(userId -> raisedAt), bans: Set }
export function stageOf(room) {
  let s = stages.get(room);
  if (!s) stages.set(room, (s = { speakers: new Set(), hands: new Map(), bans: new Set() }));
  return s;
}
export const endStage = (room) => stages.delete(room);

function stageAdminIds(chat) {
  return all("SELECT cm.user_id, cm.role, cm.perms, u.role AS site_role, u.admin_perms FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? AND (cm.role != 'member' OR u.role != 'user')", chat.id)
    .filter((r) => isStageAdmin({ role: r.site_role, admin_perms: r.admin_perms }, chat, { role: r.role, perms: r.perms }))
    .map((r) => r.user_id);
}

// Who may speak right now in a stage room.
export function stageSpeaker(chat, userId) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  const member = get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', chat.id, userId);
  return isStageAdmin(user, chat, member) || stageOf(chatRoom(chat.id)).speakers.has(userId);
}

export const stageAdminsOf = (chat) => stageAdminIds(chat);

// Public voice channels are visible to everyone; other rooms only to chat members.
// Stage rooms: admins get the full picture (listeners, raised hands); in channels (and groups
// with a hidden member list) everyone else only sees the speakers and a listener count.
function broadcast(room) {
  const chatId = chatIdOfRoom(room);
  if (!chatId) return;
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!chat) return;
  const participants = roomParticipants(room);
  if (!isStage(chat)) {
    const payload = { chatId, participants };
    if (chat.type === 'voice' && chat.is_public) toAll('voice:state', payload);
    else toChat(chatId, 'voice:state', payload);
    return;
  }
  const stage = stageOf(room);
  const marked = participants.map((p) => ({ ...p, speaker: stageSpeaker(chat, p.userId), hand: stage.hands.has(p.userId) }));
  const admins = stageAdminIds(chat);
  const full = { chatId, stage: true, participants: marked, hands: [...stage.hands.keys()] };
  for (const id of admins) toUser(id, 'voice:state', full);
  const pub = listenersHidden(chat)
    ? { chatId, stage: true, participants: marked.filter((p) => p.speaker).map((p) => ({ ...p, hand: false })), listeners: marked.filter((p) => !p.speaker).length, hands: [] }
    : { ...full, hands: [] };
  toChatExcept(chatId, admins, 'voice:state', pub);
}
export const broadcastRoom = broadcast;

// What one user may see of a room (initial load / reconnect).
export function roomStateFor(user, chatId) {
  const room = chatRoom(chatId);
  const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
  const participants = roomParticipants(room);
  if (!chat || !isStage(chat)) return { chatId, participants };
  const stage = stageOf(room);
  const marked = participants.map((p) => ({ ...p, speaker: stageSpeaker(chat, p.userId), hand: stage.hands.has(p.userId) }));
  const member = get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, user.id);
  if (isStageAdmin(user, chat, member)) return { chatId, stage: true, participants: marked, hands: [...stage.hands.keys()] };
  if (!listenersHidden(chat)) return { chatId, stage: true, participants: marked, hands: [] };
  return { chatId, stage: true, participants: marked.filter((p) => p.speaker || p.userId === user.id), listeners: marked.filter((p) => !p.speaker).length, hands: [] };
}

function fromParticipant(p) {
  const userId = userIdOf(p.identity);
  if (!userId) return null;
  const meta = parseJSON(p.metadata || '{}', {});
  const tracks = p.tracks || [];
  return {
    userId,
    name: p.name || '',
    avatar: meta.avatar || null,
    joinedAt: Number(p.joined_at ?? p.joinedAt ?? 0) * 1000 || Date.now(),
    camera: tracks.some((t) => String(t.source) === 'CAMERA' && !t.muted),
    screen: tracks.some((t) => String(t.source) === 'SCREEN_SHARE' && !t.muted),
  };
}

export function applyWebhook(evt) {
  const room = evt.room?.name;
  if (!room) return;
  const p = evt.participant ? fromParticipant(evt.participant) : null;
  switch (evt.event) {
    case 'participant_joined':
      if (!p) return;
      if (!rooms.has(room)) rooms.set(room, new Map());
      rooms.get(room).set(p.userId, p);
      break;
    case 'participant_left':
      if (!p) return;
      rooms.get(room)?.delete(p.userId);
      stages.get(room)?.hands.delete(p.userId);
      if (!rooms.get(room)?.size) {
        rooms.delete(room);
        stages.delete(room); // the voice chat is over: permissions and bans reset
      }
      for (const fn of listeners) fn(room, p.userId);
      break;
    case 'track_published':
    case 'track_unpublished': {
      const entry = p && rooms.get(room)?.get(p.userId);
      if (!entry) return;
      const on = evt.event === 'track_published';
      const source = String(evt.track?.source);
      if (source === 'CAMERA') entry.camera = on;
      if (source === 'SCREEN_SHARE') entry.screen = on;
      break;
    }
    case 'room_finished':
      rooms.delete(room);
      stages.delete(room);
      break;
    default:
      return;
  }
  broadcast(room);
}

// Rebuild state from LiveKit itself: covers server restarts and missed webhooks.
export async function syncRooms(log) {
  if (!rtcEnabled) return;
  try {
    const live = await listRooms();
    const seen = new Set();
    for (const r of live) {
      seen.add(r.name);
      const map = new Map();
      for (const p of await listParticipants(r.name)) {
        const entry = fromParticipant(p);
        if (entry) map.set(entry.userId, entry);
      }
      const before = JSON.stringify(roomParticipants(r.name));
      if (map.size) rooms.set(r.name, map);
      else rooms.delete(r.name);
      if (before !== JSON.stringify(roomParticipants(r.name))) broadcast(r.name);
    }
    for (const name of [...rooms.keys()]) {
      if (!seen.has(name)) {
        rooms.delete(name);
        broadcast(name);
      }
    }
  } catch (e) {
    log?.warn(`livekit sync failed: ${e.message}`);
  }
}

export function startVoiceSync(log) {
  if (!rtcEnabled) return;
  syncRooms(log);
  setInterval(() => syncRooms(log), 60_000).unref();
}

// Take someone out of a chat's voice room (removed from the chat, banned…). Tokens can't be
// revoked, so the media server is told directly.
export function kickFromVoice(chatId, userId) {
  const room = chatRoom(chatId);
  if (rooms.get(room)?.has(userId)) removeParticipant(room, userId).catch(() => {});
}
export function kickEverywhere(userId) {
  for (const [room, m] of rooms) if (m.has(userId)) removeParticipant(room, userId).catch(() => {});
}

export const activeRooms = () => [...rooms.entries()].map(([room, m]) => ({ room, participants: [...m.values()] }));
