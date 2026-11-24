// Which of a Telegram photo's sizes the app downloads. No imports: shared by the download
// (messages.js telePhotoFile) and the message list (publicMessage, which shows its size before
// the tap), so both always mean the same file; tested on its own.

/** The biggest size within `max` bytes (a size of unknown length counts as fitting), or null. */
export function pickPhotoSize(sizes, max) {
  return [...(sizes || [])].sort((a, b) => (b.size || 0) - (a.size || 0)).find((s) => !s.size || s.size <= max) || null;
}
