// Background loops survive their own errors. Usage: node --test server/test/timers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeInterval, setTimerLogger } from '../src/timers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('sync throws and rejections are caught and the loop keeps going', async () => {
  const logs = [];
  const log = (...a) => logs.push(a);
  let n = 0;
  let m = 0;
  const t = safeInterval('sync', 5, () => {
    n++;
    throw new Error('boom');
  }, { log });
  const t2 = safeInterval('async', 5, async () => {
    m++;
    throw new Error('later');
  }, { log });
  await sleep(80);
  clearInterval(t);
  clearInterval(t2);
  assert.ok(n >= 3 && m >= 3, `ran ${n} and ${m} times`);
  // Only the first error of each loop, with the error object (and so its stack).
  assert.equal(logs.length, 2);
  for (const [msg, err] of logs) {
    assert.match(msg, /^\[(sync|async)\] failed$/);
    assert.ok(err instanceof Error && err.stack);
  }
});

test('a non-promise return value and a throwing logger are harmless', async () => {
  let n = 0;
  const t = safeInterval('odd', 5, () => {
    n++;
    if (n % 2) return 42;
    throw new Error('x');
  }, {
    log: () => {
      throw new Error('logger broke');
    },
  });
  const t2 = safeInterval('odd-async', 5, () => Promise.reject(new Error('y')), {
    log: () => {
      throw new Error('logger broke');
    },
  });
  await sleep(40);
  clearInterval(t);
  clearInterval(t2);
  assert.ok(n >= 3);
});

test('logging is throttled to one line per 5 minutes with a count', (ctx) => {
  ctx.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  // Step one interval at a time: a single big tick moves Date to the end before the callbacks run.
  const advance = (ms) => {
    for (let i = 0; i < ms / 1000; i++) ctx.mock.timers.tick(1000);
  };
  const logs = [];
  const t = safeInterval('noisy', 1000, () => {
    throw new Error('again');
  }, { log: (...a) => logs.push(a) });
  advance(1000); // first error: logged in full
  assert.equal(logs.length, 1);
  advance(299_000); // 299 more inside the quiet window
  assert.equal(logs.length, 1);
  advance(1000); // 5 minutes after the first report
  assert.equal(logs.length, 2);
  assert.match(logs[1][0], /^\[noisy\] failed again \(299 more since the last report\): again$/);
  advance(300_000);
  assert.equal(logs.length, 3);
  assert.match(logs[2][0], /\(299 more/);
  clearInterval(t);
});

test('a slow async run is not overlapped by the next tick', async () => {
  let active = 0;
  let maxActive = 0;
  let starts = 0;
  const t = safeInterval('slow', 5, async () => {
    starts++;
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(40);
    active--;
  });
  await sleep(150);
  clearInterval(t);
  assert.equal(maxActive, 1);
  assert.ok(starts >= 2 && starts <= 5, `started ${starts} times`);
});

test('the timer is unref()ed and returned for clearInterval', () => {
  const t = safeInterval('ref', 1000, () => {});
  assert.equal(t.hasRef(), false);
  clearInterval(t);
});

test('setTimerLogger replaces the default logger', async () => {
  const logs = [];
  setTimerLogger((...a) => logs.push(a));
  setTimerLogger('not a function'); // ignored
  const t = safeInterval('default', 5, () => {
    throw new Error('to default');
  });
  await sleep(30);
  clearInterval(t);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[default] failed');
});

test('a run still going after 10 intervals is reported once', async () => {
  const logs = [];
  let release;
  const hung = new Promise((r) => (release = r));
  const t = safeInterval('hung', 5, () => hung, { log: (...a) => logs.push(a) });
  await sleep(150);
  assert.equal(logs.length, 1, 'one report for the whole run');
  assert.match(logs[0][0], /^\[hung\] still running since \d{4}-\d\d-\d\dT/);
  release();
  clearInterval(t);
});
