// The rules of the Telegram passcode, without the database, so they can be unit-tested alone.

export const IDLE_CHOICES = [5, 15, 60, 0];
export const MIN_LEN = 4;
export const MAX_LEN = 64;
export const MAX_FAILS = 5;
export const FAIL_LOCK_MS = 15 * 60 * 1000;

// Persian (U+06F0..) and Arabic-Indic (U+0660..) digits: the same passcode typed on a Persian or
// an English keyboard must match.
const DIGITS = /[۰-۹٠-٩]/g;

/** NFC + Latin digits. No trim: spaces are part of what the user chose. Not a string → ''. */
export function normalizePasscode(p) {
  if (typeof p !== 'string') return '';
  return p.normalize('NFC').replace(DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/** Why this (already normalized) passcode can't be used, or null. Length in code points, not UTF-16 units. */
export function passcodeProblem(p) {
  if (typeof p !== 'string' || !p) return 'رمز تلگرام را وارد کنید';
  const n = [...p].length;
  if (n < MIN_LEN) return `رمز تلگرام باید دست‌کم ${MIN_LEN} نویسه باشد`;
  if (n > MAX_LEN) return `رمز تلگرام حداکثر ${MAX_LEN} نویسه است`;
  return null;
}

export const validIdle = (m) => IDLE_CHOICES.includes(m);

/** An unlocked session not used for idleMin minutes locks again; 0 = only on logout or restart. */
export function isIdleExpired(entry, idleMin, now) {
  if (!entry) return true;
  if (!idleMin) return false;
  return now - entry.at > idleMin * 60 * 1000;
}

/** After one more wrong passcode: the new counter, and until when tries are refused (if now locked). */
export function nextFailState(fails, now) {
  const n = (Number(fails) || 0) + 1;
  // The counter starts over once it locks, so the next round after the wait has 5 tries again.
  if (n >= MAX_FAILS) return { fails: 0, lockedUntil: now + FAIL_LOCK_MS };
  return { fails: n, lockedUntil: null };
}
