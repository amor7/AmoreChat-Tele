import { useStore } from '../store';
import { THEMES, MODES, TEXT_SIZES, WALLPAPERS, applyAppearance } from '../appearance';

// Profile section: theme, light/dark, message text size, chat wallpaper (saved on this device).
export default function Appearance() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const change = (patch) => {
    setPrefs(patch);
    applyAppearance({ ...prefs, ...patch });
  };
  const theme = THEMES.find((t) => t.id === prefs.theme) || THEMES[0];

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
      <h5>اندازه متن پیام‌ها</h5>
      <div className="segmented">
        {TEXT_SIZES.map(([k, label]) => (
          <button key={k} className={String(prefs.textSize || 15) === k ? 'active' : ''} onClick={() => change({ textSize: Number(k) })}>
            {label}
          </button>
        ))}
      </div>
      <div className="text-preview">سلام! این یک پیام نمونه است 👋</div>
      <h5>پس‌زمینه گفتگو</h5>
      <div className="wall-grid">
        {WALLPAPERS.map(([k, label]) => (
          <button key={k} className={`wall-swatch ${k} ${(prefs.wallpaper || 'dots') === k ? 'active' : ''}`} onClick={() => change({ wallpaper: k })}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}
