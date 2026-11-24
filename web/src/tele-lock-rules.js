// Small rules behind the Telegram passcode screens (TelePasscode.jsx).
// No imports on purpose: the unit tests load this file in plain Node.
// The server is the authority on every rule here; these only give an early, friendly answer.

/** Auto-lock choices, in minutes; 0 = only on sign-out or a server restart. */
export const IDLE_CHOICES = [5, 15, 60, 0];
export const PASSCODE_MIN = 4;
export const PASSCODE_MAX = 64;

const FA = '۰۱۲۳۴۵۶۷۸۹';
const AR = '٠١٢٣٤٥٦٧٨٩';
// Latin digits as Persian; util.js has the same (toFa), but this file imports nothing.
const fa = (n) => String(n).replace(/[0-9]/g, (d) => FA[d]);

/** Same shape the server hashes: NFC, Persian/Arabic digits as Latin, nothing trimmed. */
export function normalizePasscode(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[۰-۹٠-٩]/g, (d) => String(FA.includes(d) ? FA.indexOf(d) : AR.indexOf(d)));
}

/** Length in characters (code points), the way the server counts it. */
export const passcodeLength = (s) => [...normalizePasscode(s)].length;

/** A Persian reason the passcode can't be used, or '' when it is fine. */
export function passcodeProblem(s) {
  const n = passcodeLength(s);
  if (n < PASSCODE_MIN) return `رمز تلگرام دست‌کم ${fa(PASSCODE_MIN)} کاراکتر باشد`;
  if (n > PASSCODE_MAX) return `رمز تلگرام حداکثر ${fa(PASSCODE_MAX)} کاراکتر باشد`;
  return '';
}

/** Only digits (Latin, Persian or Arabic): the lock screen can open the number pad for it. */
export const isNumericPasscode = (s) => /^[0-9]+$/.test(normalizePasscode(s));

/** Whole seconds left until `lockedUntil` (ms since epoch); 0 when it has passed or is unknown. */
export function secondsLeft(lockedUntil, now = Date.now()) {
  const t = Number(lockedUntil);
  if (!Number.isFinite(t) || t <= now) return 0;
  return Math.ceil((t - now) / 1000);
}

/** "m:ss" in Latin digits (the UI turns them Persian). */
export function clockText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * When a "too many wrong tries" answer (429) ends, as ms since epoch, or 0 if it doesn't say
 * (the caller then asks GET /tele/passcode). The server sends an absolute `lockedUntil`.
 */
export function lockedUntilFrom(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return 0;
  const t = Number(data.lockedUntil);
  return Number.isFinite(t) && t > now ? t : 0;
}
