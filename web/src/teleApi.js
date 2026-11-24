// Every request of the Telegram screens in one place (TeleView, TeleChat, TeleMessage, TeleLogin,
// TeleForward, the sidebar entry): the paths, timeouts and poll marks live here, the screens only
// say what they want. Same requests as before this file existed; nothing here changes traffic.
// The admin panel's Telegram and VPN pages have their own section at the end.
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

// ---------- Admin panel: the Telegram and VPN pages (TeleAdmin*.jsx) ----------
// Same paths, bodies and timeouts the panel used inline before.

// Tunnel and proxies
export const adminProxies = () => api('GET', '/admin/tele/proxies');
export const addProxy = (body) => api('POST', '/admin/tele/proxies', body);
export const saveTelePolicy = (patch) => api('PATCH', '/admin/tele/policy', patch);
/** One proxy (`id`) or every proxy (`'all'`), tested all the way to Telegram. */
export const probeProxy = (id) => api('POST', id === 'all' ? '/admin/tele/proxies/probe-all' : `/admin/tele/proxies/${id}/probe`, {}, { timeout: 180000 });
export const deleteProxy = (id) => api('DELETE', `/admin/tele/proxies/${id}`);
export const patchProxy = (id, patch) => api('PATCH', `/admin/tele/proxies/${id}`, patch);
export const restartEgress = () => api('POST', '/admin/tele/egress/restart');

// Alerts in the admins' Saved Messages
export const teleAlerts = () => api('GET', '/admin/tele/alerts');
export const saveTeleAlerts = (patch) => api('PATCH', '/admin/tele/alerts', patch);
export const testTeleAlert = () => api('POST', '/admin/tele/alerts/test', {});

// Users: traffic, caps, what each may fetch
export const adminTeleAccounts = () => api('GET', '/admin/tele/accounts');
export const patchTeleAccount = (id, body) => api('PATCH', `/admin/tele/accounts/${id}`, body);
export const teleAccountUsage = (id) => api('GET', `/admin/tele/accounts/${id}/usage`);
export const saveTeleMediaLimits = (maxMb, fileMaxMb) => api('PATCH', '/admin/tele/media', { maxMb, fileMaxMb });
export const saveTeleQuota = (defaultMb) => api('PATCH', '/admin/tele/quota', { defaultMb });
/** Who may use a feature: 'tele' (Telegram itself) or 'mirror-files' (channel videos and files). */
const ACCESS_FEATURES = new Set(['tele', 'mirror-files']);
const accessPath = (feature) => {
  if (!ACCESS_FEATURES.has(feature)) throw new Error(`unknown access feature: ${feature}`);
  return `/admin/access/${feature}`;
};
export const adminAccess = (feature) => api('GET', accessPath(feature));
export const saveAdminAccess = (feature, body) => api('PATCH', accessPath(feature), body);

// Owner: Telegram channels published in the app
export const teleMirrors = () => api('GET', '/admin/tele/mirrors');
/** Channels the owner's account follows (or a public one by @name), live from Telegram. */
export const mirrorChannels = (term) => api('GET', `/admin/tele/mirrors/channels${term ? `?q=${q(term)}` : ''}`, undefined, { timeout: 90000 });
export const addMirror = (body) => api('POST', '/admin/tele/mirrors', body, { timeout: 120000 });
export const runMirrors = () => api('POST', '/admin/tele/mirrors/run', {}, { timeout: 180000 });
export const patchMirror = (id, patch) => api('PATCH', `/admin/tele/mirrors/${id}`, patch);
export const newMirrorInvite = (id) => api('POST', `/admin/tele/mirrors/${id}/invite`);
export const deleteMirror = (id) => api('DELETE', `/admin/tele/mirrors/${id}`);
export const saveMirrorSettings = (minutes) => api('PATCH', '/admin/tele/mirrors-settings', { minutes });
