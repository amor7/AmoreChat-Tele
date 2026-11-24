// Accessibility rules (web/src/a11y-rules.js): focusable selectors, Tab order, the dialog stack.
// Usage: node --test server/test/a11y-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { FOCUSABLE, isTextEntry, nextFocusIndex, pushLayer, removeLayer, topLayer, isActivationKey, topLiveLayer, isKeyboardNavKey, MENU_ITEMS, nextMenuIndex } from '../../web/src/a11y-rules.js';

test('focusable selectors cover the usual controls and skip disabled / hidden / tabindex=-1', () => {
  const list = FOCUSABLE.split(', ');
  for (const s of ['a[href]', 'button:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])']) assert.ok(list.includes(s), s);
  assert.ok(list.some((s) => s.startsWith('input') && s.includes(':not([type="hidden"])') && s.includes(':not([disabled])')));
  // Old Android WebViews drop a whole selector list they don't understand.
  assert.doesNotMatch(FOCUSABLE, /:is\(|:where\(|:has\(/);
});

test('Tab moves forward and wraps; Shift+Tab moves back and wraps', () => {
  assert.equal(nextFocusIndex(3, 0, false), 1);
  assert.equal(nextFocusIndex(3, 2, false), 0);
  assert.equal(nextFocusIndex(3, 1, true), 0);
  assert.equal(nextFocusIndex(3, 0, true), 2);
  assert.equal(nextFocusIndex(1, 0, false), 0);
  assert.equal(nextFocusIndex(1, 0, true), 0);
});

test('focus outside the dialog enters at the first (Tab) or last (Shift+Tab) element', () => {
  assert.equal(nextFocusIndex(4, -1, false), 0);
  assert.equal(nextFocusIndex(4, -1, true), 3);
  assert.equal(nextFocusIndex(4, 9, false), 0);
});

test('nothing focusable: -1 (the dialog itself keeps focus)', () => {
  assert.equal(nextFocusIndex(0, -1, false), -1);
  assert.equal(nextFocusIndex(0, 0, true), -1);
  assert.equal(nextFocusIndex(undefined, 0, false), -1);
});

test('only the top dialog is "top"; closing it uncovers the one below', () => {
  const stack = [];
  const a = { id: 'a' };
  const b = { id: 'b' };
  assert.equal(topLayer(stack), null);
  pushLayer(stack, a);
  pushLayer(stack, b);
  assert.equal(topLayer(stack), b);
  removeLayer(stack, b);
  assert.equal(topLayer(stack), a);
  removeLayer(stack, a);
  assert.equal(topLayer(stack), null);
});

test('a parent closing before its child leaves the child on top; double push / remove are harmless', () => {
  const stack = [];
  const a = {};
  const b = {};
  pushLayer(stack, a);
  pushLayer(stack, b);
  removeLayer(stack, a);
  assert.deepEqual(stack, [b]);
  removeLayer(stack, a);
  assert.deepEqual(stack, [b]);
  pushLayer(stack, b);
  assert.deepEqual(stack, [b]);
  pushLayer(stack, a);
  pushLayer(stack, b); // re-opened: moves to the top, not duplicated
  assert.deepEqual(stack, [a, b]);
});

test('fields that would pop up the phone keyboard', () => {
  assert.equal(isTextEntry('TEXTAREA'), true);
  assert.equal(isTextEntry('input', ''), true);
  assert.equal(isTextEntry('INPUT', null), true);
  for (const t of ['text', 'search', 'password', 'email', 'number', 'tel', 'url', 'TEXT']) assert.equal(isTextEntry('INPUT', t), true, t);
  for (const t of ['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color']) assert.equal(isTextEntry('INPUT', t), false, t);
  assert.equal(isTextEntry('BUTTON'), false);
  assert.equal(isTextEntry('SELECT'), false);
  assert.equal(isTextEntry('DIV', null, true), true);
});

test('Enter and Space press a role="button"', () => {
  for (const k of ['Enter', ' ', 'Spacebar']) assert.equal(isActivationKey(k), true, k);
  for (const k of ['Escape', 'Tab', 'a', 'ArrowDown', '']) assert.equal(isActivationKey(k), false, k);
});

test('Escape / Tab go to the top layer that is on screen, skipping empty ones above it', () => {
  const a = { live: true };
  const b = { live: false };
  const c = { live: false };
  const isLive = (l) => l.live;
  assert.equal(topLiveLayer([a, b, c], isLive), a);
  assert.equal(topLiveLayer([b, a], isLive), a);
  assert.equal(topLiveLayer([b, c], isLive), null);
  assert.equal(topLiveLayer([], isLive), null);
  const d = { live: true };
  assert.equal(topLiveLayer([a, d], isLive), d);
});

test('keyboard navigation keys; events without a key (autofill) are not', () => {
  for (const k of ['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) assert.equal(isKeyboardNavKey(k), true, k);
  for (const k of [undefined, null, 0, {}, '', 'a', 'Escape', 'Shift', 'Unidentified']) assert.equal(isKeyboardNavKey(k), false, String(k));
});

test('menu: ArrowDown / ArrowUp step and wrap at both ends', () => {
  assert.equal(nextMenuIndex(3, 0, 'ArrowDown'), 1);
  assert.equal(nextMenuIndex(3, 2, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(3, 1, 'ArrowUp'), 0);
  assert.equal(nextMenuIndex(3, 0, 'ArrowUp'), 2);
  assert.equal(nextMenuIndex(1, 0, 'ArrowDown'), 0);
  // Old Edge / IE key names.
  assert.equal(nextMenuIndex(3, 0, 'Down'), 1);
  assert.equal(nextMenuIndex(3, 0, 'Up'), 2);
});

test('menu: from the menu itself (opened by pointer) Down enters at the first item, Up at the last', () => {
  assert.equal(nextMenuIndex(4, -1, 'ArrowDown'), 0);
  assert.equal(nextMenuIndex(4, -1, 'ArrowUp'), 3);
  assert.equal(nextMenuIndex(4, 7, 'ArrowDown'), 0);
});

test('menu: Home / End jump to the ends', () => {
  assert.equal(nextMenuIndex(5, 2, 'Home'), 0);
  assert.equal(nextMenuIndex(5, 2, 'End'), 4);
  assert.equal(nextMenuIndex(5, -1, 'End'), 4);
});

test('menu: other keys are not menu keys (null); an empty menu has nothing to focus (-1)', () => {
  // Left / right are left alone: in RTL they would be ambiguous, and these menus are vertical.
  for (const k of ['ArrowLeft', 'ArrowRight', 'Tab', 'Enter', ' ', 'Escape', 'a', undefined]) assert.equal(nextMenuIndex(3, 0, k), null, String(k));
  assert.equal(nextMenuIndex(0, -1, 'ArrowDown'), -1);
  assert.equal(nextMenuIndex(0, -1, 'Home'), -1);
});

test('menu items: menuitems and buttons of a group row, never disabled ones; old-WebView selectors', () => {
  const list = MENU_ITEMS.split(', ');
  assert.ok(list.includes('[role="menuitem"]:not([disabled])'));
  assert.ok(list.includes('[role="group"] button:not([disabled])'));
  assert.doesNotMatch(MENU_ITEMS, /:is\(|:where\(|:has\(/);
});
