// Every request of the Telegram screens in one place (TeleView, TeleChat, TeleMessage, TeleLogin,
// TeleForward, the sidebar entry): the paths, timeouts and poll marks live here, the screens only
// say what they want. Same requests as before this file existed; nothing here changes traffic.
import { api, teleUpload, teleDownload } from './api';

// Marks the automatic checks: they must not keep the Telegram passcode lock from timing out
// (the server ignores x-amore-poll requests when it counts use).
export const POLL = { headers: { 'x-amore-poll': '1' } };
const poll = (yes) => (yes ? POLL : undefined);
const q = encodeURIComponent;

// ---------- Account and chat list ----------
export const teleStatus = (isPoll = false) => api('GET', '/tele/status', undefined, poll(isPoll));
/** Asks Telegram for the chat list again (`all`: every chat, while picking chats to add). */
export const refreshDialogs = (all = false, isPoll = false) => api('POST', '/tele/dialogs/refresh', { all }, poll(isPoll));
export const setDialogSelected = (dialogId, selected) => api('PATCH', `/tele/dialogs/${dialogId}`, { selected });
export const disconnectTele = () => api('POST', '/tele/disconnect');
export const leaveDialog = (dialogId) => api('POST', `/tele/dialogs/${dialogId}/leave`);

// ---------- Beyond the user's own chats (accounts an admin allowed) ----------
export const findTelegram = (text) => api('GET', `/tele/find?q=${q(text)}`, undefined, { timeout: 60000 });
export const openTelegramChat = (tgChatId) => api('POST', '/tele/open', { tgChatId }, { timeout: 60000 });
export const joinTelegramChat = (body) => api('POST', '/tele/join', body, { timeout: 60000 });

// ---------- Login ----------
export const loginPhone = (phone) => api('POST', '/tele/login/phone', { phone });
export const loginCode = (code) => api('POST', '/tele/login/code', { code });
export const loginPassword = (password) => api('POST', '/tele/login/password', { password });
export const resendLoginCode = () => api('POST', '/tele/login/resend');

// ---------- Messages ----------
/**
 * A chat's messages: the first load asks Telegram; later checks (`local`) read what TDLib already
 * received (no network traffic) and are polls; `before` pages back in history.
 */
export function chatMessages(dialogId, { local = false, before = null } = {}) {
  if (before) return api('GET', `/tele/dialogs/${dialogId}/messages?before=${before}`);
  return api('GET', `/tele/dialogs/${dialogId}/messages${local ? '?local=1' : ''}`, undefined, poll(local));
}
export const searchChat = (dialogId, text) => api('GET', `/tele/dialogs/${dialogId}/search?q=${q(text)}`);
export const sendText = (dialogId, text, replyTo) => api('POST', `/tele/dialogs/${dialogId}/messages`, { text, replyTo: replyTo || null });
/** Takes a queued message (not in Telegram yet) back. */
export const cancelQueued = (messageId) => api('DELETE', `/tele/messages/${messageId}`);

/** One upload (photo, voice, file) with progress; `params` go in the query string. */
export function uploadMedia(dialogId, kind, form, params, opts) {
  return teleUpload(`/tele/dialogs/${dialogId}/${kind}?${new URLSearchParams(params)}`, form, opts);
}

const DOWNLOAD_ERROR = { photo: 'دانلود عکس ناموفق بود', voice: 'دانلود پیام صوتی ناموفق بود', file: 'دانلود فایل ناموفق بود' };
/** A message's photo / voice / file as a Blob. `inline`: a video to play in the page. */
export function downloadMedia(messageId, kind, { inline = false, signal, onProgress } = {}) {
  return teleDownload(`/tele/messages/${messageId}/${kind}${inline ? '?inline=1' : ''}`, { signal, onProgress, errorText: DOWNLOAD_ERROR[kind] });
}

// ---------- Between Telegram and the app's chats ----------
export const forwardToChats = (messageId, chatIds) => api('POST', `/tele/messages/${messageId}/forward`, { chatIds }, { timeout: 120000 });
export const forwardToTele = (messageId, dialogIds) => api('POST', '/tele/forward', { messageId, dialogIds }, { timeout: 120000 });

// ---------- The account's other logins ----------
export const teleSessions = () => api('GET', '/tele/sessions');
export const endTeleSession = (id) => api('DELETE', `/tele/sessions/${id}`);
export const endOtherTeleSessions = () => api('POST', '/tele/sessions/end-others', {});
