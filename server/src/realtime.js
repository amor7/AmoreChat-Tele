// Thin wrapper around the Socket.IO server so route modules can emit events
// without importing the server instance directly.
import { closeStreams } from './push.js';

let io = null;
export const setIO = (instance) => {
  io = instance;
};

export const toChat = (chatId, event, data) => io?.to(`chat:${chatId}`).emit(event, data);
export const toUser = (userId, event, data) => io?.to(`user:${userId}`).emit(event, data);
export const toAll = (event, data) => io?.emit(event, data);
// Everyone in the chat except the given users (each user's sockets share the `user:<id>` room).
export const toChatExcept = (chatId, userIds, event, data) =>
  io?.to(`chat:${chatId}`).except(userIds.map((id) => `user:${id}`)).emit(event, data);

export const joinChat = (userId, chatId) => io?.in(`user:${userId}`).socketsJoin(`chat:${chatId}`);
export const leaveChat = (userId, chatId) => io?.in(`user:${userId}`).socketsLeave(`chat:${chatId}`);
export const disconnectUser = (userId) => {
  io?.in(`user:${userId}`).disconnectSockets(true);
  closeStreams({ userId });
};
// Each socket joins `session:<id>` so a single logged-out device can be dropped.
export const disconnectSessions = (ids) => {
  ids.forEach((id) => io?.in(`session:${id}`).disconnectSockets(true));
  closeStreams({ sessionIds: ids });
};

// userId -> number of open sockets
export const online = new Map();
export const isOnline = (userId) => (online.get(userId) || 0) > 0;
