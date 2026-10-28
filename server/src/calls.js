import crypto from 'node:crypto';
import { get, now } from './db.js';
import { toUser } from './realtime.js';
import { deleteRoom } from './livekit.js';
import { getOrCreateDm, postMessage } from './chats.js';
import { onParticipantLeft } from './voice.js';
import { pushTo } from './push.js';

// One-to-one calls. Signaling (ring / accept / end) goes over Socket.IO;
// the media itself flows through a private LiveKit room per call.
const RING_TIMEOUT = 45_000;
const calls = new Map(); // id -> call
const byUser = new Map(); // userId -> callId

export const callRoom = (id) => `call-${id}`;
export const getCall = (id) => calls.get(id);
export const userCall = (userId) => calls.get(byUser.get(userId));
export const listCalls = () => [...calls.values()].map(publicCall);

function publicCall(c) {
  const name = (id) => get('SELECT display_name, avatar_file_id FROM users WHERE id = ?', id);
  const a = name(c.callerId);
  const b = name(c.calleeId);
  return {
    id: c.id,
    video: c.video,
    state: c.state,
    createdAt: c.createdAt,
    answeredAt: c.answeredAt,
    caller: { id: c.callerId, displayName: a?.display_name, avatar: a?.avatar_file_id },
    callee: { id: c.calleeId, displayName: b?.display_name, avatar: b?.avatar_file_id },
  };
}

export function startCall(callerId, calleeId, video) {
  const call = {
    id: crypto.randomBytes(8).toString('hex'),
    callerId,
    calleeId,
    video: !!video,
    state: 'ringing',
    createdAt: now(),
    answeredAt: null,
  };
  call.timer = setTimeout(() => endCall(call.id, 'missed'), RING_TIMEOUT);
  calls.set(call.id, call);
  byUser.set(callerId, call.id);
  byUser.set(calleeId, call.id);
  const info = publicCall(call);
  toUser(calleeId, 'call:incoming', info);
  // The Android app rings even when it is closed.
  pushTo([calleeId], { type: 'call', callId: call.id, name: info.caller.displayName, video: call.video });
  return call;
}

export function acceptCall(call) {
  clearTimeout(call.timer);
  call.state = 'active';
  call.answeredAt = now();
  const info = publicCall(call);
  toUser(call.callerId, 'call:accepted', info);
  // Stops the ringing on the callee's other devices.
  toUser(call.calleeId, 'call:handled', info);
  pushTo([call.calleeId], { type: 'call_end', callId: call.id });
}

// reason: missed | declined | cancelled | ended | busy
export function endCall(id, reason) {
  const call = calls.get(id);
  if (!call) return;
  clearTimeout(call.timer);
  calls.delete(id);
  if (byUser.get(call.callerId) === id) byUser.delete(call.callerId);
  if (byUser.get(call.calleeId) === id) byUser.delete(call.calleeId);
  const status = call.state === 'active' ? 'ended' : reason;
  const duration = call.answeredAt ? Math.round((now() - call.answeredAt) / 1000) : 0;
  for (const uid of [call.callerId, call.calleeId]) toUser(uid, 'call:ended', { id, reason: status });
  pushTo([call.calleeId], { type: 'call_end', callId: id });
  deleteRoom(callRoom(id));
  // A log entry in the DM, like other messengers show.
  const dm = getOrCreateDm(call.callerId, call.calleeId);
  postMessage({ chatId: dm, senderId: call.callerId, type: 'call', text: JSON.stringify({ video: call.video, status, duration }) });
}

// Closing the tab or losing the connection mid-call ends it for both sides.
onParticipantLeft((room, userId) => {
  if (!room.startsWith('call-')) return;
  const call = calls.get(room.slice(5));
  if (call && call.state === 'active' && (userId === call.callerId || userId === call.calleeId)) endCall(call.id, 'ended');
});
