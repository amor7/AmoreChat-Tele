// Chat drafts kept on the device (web/src/drafts.js). Usage: node --test server/test/drafts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, loadDraft, saveDraft, clearDraft, listDrafts, clearAllDrafts, clearDrafts, draftSaver, DRAFT_MAX } from '../../web/src/drafts.js';

// The parts of localStorage the module uses.
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

const throwing = () => {
  throw new Error('QuotaExceededError');
};
const brokenStorage = { length: 1, key: throwing, getItem: throwing, setItem: throwing, removeItem: throwing };

test('key format', () => {
  assert.equal(draftKey(7, 'chat', 42), 'amore.draft.u7:chat:42');
  assert.equal(draftKey(7, 'tele', 9), 'amore.draft.u7:tele:9');
});

test('save, load and users kept apart', () => {
  const s = fakeStorage();
  assert.equal(loadDraft(1, 'chat', 5, s), '');
  assert.equal(saveDraft(1, 'chat', 5, 'سلام', s), true);
  assert.equal(loadDraft(1, 'chat', 5, s), 'سلام');
  assert.equal(loadDraft(2, 'chat', 5, s), '', 'another user on the same device sees nothing');
  assert.equal(loadDraft(1, 'tele', 5, s), '', 'a Telegram dialog with the same id is separate');
});

test('whitespace-only text removes the draft', () => {
  const s = fakeStorage();
  saveDraft(1, 'chat', 5, 'hello', s);
  saveDraft(1, 'chat', 5, '  \n\t ', s);
  assert.equal(s.map.has(draftKey(1, 'chat', 5)), false);
  saveDraft(1, 'chat', 6, 'x', s);
  clearDraft(1, 'chat', 6, s);
  assert.equal(s.map.size, 0);
});

test('length is capped', () => {
  const s = fakeStorage();
  saveDraft(1, 'chat', 5, 'a'.repeat(DRAFT_MAX + 500), s);
  assert.equal(loadDraft(1, 'chat', 5, s).length, DRAFT_MAX);
});

test('listDrafts: one user, one kind', () => {
  const s = fakeStorage({ 'amorechat:folder': '3' });
  saveDraft(1, 'chat', 5, 'five', s);
  saveDraft(1, 'chat', 6, 'six', s);
  saveDraft(1, 'tele', 5, 'tele five', s);
  saveDraft(2, 'chat', 5, 'other user', s);
  assert.deepEqual(listDrafts(1, 'chat', s), { 5: 'five', 6: 'six' });
  assert.deepEqual(listDrafts(1, 'tele', s), { 5: 'tele five' });
  assert.deepEqual(listDrafts(3, 'chat', s), {});
});

test('clearAllDrafts removes only amore.draft.* keys', () => {
  const s = fakeStorage({ 'amorechat:folder': '3', 'amore.theme': 'dark' });
  saveDraft(1, 'chat', 5, 'a', s);
  saveDraft(2, 'tele', 9, 'b', s);
  clearAllDrafts(s);
  assert.deepEqual([...s.map.keys()].sort(), ['amore.theme', 'amorechat:folder']);
});

test('storage errors are silent', () => {
  assert.equal(loadDraft(1, 'chat', 5, brokenStorage), '');
  assert.equal(saveDraft(1, 'chat', 5, 'x', brokenStorage), false);
  assert.deepEqual(listDrafts(1, 'chat', brokenStorage), {});
  assert.doesNotThrow(() => clearAllDrafts(brokenStorage));
  // Quota full only on write: reading still works, the write just doesn't happen.
  const full = { ...fakeStorage(), setItem: throwing };
  assert.equal(saveDraft(1, 'chat', 5, 'x', full), false);
});

test('saver writes after the pause, flush writes at once, cancel drops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = fakeStorage();
  const saver = draftSaver(1, 'chat', 5, { delay: 500, storage: s });
  saver.set('a');
  saver.set('ab');
  t.mock.timers.tick(499);
  assert.equal(loadDraft(1, 'chat', 5, s), '', 'nothing written while typing');
  t.mock.timers.tick(1);
  assert.equal(loadDraft(1, 'chat', 5, s), 'ab');

  saver.set('abc');
  saver.flush();
  assert.equal(loadDraft(1, 'chat', 5, s), 'abc', 'flush (page hidden / closed) writes now');
  t.mock.timers.tick(1000);
  assert.equal(loadDraft(1, 'chat', 5, s), 'abc');

  saver.set('');
  saver.cancel();
  t.mock.timers.tick(1000);
  saver.flush();
  assert.equal(loadDraft(1, 'chat', 5, s), 'abc', 'a cancelled save never happens');
});

test('clearDrafts removes only one user and one kind of drafts', () => {
  const s = fakeStorage({ other: 'keep' });
  saveDraft(1, 'tele', 5, 'secret', s);
  saveDraft(1, 'tele', 6, 'secret 2', s);
  saveDraft(1, 'chat', 5, 'mine', s);
  saveDraft(2, 'tele', 5, 'someone else', s);
  clearDrafts(1, 'tele', s);
  assert.deepEqual(listDrafts(1, 'tele', s), {});
  assert.deepEqual(listDrafts(1, 'chat', s), { 5: 'mine' });
  assert.deepEqual(listDrafts(2, 'tele', s), { 5: 'someone else' });
  assert.equal(s.getItem('other'), 'keep');
  assert.doesNotThrow(() => clearDrafts(1, 'tele', brokenStorage));
});
