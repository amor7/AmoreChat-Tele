import { useStore } from '../store';
import { THEMES, MODES, LITE_MODES, TEXT_SIZES, WALLPAPERS, applyAppearance, liteEnabled, validWallpaper, validTextSize } from '../appearance';

// Profile section: theme, light/dark, lite mode, message text size, chat wallpaper (saved on this device).
export default function Appearance() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const change = (patch) => {
    setPrefs(patch);
    applyAppearance({ ...prefs, ...patch });
  };
  const theme = THEMES.find((t) => t.id === prefs.theme) || THEMES[0];
  const lite = prefs.lite || 'auto';

  return (
    <>
      <h4>ظاهر برنامه</h4>
      <div className="theme-grid">
        {THEMES.map((t) => (
          <button key={t.id} className={`theme-swatch ${theme.id === t.id ? 'active' : ''}`} onClick={() => change({ theme: t.id })}>
            <i style={{ background: `linear-gradient(135deg, ${t.colors[0]}, ${t.colors[1]})` }} />
            {t.name}
          </button>
        ))}
      </div>
      {!theme.darkOnly && (
        <div className="segmented">
          {MODES.map(([k, label]) => (
            <button key={k} className={(prefs.mode || 'auto') === k ? 'active' : ''} onClick={() => change({ mode: k })}>
              {label}
            </button>
          ))}
        </div>
      )}
      <h5>حالت سبک</h5>
      <p className="hint">برای گوشی‌های ضعیف: تاری پس‌زمینه، سایه‌ها و حرکت‌ها خاموش می‌شوند تا برنامه روان‌تر شود.</p>
      <div className="segmented">
        {LITE_MODES.map(([k, label]) => (
          <button key={k} className={lite === k ? 'active' : ''} onClick={() => change({ lite: k })}>
            {label}
          </button>
        ))}
      </div>
      {lite === 'auto' && (
        <p className="hint">خودکار: اگر گوشی ضعیف باشد یا صرفه‌جویی داده روشن باشد، روشن می‌شود {liteEnabled('auto', navigator) ? '(الان روشن است).' : '(الان خاموش است).'}</p>
      )}
      <h5>اندازه متن پیام‌ها</h5>
      <div className="segmented">
        {TEXT_SIZES.map(([k, label]) => (
          <button key={k} className={String(validTextSize(prefs.textSize)) === k ? 'active' : ''} onClick={() => change({ textSize: Number(k) })}>
            {label}
          </button>
        ))}
      </div>
      <div className="text-preview">سلام! این یک پیام نمونه است 👋</div>
      <h5>پس‌زمینه گفتگو</h5>
      <div className="wall-grid">
        {WALLPAPERS.map(([k, label]) => (
          <button key={k} className={`wall-swatch ${k} ${validWallpaper(prefs.wallpaper) === k ? 'active' : ''}`} onClick={() => change({ wallpaper: k })}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
