// Appearance: color theme, light/dark/auto, lite mode, message text size and chat wallpaper.
// Stored per device (prefs); applied as attributes on <html> that tokens.css / themes.css read.
import { getPrefs } from './util';
import { liteEnabled, validWallpaper, validTextSize, barColor } from './appearance-rules';

export { LITE_MODES, TEXT_SIZES, WALLPAPERS, liteEnabled, validWallpaper, validTextSize } from './appearance-rules';

export const THEMES = [
  { id: 'indigo', name: 'نیلی', colors: ['#6366f1', '#a855f7'] },
  { id: 'ocean', name: 'اقیانوس', colors: ['#0ea5e9', '#2563eb'] },
  { id: 'telegram', name: 'آبی آسمانی', colors: ['#2aabee', '#1d8fd0'] },
  { id: 'emerald', name: 'زمردی', colors: ['#10b981', '#0d9488'] },
  { id: 'sunset', name: 'غروب', colors: ['#f97316', '#ec4899'] },
  { id: 'rose', name: 'گلبهی', colors: ['#f43f5e', '#db2777'] },
  { id: 'violet', name: 'بنفش', colors: ['#8b5cf6', '#d946ef'] },
  { id: 'gold', name: 'طلایی', colors: ['#d97706', '#b45309'] },
  { id: 'graphite', name: 'خاکستری', colors: ['#475569', '#1e293b'] },
  { id: 'amoled', name: 'شب سیاه (AMOLED)', colors: ['#000000', '#6366f1'], darkOnly: true },
];
export const MODES = [
  ['auto', 'خودکار'],
  ['light', 'روشن'],
  ['dark', 'تیره'],
];
const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function applyAppearance(prefs = getPrefs()) {
  const root = document.documentElement;
  const theme = THEMES.find((t) => t.id === prefs.theme) || THEMES[0];
  const mode = theme.darkOnly ? 'dark' : prefs.mode || 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && !!media?.matches);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.dataset.theme = theme.id;
  root.dataset.wall = validWallpaper(prefs.wallpaper);
  if (liteEnabled(prefs.lite || 'auto', typeof navigator !== 'undefined' ? navigator : null)) root.dataset.lite = '';
  else delete root.dataset.lite;
  root.style.setProperty('--msg-size', `${validTextSize(prefs.textSize)}px`);
  // Browser / phone bars follow the theme. index.html has a light and a dark (media) meta for
  // the first paint; from here on both carry the chosen color, so drop the media condition.
  const bar = barColor(getComputedStyle(root).getPropertyValue('--panel'), dark);
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', bar);
    meta.removeAttribute('media');
  }
  try {
    window.AmoreAndroid?.setBars?.(bar, dark);
  } catch {
    /* older app */
  }
}

export function initAppearance() {
  applyAppearance();
  media?.addEventListener?.('change', () => applyAppearance());
}
