// Shared confirm / prompt / copy dialogs: the pure parts (options, the queue, prompt rules).
// No imports, so node --test can check them; confirm.js and ConfirmDialog.jsx use them.

const text = (v) => (v === undefined || v === null ? '' : String(v));

// A user-chosen name (display name, chat title, @handle, server name) inside a Persian sentence:
// wrapped in FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, so a Latin or mixed name can't
// reorder the words around it (a trailing «؟» jumping to the wrong side, "@bob" turning into
// "bob@"). Empty stays empty.
export const FSI = '\u2068';
export const PDI = '\u2069';
export function isolate(name) {
  const s = text(name);
  return s ? FSI + s + PDI : '';
}

// `extra`: an optional third button (e.g. «حذف پیام» next to «دوباره بفرست») whose `value` the
// dialog resolves to. It must be truthy and not `true`, so callers can tell the three answers
// apart: true (confirm), false (closed / cancel), value (extra).
function extraOption(extra) {
  if (!extra || !extra.label) return null;
  const value = extra.value === undefined || extra.value === null || extra.value === false || extra.value === true || extra.value === '' ? 'extra' : extra.value;
  return { label: text(extra.label), danger: !!extra.danger, value };
}

export function confirmOptions({ title, message, confirmLabel, cancelLabel, danger = false, extra } = {}) {
  return {
    kind: 'confirm',
    title: text(title),
    message: text(message),
    confirmLabel: confirmLabel || 'تأیید',
    cancelLabel: cancelLabel || 'انصراف',
    danger: !!danger,
    extra: extraOption(extra),
  };
}

export function promptOptions({ title, message, label, defaultValue, type = 'text', confirmLabel, cancelLabel, required = false, danger = false } = {}) {
  return {
    kind: 'prompt',
    title: text(title),
    message: text(message),
    label: text(label),
    defaultValue: text(defaultValue),
    // Only these two: anything else (email, number...) would change what the caller receives.
    type: type === 'password' ? 'password' : 'text',
    confirmLabel: confirmLabel || 'تأیید',
    cancelLabel: cancelLabel || 'انصراف',
    required: !!required,
    danger: !!danger,
    extra: null,
  };
}

export function copyOptions({ title, message, value, closeLabel } = {}) {
  return { kind: 'copy', title: text(title), message: text(message), value: text(value), closeLabel: closeLabel || 'بستن', danger: false, extra: null };
}

// What a dialog closed without a choice (Cancel, Escape, Back, a tap outside) returns: like
// window.confirm / window.prompt, and never truthy, so `if (await confirmDialog(...))` is safe.
export function cancelValue(kind) {
  if (kind === 'confirm') return false;
  if (kind === 'prompt') return null;
  return undefined;
}

// A required prompt can't be confirmed empty (spaces count as empty).
export function canSubmitPrompt(value, required) {
  return !required || text(value).trim() !== '';
}

// One dialog at a time: later calls wait their turn, in call order.
export function emptyQueue() {
  return { current: null, waiting: [] };
}
export function enqueueDialog(queue, item) {
  const q = queue || emptyQueue();
  return q.current ? { current: q.current, waiting: [...q.waiting, item] } : { current: item, waiting: q.waiting };
}
// The current dialog is answered: it comes out (done) and the next one, if any, shows.
export function finishDialog(queue) {
  const q = queue || emptyQueue();
  return { done: q.current, next: { current: q.waiting[0] || null, waiting: q.waiting.slice(1) } };
}
// Everything on screen or waiting is dropped (Telegram locked, signed out): each item with the
// answer its caller gets, in the order they were asked; the queue is empty afterwards.
export function drainQueue(queue) {
  const q = queue || emptyQueue();
  const items = [q.current, ...q.waiting].filter(Boolean);
  return { cancelled: items.map((item) => ({ item, value: cancelValue(item.kind) })), next: emptyQueue() };
}

// Why a queued message was refused, in words for the user. Server messages are already Persian;
// browser / network errors ("Failed to fetch", "NetworkError…", "Load failed") are not.
export function sendErrorText(error) {
  const s = text(error).trim();
  if (!s) return 'اتصال برقرار نشد';
  return /[؀-ۿ]/.test(s) ? s : 'اتصال برقرار نشد';
}
