// Keyboard and screen-reader support for dialogs, sheets and menus, plus a helper for
// clickable non-buttons. Pure rules (selectors, Tab order, the layer stack) are in a11y-rules.js.
//
// Three hooks share one layer stack:
//   useLayer  - stack + Escape + Android/browser Back + focus restore (no trap, no initial focus)
//   useDialog - useLayer + Tab trap + initial focus (spread next to role="dialog" aria-modal)
//   useMenu   - useLayer + arrow keys over [role=menuitem] (spread next to role="menu")
import { useEffect, useRef } from 'react';
import { useBackClose } from './backnav';
import { FOCUSABLE, MENU_ITEMS, isTextEntry, nextFocusIndex, nextMenuIndex, pushLayer, removeLayer, topLiveLayer, isActivationKey, isKeyboardNavKey } from './a11y-rules';

const layers = []; // [{ ref, close, onKey, before }]

// How the user last interacted. A dialog opened by touch or mouse focuses its own panel (no ring,
// nothing pressed by accident); opened from the keyboard, it starts on the first control.
let byKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (isKeyboardNavKey(e.key)) byKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { byKeyboard = false; }, true);
}
/** True when the last interaction was a navigation key (not a tap or click). */
export const openedByKeyboard = () => byKeyboard;

// display:none / collapsed elements can't take focus; skipping them keeps Tab from "vanishing".
function visible(root, selector) {
  return [...root.querySelectorAll(selector)].filter((el) => el.getClientRects().length > 0);
}

function focusRoot(root) {
  if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  root.focus({ preventScroll: true });
}

function focusFirst(root, initialFocus) {
  let target = null;
  if (typeof initialFocus === 'string') target = root.querySelector(initialFocus);
  else if (initialFocus?.current) target = initialFocus.current;
  if (!target) target = root.querySelector('[autofocus]');
  if (!target && !byKeyboard) target = root;
  // Not a typing field: opening a dialog must not pop up the phone keyboard by itself.
  if (!target) target = visible(root, FOCUSABLE).find((el) => !isTextEntry(el.tagName, el.getAttribute('type'), el.isContentEditable));
  if (!target || target === root) focusRoot(root);
  else target.focus({ preventScroll: true });
}

// Opened from the keyboard: the first item, so arrows and Enter work at once. By pointer: the
// menu itself, so nothing looks pressed and a stray Enter does nothing.
function focusMenu(root) {
  const first = byKeyboard && visible(root, '[role="menuitem"]:not([disabled])')[0];
  if (first) first.focus({ preventScroll: true });
  else focusRoot(root);
}

function trapTab(e, root) {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const list = visible(root, FOCUSABLE);
  const next = nextFocusIndex(list.length, list.indexOf(document.activeElement), e.shiftKey);
  e.preventDefault();
  (next >= 0 ? list[next] : root).focus();
}

function menuKeys(e, root, entry) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Tab') {
    // Tab leaves a menu (it is not a trap): close it and let the browser move on from the
    // button that opened it, so Tab / Shift+Tab continue in page order.
    const from = entry.before;
    if (from && from !== document.body && from.isConnected && typeof from.focus === 'function') from.focus({ preventScroll: true });
    entry.close();
    return;
  }
  const items = visible(root, MENU_ITEMS);
  const next = nextMenuIndex(items.length, items.indexOf(document.activeElement), e.key);
  if (next === null) return;
  e.preventDefault();
  if (next >= 0) items[next].focus({ preventScroll: true });
}

// One listener for all layers, in the capture phase on window: it runs before the app's other
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
  top.onKey?.(e, root, top);
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

function useLayerCore({ onClose, open = true, back = true, ref: outerRef, onKey: keys, focus }) {
  const ownRef = useRef(null);
  const ref = outerRef || ownRef;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackClose(open && back, () => closeRef.current?.());
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    const entry = { ref, close: () => closeRef.current?.(), onKey: keys, before };
    pushLayer(layers, entry);
    // React's autoFocus has already run by now; keep it.
    const root = ref.current;
    if (focus && root && !root.contains(document.activeElement)) focus(root);
    return () => {
      removeLayer(layers, entry);
      // Only when focus was lost with the layer: if the close opened something else that took
      // focus (a menu item opening a dialog), leave it there.
      const now = document.activeElement;
      const lost = !now || now === document.body || !now.isConnected;
      if (!lost) return;
      if (before && before !== document.body && before.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
      // The opener is gone (e.g. a menu item that re-rendered): continue at the element marked
      // data-focus-fallback (the message box). Keyboard users only: focusing it after a tap
      // would pop up the phone keyboard.
      else if (byKeyboard) document.querySelector('[data-focus-fallback]')?.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/**
 * A closable layer while mounted (or while `open`): Escape closes only the top-most layer,
 * Android / browser Back closes it (unless `back: false`), and focus goes back where it was.
 * No focus trap and no initial focus: for non-modal panels. Spread the result on the element.
 */
export function useLayer({ onClose, open = true, back = true } = {}) {
  const ref = useLayerCore({ onClose, open, back });
  return { ref };
}

/**
 * Makes an element a modal layer while mounted (or while `open`): useLayer, plus focus moves
 * inside and Tab stays inside. Spread the result on the dialog element next to role="dialog"
 * aria-modal="true". `back: false` is for dialogs whose host already registers Back (Modal
 * inside Modals.jsx). Backdrop clicks stay with the caller.
 */
export function useDialog({ onClose, labelledBy, describedBy, initialFocus, open = true, back = true } = {}) {
  const ref = useLayerCore({ onClose, open, back, onKey: trapTab, focus: (root) => focusFirst(root, initialFocus) });
  const props = { ref, tabIndex: -1 };
  if (labelledBy) props['aria-labelledby'] = labelledBy;
  if (describedBy) props['aria-describedby'] = describedBy;
  return props;
}

/**
 * A role="menu" layer: useLayer, plus ArrowUp/ArrowDown/Home/End move between the items
 * ([role=menuitem], and buttons of a role="group" row inside), Tab / Shift+Tab close it and
 * move on. Enter / Space are the items' own (they are <button>s). Pass `ref` to share an
 * existing ref (for positioning). Use it through <Menu> (components/Menu.jsx).
 */
export function useMenu({ onClose, open = true, back = true, ref } = {}) {
  const menuRef = useLayerCore({ onClose, open, back, ref, onKey: menuKeys, focus: focusMenu });
  return { ref: menuRef, tabIndex: -1 };
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
      // Holding Enter repeats keydown: one press, one action (the outbox row opens a confirm).
      if (e.repeat) return;
      fn(e);
    },
  };
}
