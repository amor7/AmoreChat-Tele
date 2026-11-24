// Pure appearance rules (no DOM, no imports) so node --test can check them directly.

export const LITE_MODES = [
  ['auto', 'خودکار'],
  ['on', 'روشن'],
  ['off', 'خاموش'],
];
export const TEXT_SIZES = [
  ['14', 'کوچک'],
  ['15', 'معمولی'],
  ['17', 'بزرگ'],
  ['19', 'خیلی بزرگ'],
];
export const WALLPAPERS = [
  ['plain', 'ساده'],
  ['dots', 'نقطه‌ای'],
  ['grid', 'شطرنجی'],
  ['waves', 'موج'],
  ['glow', 'درخشش'],
];
export const DEFAULT_TEXT_SIZE = 15;
export const DEFAULT_WALLPAPER = 'dots';

// Lite mode turns off blur, big shadows and animations. 'auto' guesses a weak phone or a
// metered connection from what the browser reports; old WebViews report none of these,
// so missing values never switch it on by themselves.
export function liteEnabled(pref, nav) {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  const n = nav || {};
  if (n.connection?.saveData) return true;
  if (n.deviceMemory && n.deviceMemory <= 2) return true;
  if (n.hardwareConcurrency && n.hardwareConcurrency <= 2) return true;
  return false;
}

// Prefs come from localStorage and may be stale or hand-edited: anything unknown falls back
// to the default instead of producing a data-wall / font size no CSS knows about.
export function validWallpaper(value) {
  return WALLPAPERS.some(([k]) => k === value) ? value : DEFAULT_WALLPAPER;
}
export function validTextSize(value) {
  const n = Number(value);
  return TEXT_SIZES.some(([k]) => Number(k) === n) ? n : DEFAULT_TEXT_SIZE;
}

// Color for the browser / Android system bars. Android's Color.parseColor only takes
// #RRGGBB (or #AARRGGBB), so anything else (#000, rgb(), empty) becomes the mode default.
export function barColor(value, dark) {
  const v = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : dark ? '#121729' : '#ffffff';
}
