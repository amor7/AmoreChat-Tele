// Pure accessibility rules (no DOM, no imports) so node --test can check them directly.
// The DOM side (focus, keys) lives in a11y.js.

// Everything Tab can land on. Kept to selectors old Android WebViews understand (no :is/:where).
export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const TYPING_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

// Fields that open the on-screen keyboard when focused. A dialog opening by itself must not
// pop the keyboard up over half the screen on a phone, so these only get focus when the
// dialog asks for it (autoFocus) or the user taps them.
export function isTextEntry(tag, type, editable) {
  const t = String(tag || '').toUpperCase();
  if (editable) return true;
  if (t === 'TEXTAREA') return true;
  if (t === 'INPUT') return TYPING_INPUTS.has(String(type || '').toLowerCase());
  return false;
}

// Where Tab / Shift+Tab goes inside a dialog of `count` focusable elements when `index` has
// focus (-1 = focus is outside or on the dialog itself). Wraps at both ends; -1 when there is
// nothing to focus.
export function nextFocusIndex(count, index, shift) {
  if (!(count > 0)) return -1;
  if (!(index >= 0 && index < count)) return shift ? count - 1 : 0;
  return (index + (shift ? -1 : 1) + count) % count;
}

// Open dialogs, oldest first. Only the top one reacts to Escape and traps Tab, so nested
// dialogs (a QR code over a profile, a confirm over a menu) close one at a time.
export function pushLayer(stack, entry) {
  removeLayer(stack, entry);
  stack.push(entry);
  return stack;
}
// Not always the top: a parent can unmount together with (or before) its child dialog.
export function removeLayer(stack, entry) {
  const i = stack.indexOf(entry);
  if (i >= 0) stack.splice(i, 1);
  return stack;
}
export function topLayer(stack) {
  return stack.length ? stack[stack.length - 1] : null;
}

// Keys that press a role="button" element, like a real <button>.
export function isActivationKey(key) {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

// The top layer that is actually on screen. A layer whose component rendered nothing (its ref
// is empty) must not swallow Escape / Tab for the visible dialog under it.
export function topLiveLayer(stack, isLive) {
  for (let i = stack.length - 1; i >= 0; i--) if (isLive(stack[i])) return stack[i];
  return null;
}

// Keys that mean "the user is moving around with the keyboard". Some keydown events have no
// `key` at all (Chrome's autofill fires them), so anything that isn't a string is not one.
export function isKeyboardNavKey(key) {
  if (typeof key !== 'string') return false;
  return key === 'Tab' || key === 'Enter' || key === ' ' || key.startsWith('Arrow');
}

// What arrow keys reach inside a role="menu": its items, plus plain buttons in a role="group"
// row of the menu (the message menu's quick reactions). Disabled buttons can't take focus.
export const MENU_ITEMS = ['[role="menuitem"]:not([disabled])', '[role="group"] button:not([disabled])'].join(', ');

// Where a key moves focus in a vertical menu of `count` items when `index` has focus (-1 = the
// menu itself or outside). Down/Up step and wrap; Home/End jump to the ends. Up and down mean
// the same in RTL, so left/right are not used. null = not a menu key; -1 = nothing to focus.
export function nextMenuIndex(count, index, key) {
  const down = key === 'ArrowDown' || key === 'Down';
  const up = key === 'ArrowUp' || key === 'Up';
  if (!down && !up && key !== 'Home' && key !== 'End') return null;
  if (!(count > 0)) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (!(index >= 0 && index < count)) return down ? 0 : count - 1;
  return (index + (down ? 1 : -1) + count) % count;
}
