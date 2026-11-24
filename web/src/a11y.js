// Keyboard and screen-reader support for dialogs, sheets and menus, plus a helper for
// clickable non-buttons. Pure rules (selectors, Tab order, the layer stack) are in a11y-rules.js.
import { useEffect, useRef } from 'react';
import { useBackClose } from './backnav';
import { FOCUSABLE, isTextEntry, nextFocusIndex, pushLayer, removeLayer, topLiveLayer, isActivationKey, isKeyboardNavKey } from './a11y-rules';

const layers = []; // [{ ref, close }]

// How the user last interacted. A dialog opened by touch or mouse focuses its own panel (no ring,
// nothing pressed by accident); opened from the keyboard, it starts on the first control.
let byKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (isKeyboardNavKey(e.key)) byKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { byKeyboard = false; }, true);
}

// display:none / collapsed elements can't take focus; skipping them keeps Tab from "vanishing".
function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

function focusFirst(root, initialFocus) {
  let target = null;
  if (typeof initialFocus === 'string') target = root.querySelector(initialFocus);
  else if (initialFocus?.current) target = initialFocus.current;
  if (!target) target = root.querySelector('[autofocus]');
  if (!target && !byKeyboard) target = root;
  // Not a typing field: opening a dialog must not pop up the phone keyboard by itself.
  if (!target) target = focusables(root).find((el) => !isTextEntry(el.tagName, el.getAttribute('type'), el.isContentEditable));
  if ((target || root) === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  (target || root).focus({ preventScroll: true });
}

// One listener for all dialogs, in the capture phase on window: it runs before the app's other
// key handlers (music shortcuts, composer) and stops Escape there, so one press closes one layer.
function onKey(e) {
  const top = topLiveLayer(layers, (l) => !!l.ref.current);
  const root = top?.ref.current;
  if (!root) return;
  if (e.key === 'Escape' || e.key === 'Esc') {
    if (e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const list = focusables(root);
  const next = nextFocusIndex(list.length, list.indexOf(document.activeElement), e.shiftKey);
  e.preventDefault();
  (next >= 0 ? list[next] : root).focus();
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

/**
 * Makes an element a modal layer while mounted (or while `open`): focus moves inside, Tab stays
 * inside, Escape closes only the top-most layer, and focus goes back where it was on close.
 * Spread the result on the dialog element next to role="dialog" aria-modal="true".
 * Android / browser Back closes it too (backnav.js), unless `back: false`: for dialogs whose
 * host already registers Back (Modal inside Modals.jsx). Backdrop clicks stay with the caller.
 */
export function useDialog({ onClose, labelledBy, initialFocus, open = true, back = true } = {}) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackClose(open && back, () => closeRef.current?.());
  useEffect(() => {
    if (!open) return;
    const entry = { ref, close: () => closeRef.current?.() };
    const before = document.activeElement;
    pushLayer(layers, entry);
    // React's autoFocus has already run by now; keep it.
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) focusFirst(root, initialFocus);
    return () => {
      removeLayer(layers, entry);
      // Only when focus was lost with the dialog: if the close opened something else that took
      // focus (a menu item opening a dialog), leave it there.
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if (!lost) return;
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
      // The opener is gone (e.g. a menu item that re-rendered): the message box is the natural
      // place to continue. Keyboard users only: focusing it after a tap would pop up the phone
      // keyboard.
      else if (byKeyboard) document.querySelector('.composer textarea')?.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const props = { ref, tabIndex: -1 };
  if (labelledBy) props['aria-labelledby'] = labelledBy;
  return props;
}

/**
 * For a clickable element that can't be a <button> (it holds other buttons, or its styling
 * depends on being a div): role, Tab stop, and Enter/Space like a real button. Keys pressed on
 * a child (a button inside) are left to the child.
 */
export function asButton(fn) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget || !isActivationKey(e.key)) return;
      e.preventDefault();
      // Holding Enter repeats keydown: one press, one action (the outbox row opens confirm()).
      if (e.repeat) return;
      fn(e);
    },
  };
}
