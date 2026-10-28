// Appearance: color theme, light/dark/auto, message text size and chat wallpaper.
// Stored per device (prefs); applied as attributes on <html> that themes.css reads.
import { getPrefs } from './util';

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

const media = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function applyAppearance(prefs = getPrefs()) {
  const root = document.documentElement;
  const theme = THEMES.find((t) => t.id === prefs.theme) || THEMES[0];
  const mode = theme.darkOnly ? 'dark' : prefs.mode || 'auto';
  const dark = mode === 'dark' || (mode === 'auto' && !!media?.matches);
  root.dataset.mode = dark ? 'dark' : 'light';
  root.dataset.theme = theme.id;
  root.dataset.wall = prefs.wallpaper || 'dots';
  root.style.setProperty('--msg-size', `${prefs.textSize || 15}px`);
  // Browser / phone bars follow the theme.
  const bar = getComputedStyle(root).getPropertyValue('--panel').trim() || (dark ? '#121729' : '#ffffff');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
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
