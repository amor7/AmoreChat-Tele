// Lite mode rules (web/src/appearance-rules.js).
// Usage: node --test server/test/appearance-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LITE_MODES, WALLPAPERS, TEXT_SIZES, liteEnabled, validWallpaper, validTextSize, barColor } from '../../web/src/appearance-rules.js';

const strong = { deviceMemory: 8, hardwareConcurrency: 8, connection: { saveData: false } };

test('lite choices and their Persian labels', () => {
  assert.deepEqual(LITE_MODES, [
    ['auto', 'خودکار'],
    ['on', 'روشن'],
    ['off', 'خاموش'],
  ]);
});

test('on and off ignore the device', () => {
  for (const nav of [strong, { deviceMemory: 1, hardwareConcurrency: 1, connection: { saveData: true } }, {}, null, undefined]) {
    assert.equal(liteEnabled('on', nav), true);
    assert.equal(liteEnabled('off', nav), false);
  }
});

test('auto turns on for data saver, little memory or few cores', () => {
  assert.equal(liteEnabled('auto', strong), false);
  assert.equal(liteEnabled('auto', { ...strong, connection: { saveData: true } }), true);
  assert.equal(liteEnabled('auto', { ...strong, deviceMemory: 2 }), true);
  assert.equal(liteEnabled('auto', { ...strong, deviceMemory: 0.5 }), true);
  assert.equal(liteEnabled('auto', { ...strong, deviceMemory: 3 }), false);
  assert.equal(liteEnabled('auto', { ...strong, hardwareConcurrency: 2 }), true);
  assert.equal(liteEnabled('auto', { ...strong, hardwareConcurrency: 1 }), true);
  assert.equal(liteEnabled('auto', { ...strong, hardwareConcurrency: 4 }), false);
  assert.equal(liteEnabled('auto', { connection: { saveData: false }, deviceMemory: 1 }), true);
  // Boundaries: only 2 GB / 2 cores or less count as weak.
  assert.equal(liteEnabled('auto', { ...strong, deviceMemory: 2.01 }), false);
  assert.equal(liteEnabled('auto', { ...strong, hardwareConcurrency: 3 }), false);
});

test('auto stays off when the browser reports nothing (old WebViews)', () => {
  assert.equal(liteEnabled('auto', {}), false);
  assert.equal(liteEnabled('auto', null), false);
  assert.equal(liteEnabled('auto', undefined), false);
  assert.equal(liteEnabled('auto', { connection: {} }), false);
  assert.equal(liteEnabled('auto', { deviceMemory: 0, hardwareConcurrency: 0 }), false);
});

test('a missing or unknown pref means auto', () => {
  const weak = { deviceMemory: 1 };
  for (const pref of [undefined, null, '', 'maybe']) {
    assert.equal(liteEnabled(pref, weak), true);
    assert.equal(liteEnabled(pref, strong), false);
  }
});

test('wallpaper and text size fall back to defaults when the saved value is unknown', () => {
  for (const [k] of WALLPAPERS) assert.equal(validWallpaper(k), k);
  for (const v of [undefined, null, '', 'stars', 'DOTS', 3]) assert.equal(validWallpaper(v), 'dots');
  for (const [k] of TEXT_SIZES) {
    assert.equal(validTextSize(k), Number(k));
    assert.equal(validTextSize(Number(k)), Number(k));
  }
  for (const v of [undefined, null, '', 0, 16, 99, 'big', NaN]) assert.equal(validTextSize(v), 15);
});

test('system bar color is always #RRGGBB (Android Color.parseColor)', () => {
  assert.equal(barColor('#121729', true), '#121729');
  assert.equal(barColor(' #FFFFFF ', false), '#FFFFFF');
  assert.equal(barColor('#000', true), '#121729');
  assert.equal(barColor('rgb(0 0 0)', false), '#ffffff');
  assert.equal(barColor('', true), '#121729');
  assert.equal(barColor(undefined, false), '#ffffff');
});
