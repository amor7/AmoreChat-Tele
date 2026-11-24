// Rules behind the Telegram passcode screens (web/src/tele-lock-rules.js).
// Usage: node --test server/test/tele-lock-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_CHOICES, PASSCODE_MIN, PASSCODE_MAX, normalizePasscode, passcodeLength, passcodeProblem, isNumericPasscode, secondsLeft, clockText, lockedUntilFrom } from '../../web/src/tele-lock-rules.js';
import * as server from '../src/tele/passcode-rules.js';

test('idle choices and length limits match the server', () => {
  assert.deepEqual(IDLE_CHOICES, [5, 15, 60, 0]);
  assert.deepEqual(IDLE_CHOICES, server.IDLE_CHOICES);
  assert.equal(PASSCODE_MIN, server.MIN_LEN);
  assert.equal(PASSCODE_MAX, server.MAX_LEN);
});

test('web and server agree on what a passcode is and whether it can be used', () => {
  const inputs = [
    '۱۲۳۴', // Persian digits
    '٤٥٦٧', // Arabic-Indic digits
    '۱۲٣', // mixed, 3
    'cafe\u0301', // NFD: 5 code points, 4 after NFC
    'abe\u0301', // NFD: 4 code points, 3 after NFC
    '😀😀😀', // 3 emoji = 6 UTF-16 units
    '😀😀😀😀',
    '👨‍👩‍👧', // one glyph, 5 code points
    'x'.repeat(3),
    'x'.repeat(4),
    'x'.repeat(64),
    'x'.repeat(65),
    '😀'.repeat(64),
    '😀'.repeat(65),
    ' ab ',
    '',
  ];
  for (const raw of inputs) {
    const label = JSON.stringify(raw.length > 12 ? `${raw.slice(0, 6)}…(${raw.length})` : raw);
    const n = server.normalizePasscode(raw);
    assert.equal(normalizePasscode(raw), n, `normalized form of ${label}`);
    const webOk = passcodeProblem(raw) === '';
    const serverOk = server.passcodeProblem(n) === null;
    assert.equal(webOk, serverOk, `valid or not: ${label}`);
  }
});

test('Persian and Arabic digits count as Latin, nothing is trimmed', () => {
  assert.equal(normalizePasscode('۱۲۳۴'), '1234');
  assert.equal(normalizePasscode('٤٥٦٧'), '4567');
  assert.equal(normalizePasscode(' ab '), ' ab ');
  // NFC: "e" + combining acute is one character.
  assert.equal(passcodeLength('café'), 4);
});

test('length 4..64 in characters', () => {
  assert.match(passcodeProblem('123'), /۴/);
  assert.equal(passcodeProblem('1234'), '');
  assert.equal(passcodeProblem('۱۲۳۴'), '');
  assert.equal(passcodeProblem('x'.repeat(64)), '');
  assert.match(passcodeProblem('x'.repeat(65)), /۶۴/);
  assert.match(passcodeProblem('123'), /دست‌کم ۴/);
  // Emoji are one character each, not two UTF-16 units.
  assert.equal(passcodeProblem('😀😀😀😀'), '');
  assert.notEqual(passcodeProblem(''), '');
  assert.notEqual(passcodeProblem(null), '');
});

test('numeric passcodes open the number pad', () => {
  assert.equal(isNumericPasscode('2580'), true);
  assert.equal(isNumericPasscode('۲۵۸۰'), true);
  assert.equal(isNumericPasscode('25a0'), false);
  assert.equal(isNumericPasscode(''), false);
});

test('time left and its clock text', () => {
  assert.equal(secondsLeft(10_000, 10_000), 0);
  assert.equal(secondsLeft(0, 10_000), 0);
  assert.equal(secondsLeft(null, 10_000), 0);
  assert.equal(secondsLeft(10_001, 10_000), 1);
  assert.equal(secondsLeft(10_000 + 15 * 60_000, 10_000), 900);
  assert.equal(clockText(900), '15:00');
  assert.equal(clockText(61), '1:01');
  assert.equal(clockText(-5), '0:00');
});

test('when a wrong-tries wait ends, from the server answer', () => {
  const now = 1_000_000;
  assert.equal(lockedUntilFrom({ lockedUntil: now + 5000 }, now), now + 5000);
  assert.equal(lockedUntilFrom({ lockedUntil: now - 1 }, now), 0, 'a passed time is no wait');
  assert.equal(lockedUntilFrom({ lockedUntil: null }, now), 0);
  // Only the absolute time counts; anything else means asking GET /tele/passcode.
  assert.equal(lockedUntilFrom({ retryAfterSec: 30 }, now), 0);
  assert.equal(lockedUntilFrom({ error: 'x' }, now), 0);
  assert.equal(lockedUntilFrom(null, now), 0);
});
