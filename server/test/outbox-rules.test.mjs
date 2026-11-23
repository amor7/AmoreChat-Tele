// Offline outbox decisions (web/src/outbox-rules.js). Usage: node --test server/test/outbox-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  failureKind,
  voiceQueueRefusal,
  VOICE_QUEUE_MAX_ITEMS,
  VOICE_QUEUE_MAX_BYTES,
  afterFailure,
  drainOutbox,
  queuedMeanwhile,
  LATER_MAX_TRIES,
  LATER_MIN_MS,
  SERVER_GAVE_UP,
} from '../../web/src/outbox-rules.js';

test('failures that keep the item queued vs. mark it failed', () => {
  assert.equal(failureKind(0), 'offline');
  assert.equal(failureKind(undefined), 'offline');
  assert.equal(failureKind(-1), 'cancelled');
  assert.equal(failureKind(429), 'slow');
  for (const s of [408, 500, 502, 503, 504]) assert.equal(failureKind(s), 'later', String(s));
  for (const s of [400, 403, 404, 409, 413]) assert.equal(failureKind(s), 'refused', String(s));
});

test('voice queue limits: count and total size', () => {
  const voice = (size) => ({ kind: 'voice', size });
  assert.equal(voiceQueueRefusal([], 1000), null);
  assert.equal(voiceQueueRefusal(undefined, 1000), null);
  // Text items don't count.
  assert.equal(voiceQueueRefusal(Array.from({ length: 50 }, () => ({ text: 'x' })), 1000), null);
  assert.match(voiceQueueRefusal(Array.from({ length: VOICE_QUEUE_MAX_ITEMS }, () => voice(10)), 10), /صف/);
  assert.equal(voiceQueueRefusal([voice(VOICE_QUEUE_MAX_BYTES - 100)], 100), null);
  assert.match(voiceQueueRefusal([voice(VOICE_QUEUE_MAX_BYTES - 100)], 101), /مگابایت/);
});

test('5xx for one item: counted, and failed only after enough tries AND enough time', () => {
  const t0 = 1_000_000;
  let item = { tmpId: 'a' };
  // Count the first LATER_MAX_TRIES - 1 answers within a minute: still waiting.
  for (let i = 1; i < LATER_MAX_TRIES; i++) {
    const r = afterFailure(item, 500, t0 + i * 1000);
    assert.equal(r.kind, 'later');
    assert.equal(r.patch.laterTries, i);
    assert.equal(r.patch.laterSince, t0 + 1000, 'first failure time is kept');
    item = { ...item, ...r.patch };
  }
  // Enough tries but too soon (a server restart can take minutes): still waiting.
  const soon = afterFailure(item, 503, t0 + 60_000);
  assert.equal(soon.kind, 'later');
  item = { ...item, ...soon.patch };
  // Enough tries and long enough: failed, with a message telling what to do; counters cleared.
  const late = afterFailure(item, 502, t0 + 1000 + LATER_MIN_MS);
  assert.equal(late.kind, 'refused');
  assert.deepEqual(late.patch, { error: SERVER_GAVE_UP, laterTries: 0, laterSince: null });
  // Long enough but not enough tries: still waiting.
  assert.equal(afterFailure({ laterTries: 1, laterSince: t0 }, 500, t0 + 10 * LATER_MIN_MS).kind, 'later');
});

test('no answer at all, 429, 4xx and cancel are not counted as server failures', () => {
  const item = { laterTries: LATER_MAX_TRIES * 2, laterSince: 1 };
  for (const [s, kind] of [[0, 'offline'], [undefined, 'offline'], [429, 'slow'], [403, 'refused'], [-1, 'cancelled']]) {
    const r = afterFailure(item, s, 10 * LATER_MIN_MS);
    assert.equal(r.kind, kind, String(s));
    assert.equal(r.patch, null, String(s));
  }
});

function fakeQueue(answers) {
  const sent = [];
  const tried = [];
  return {
    sent,
    tried,
    live: () => true,
    send: async (item) => {
      tried.push(item.tmpId);
      const status = answers[item.tmpId];
      if (status !== undefined) throw Object.assign(new Error('x'), { status });
      sent.push(item.tmpId);
    },
    failed: async (item, e) => failureKind(e.status),
  };
}
const q = (tmpId, chatId, extra = {}) => ({ tmpId, chatId, ...extra });

test('a message the server cannot take now holds back only its own chat', async () => {
  const items = [q('a1', 1), q('b1', 2), q('a2', 1), q('b2', 2), q('c1', 3)];
  const f = fakeQueue({ a1: 500 });
  const r = await drainOutbox(items, f);
  assert.deepEqual(f.sent, ['b1', 'b2', 'c1'], 'other chats go on, in order');
  assert.deepEqual(f.tried, ['a1', 'b1', 'b2', 'c1'], 'a2 waits behind a1 (order within the chat)');
  assert.equal(r.stopped, null);
  assert.deepEqual([...r.blocked], [1]);
});

test('no connection or sending too fast stops the whole round', async () => {
  for (const [status, stopped] of [[0, 'offline'], [429, 'slow']]) {
    const f = fakeQueue({ b1: status });
    const r = await drainOutbox([q('a1', 1), q('b1', 2), q('a2', 1)], f);
    assert.deepEqual(f.sent, ['a1'], String(status));
    assert.equal(r.stopped, stopped);
  }
});

test('refused, failed and deleted items are passed over without holding their chat', async () => {
  const f = fakeQueue({ a1: 403 });
  const items = [q('a1', 1), q('a2', 1), q('x', 1, { error: 'old failure' }), q('gone', 1), q('a3', 1)];
  f.live = (item) => item.tmpId !== 'gone';
  const r = await drainOutbox(items, f);
  assert.deepEqual(f.sent, ['a2', 'a3']);
  assert.equal(r.blocked.size, 0);
});

test('items queued during a round: another round only when it could send them', () => {
  const before = [q('a1', 1)];
  assert.equal(queuedMeanwhile(before, before), false);
  assert.equal(queuedMeanwhile(before, [...before, q('b1', 2)]), true);
  assert.equal(queuedMeanwhile(before, [q('b1', 2)]), true, 'a1 was sent meanwhile');
  assert.equal(queuedMeanwhile(before, [...before, q('a2', 1)], new Set([1])), false, 'its chat is held back');
  assert.equal(queuedMeanwhile(before, [...before, q('b1', 2, { error: 'x' })]), false);
});
