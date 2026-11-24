// Promise API for the shared dialogs that replace window.confirm / prompt (ConfirmDialog.jsx
// renders them). In-app dialogs instead of the browser's: they follow the theme and RTL, work
// in the Android WebView (which may not show the native ones), and can hide a typed password.
import { useStore } from './store';
import { whenHistorySettled } from './backnav';
import { TELE_LOCK_EVENT, SIGNED_OUT_EVENT } from './api';
import { confirmOptions, promptOptions, copyOptions, enqueueDialog, finishDialog, drainQueue } from './confirm-rules';

export { isolate } from './confirm-rules';

let seq = 0;

function enqueue(item) {
  return new Promise((resolve) => {
    const queue = useStore.getState().confirmQueue;
    useStore.setState({ confirmQueue: enqueueDialog(queue, { ...item, id: ++seq, resolve }) });
  });
}

/**
 * `await confirmDialog({ title, message, confirmLabel, cancelLabel, danger, extra })` → true / false,
 * or `extra.value` when the optional third button `extra: { label, danger, value }` is pressed.
 */
export const confirmDialog = (opts) => enqueue(confirmOptions(opts));

/** `await promptDialog({ title, message, label, defaultValue, type, confirmLabel, required, danger })` → string, or null if cancelled. */
export const promptDialog = (opts) => enqueue(promptOptions(opts));

/** Shows a value to copy (a new password, an invite link) with a «کپی» button. Resolves when closed. */
export const copyDialog = (opts) => enqueue(copyOptions(opts));

/** Answers the dialog `id` (ConfirmDialog.jsx); ignored if it is not the one on screen. */
export function settleDialog(id, value) {
  const queue = useStore.getState().confirmQueue;
  if (queue.current?.id !== id) return;
  const { done, next } = finishDialog(queue);
  useStore.setState({ confirmQueue: next });
  // Answer after the dialog is gone and its Back history entry popped (the timeout lets React
  // unmount it first): a caller that navigates at once (location.hash = ...) would otherwise
  // have that late "back" undo its navigation.
  setTimeout(() => whenHistorySettled().then(() => done.resolve(value)), 0);
}

/**
 * Closes the dialog on screen and every queued one, each answered as if cancelled. For moments
 * when a pending question no longer makes sense: the Telegram section locked, the session ended.
 */
export function cancelAllDialogs() {
  const { cancelled, next } = drainQueue(useStore.getState().confirmQueue);
  if (!cancelled.length) return;
  useStore.setState({ confirmQueue: next });
  for (const { item, value } of cancelled) item.resolve(value);
}

if (typeof window !== 'undefined') {
  window.addEventListener(TELE_LOCK_EVENT, cancelAllDialogs);
  window.addEventListener(SIGNED_OUT_EVENT, cancelAllDialogs);
}
