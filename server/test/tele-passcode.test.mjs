// The Telegram passcode rules. Usage: node --test server/test/tele-passcode.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePasscode, passcodeProblem, isIdleExpired, nextFailState, validIdle, MAX_FAILS, FAIL_LOCK_MS } from '../src/tele/passcode-rules.js';

test('Persian and Arabic digits become Latin; NFC; nothing trimmed', () => {
  assert.equal(normalizePasscode('۱۲۳۴'), '1234');
  assert.equal(normalizePasscode('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  assert.equal(normalizePasscode('۰۹ab٥'), '09ab5');
  // e + combining acute → é (one code point)
  assert.equal(normalizePasscode('café'), 'café');
  assert.equal(normalizePasscode(' 12 34 '), ' 12 34 ');
  assert.equal(normalizePasscode(1234), '');
  assert.equal(normalizePasscode(null), '');
});

test('length 4..64 code points', () => {
  assert.ok(passcodeProblem('123'));
  assert.equal(passcodeProblem('1234'), null);
  assert.equal(passcodeProblem('x'.repeat(64)), null);
  assert.ok(passcodeProblem('x'.repeat(65)));
  assert.ok(passcodeProblem(''));
  assert.ok(passcodeProblem(undefined));
  // Four emoji are 8 UTF-16 units but 4 characters.
  assert.equal(passcodeProblem('😀😀😀😀'), null);
  assert.ok(passcodeProblem('😀😀😀'));
  assert.equal(passcodeProblem('😀'.repeat(64)), null);
  assert.ok(passcodeProblem('😀'.repeat(65)));
  assert.equal(passcodeProblem(normalizePasscode('۱۲۳۴')), null);
});

test('idle choices', () => {
  for (const m of [5, 15, 60, 0]) assert.ok(validIdle(m));
  for (const m of [1, 30, -5, '15', null, undefined, 15.5]) assert.ok(!validIdle(m));
});

test('idle expiry with an injected clock', () => {
  const t = 1_000_000_000;
  const entry = { userId: 1, at: t };
  assert.equal(isIdleExpired(entry, 5, t + 5 * 60_000), false);
  assert.equal(isIdleExpired(entry, 5, t + 5 * 60_000 + 1), true);
  assert.equal(isIdleExpired(entry, 15, t + 10 * 60_000), false);
  assert.equal(isIdleExpired(entry, 60, t + 61 * 60_000), true);
  // 0: only logout or a restart locks it.
  assert.equal(isIdleExpired(entry, 0, t + 365 * 24 * 3600_000), false);
  assert.equal(isIdleExpired(null, 0, t), true);
});

test('locked for 15 minutes after 5 wrong tries, then a fresh round', () => {
  const t = 5_000;
  let fails = 0;
  let s;
  for (let i = 1; i < MAX_FAILS; i++) {
    s = nextFailState(fails, t);
    assert.equal(s.fails, i);
    assert.equal(s.lockedUntil, null);
    fails = s.fails;
  }
  s = nextFailState(fails, t);
  assert.equal(MAX_FAILS, 5);
  assert.equal(s.lockedUntil, t + FAIL_LOCK_MS);
  assert.equal(FAIL_LOCK_MS, 15 * 60_000);
  assert.equal(s.fails, 0);
  assert.deepEqual(nextFailState(null, t), { fails: 1, lockedUntil: null });
});
