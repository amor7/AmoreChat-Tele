// Shared confirm / prompt / copy dialogs (web/src/confirm-rules.js): options, the queue, prompt rules.
// Usage: node --test server/test/confirm-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmOptions, promptOptions, copyOptions, cancelValue, canSubmitPrompt, emptyQueue, enqueueDialog, finishDialog, drainQueue, isolate, FSI, PDI, sendErrorText } from '../../web/src/confirm-rules.js';

test('confirm: defaults, and danger with its own verb', () => {
  assert.deepEqual(confirmOptions({ title: 'حذف شود؟' }), { kind: 'confirm', title: 'حذف شود؟', message: '', confirmLabel: 'تأیید', cancelLabel: 'انصراف', danger: false, extra: null });
  const o = confirmOptions({ title: 't', message: 'a\nb', confirmLabel: 'حذف', danger: 1 });
  assert.equal(o.danger, true);
  assert.equal(o.confirmLabel, 'حذف');
  assert.equal(o.message, 'a\nb');
  assert.deepEqual(confirmOptions().title, '');
});

test('prompt: text by default, password only when asked, nothing else', () => {
  const p = promptOptions({ title: 't', label: 'l', defaultValue: 5 });
  assert.equal(p.kind, 'prompt');
  assert.equal(p.type, 'text');
  assert.equal(p.defaultValue, '5');
  assert.equal(p.required, false);
  assert.equal(p.confirmLabel, 'تأیید');
  assert.equal(promptOptions({ type: 'password' }).type, 'password');
  assert.equal(promptOptions({ type: 'email' }).type, 'text');
  assert.equal(promptOptions({ defaultValue: null }).defaultValue, '');
});

test('copy: the value as text, a close label', () => {
  const c = copyOptions({ title: 'رمز جدید', value: 1234 });
  assert.equal(c.kind, 'copy');
  assert.equal(c.value, '1234');
  assert.equal(c.closeLabel, 'بستن');
});

test('closing without confirming returns what window.confirm / prompt did', () => {
  assert.equal(cancelValue('confirm'), false);
  assert.equal(cancelValue('prompt'), null);
  assert.equal(cancelValue('copy'), undefined);
});

test('a required prompt cannot be confirmed empty or blank', () => {
  assert.equal(canSubmitPrompt('', false), true);
  assert.equal(canSubmitPrompt('', true), false);
  assert.equal(canSubmitPrompt('   ', true), false);
  assert.equal(canSubmitPrompt(undefined, true), false);
  assert.equal(canSubmitPrompt(' x ', true), true);
});

test('queue: one dialog at a time, the rest wait in call order', () => {
  let q = emptyQueue();
  q = enqueueDialog(q, 'a');
  assert.deepEqual(q, { current: 'a', waiting: [] });
  q = enqueueDialog(q, 'b');
  q = enqueueDialog(q, 'c');
  assert.deepEqual(q, { current: 'a', waiting: ['b', 'c'] });
  let r = finishDialog(q);
  assert.equal(r.done, 'a');
  assert.deepEqual(r.next, { current: 'b', waiting: ['c'] });
  r = finishDialog(r.next);
  assert.equal(r.done, 'b');
  r = finishDialog(r.next);
  assert.equal(r.done, 'c');
  assert.deepEqual(r.next, emptyQueue());
  // Finishing an empty queue is harmless.
  assert.deepEqual(finishDialog(r.next), { done: null, next: emptyQueue() });
});

test('queue: does not change the state it was given (store updates stay immutable)', () => {
  const q = { current: 'a', waiting: ['b'] };
  enqueueDialog(q, 'c');
  finishDialog(q);
  assert.deepEqual(q, { current: 'a', waiting: ['b'] });
  assert.deepEqual(enqueueDialog(undefined, 'x'), { current: 'x', waiting: [] });
});

test('confirm: an optional third button resolves to its own value, never true / false', () => {
  const o = confirmOptions({ title: 't', extra: { label: 'حذف پیام', danger: true, value: 'delete' } });
  assert.deepEqual(o.extra, { label: 'حذف پیام', danger: true, value: 'delete' });
  // A value that would read like confirm / cancel is replaced, so callers can tell them apart.
  for (const value of [undefined, null, false, true, '']) assert.equal(confirmOptions({ extra: { label: 'x', value } }).extra.value, 'extra', String(value));
  assert.equal(confirmOptions({ extra: { value: 'x' } }).extra, null, 'no label, no button');
});

test('prompt: danger is passed through (red confirm button)', () => {
  assert.equal(promptOptions({ type: 'password', danger: true }).danger, true);
  assert.equal(promptOptions({}).danger, false);
});

test('closing without a choice is never truthy, for every kind', () => {
  for (const kind of ['confirm', 'prompt', 'copy', 'other', undefined]) assert.ok(!cancelValue(kind), String(kind));
});

test('queue: two dialogs asked at once are answered in the order asked', () => {
  const answers = [];
  const a = { kind: 'confirm', resolve: (v) => answers.push(['a', v]) };
  const b = { kind: 'prompt', resolve: (v) => answers.push(['b', v]) };
  let q = enqueueDialog(enqueueDialog(emptyQueue(), a), b);
  let r = finishDialog(q);
  r.done.resolve(true);
  assert.equal(r.next.current, b);
  r = finishDialog(r.next);
  r.done.resolve('text');
  assert.deepEqual(answers, [['a', true], ['b', 'text']]);
  assert.deepEqual(r.next, emptyQueue());
});

test('drain (Telegram locked, signed out): the shown and the queued, each with its cancel value', () => {
  const q = { current: { kind: 'confirm', id: 1 }, waiting: [{ kind: 'prompt', id: 2 }, { kind: 'copy', id: 3 }] };
  const { cancelled, next } = drainQueue(q);
  assert.deepEqual(cancelled.map((c) => [c.item.id, c.value]), [[1, false], [2, null], [3, undefined]]);
  assert.deepEqual(next, emptyQueue());
  assert.deepEqual(drainQueue(emptyQueue()).cancelled, []);
  assert.deepEqual(drainQueue(undefined).cancelled, []);
});

test('isolate: user names sit in FSI … PDI, so Latin names do not reorder the Persian around them', () => {
  assert.equal(FSI, '⁨');
  assert.equal(PDI, '⁩');
  assert.equal(isolate('bob'), '⁨bob⁩');
  assert.equal(isolate('@ali_r'), '⁨@ali_r⁩');
  assert.equal(isolate(42), '⁨42⁩');
  assert.equal(isolate(''), '');
  assert.equal(isolate(null), '');
  assert.equal(isolate(undefined), '');
});

test('send errors: Persian server messages stay, technical / English ones become a plain phrase', () => {
  assert.equal(sendErrorText('شما عضو این گفتگو نیستید'), 'شما عضو این گفتگو نیستید');
  for (const e of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', '', null, undefined, '  ']) assert.equal(sendErrorText(e), 'اتصال برقرار نشد', String(e));
});
