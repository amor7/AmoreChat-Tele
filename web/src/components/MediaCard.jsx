import { useEffect, useReducer, useRef } from 'react';
import { CANCELLED } from '../api';
import { asButton } from '../a11y';
import { formatSize } from '../util';
import { MEDIA_IDLE, mediaReducer, mediaPercent, percentText, progressPhase, progressStep } from '../tele-rules';
import { Ring } from './Media';
import { Download, X, AlertCircle, Check } from 'lucide-react';

/**
 * One media download with progress and cancel. `fetchBlob({ signal, onProgress })` does the
 * request (teleApi.downloadMedia); `knownSize` (bytes, from the message) gives a percent even
 * when the server sends no length. start() resolves the Blob, or null when it failed or was
 * cancelled (the state then says why). Leaving the chat cancels a running download.
 */
export function useMediaDownload(fetchBlob, knownSize = 0) {
  const [state, dispatch] = useReducer(mediaReducer, MEDIA_IDLE);
  const ctl = useRef(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const start = async () => {
    if (ctl.current) return null;
    const c = new AbortController();
    ctl.current = c;
    dispatch({ type: 'start', total: knownSize });
    let last = 0;
    const onProgress = (received, total) => {
      // A chunk arrives every few milliseconds: redraw on a real step only.
      if (!progressStep(last, received, total || knownSize)) return;
      last = received;
      dispatch({ type: 'progress', received, total });
    };
    try {
      const blob = await fetchBlob({ signal: c.signal, onProgress });
      dispatch({ type: 'done' });
      return blob;
    } catch (e) {
      dispatch({ type: 'fail', cancelled: e.status === CANCELLED, error: e.message });
      return null;
    } finally {
      ctl.current = null;
    }
  };
  const cancel = () => ctl.current?.abort();
  return { state, start, cancel };
}

// Separator «، »: a middle dot reads like the Persian zero (۰) next to Persian digits.
/** The line under a card's name while it downloads: «۴۲٪، ۱٫۲ مگابایت از ۳ مگابایت». */
// Honest about where it is: nothing yet (the server is still getting it from Telegram, which may
// take a while), a percent, bytes without a known size, or all bytes in but not finished.
export function progressLine(state) {
  const phase = progressPhase(state);
  if (phase === 'fetching') return 'در حال گرفتن از تلگرام…';
  if (phase === 'finishing') return 'در حال پایان…';
  if (phase === 'streaming') return `در حال دانلود… ${formatSize(state.received)}`;
  return `${percentText(state)}، ${formatSize(state.received)} از ${formatSize(state.total)}`;
}

/** The round icon of a card or a photo: download → progress ring with ✕ → ! (failed) → ✓. */
export function MediaIcon({ state, icon, className = '' }) {
  const loading = state.status === 'loading';
  const pct = mediaPercent(state);
  return (
    <span className={`media-card-icon ${loading ? 'active' : ''} ${state.status === 'error' ? 'failed' : ''} ${className}`.trim()} aria-hidden="true">
      {loading && <Ring progress={pct == null ? null : pct / 100} />}
      <span className="dl-icon">{loading ? <X size={16} /> : state.status === 'error' ? <AlertCircle size={18} /> : state.status === 'done' ? <Check size={18} /> : icon || <Download size={18} />}</span>
    </span>
  );
}

/**
 * A Telegram file, video or voice message before it is opened: name, size, and the download's
 * state. The whole card is the button: tap to download, tap again to cancel, tap after a
 * failure to try again. `className` keeps the old hooks (.tele-file, .tele-voice).
 * - `info`: the idle line (size, length); `doneText`: the line once saved.
 */
export function MediaCard({ state, onStart, onCancel, title, info, icon, doneText = 'ذخیره شد', label, className = '' }) {
  const loading = state.status === 'loading';
  const failed = state.status === 'error';
  const action = loading ? onCancel : onStart;
  const what = loading ? 'لغو دانلود' : failed ? 'تلاش دوباره' : label;
  return (
    <div className={`media-card ${className} is-${state.status}`} {...asButton(action)} aria-busy={loading || undefined} title={what}>
      <MediaIcon state={state} icon={icon} />
      <span className="media-card-body">
        {/* bdi, not dir=auto on the line: a Latin name keeps its own order but the line stays
            right-aligned with the size line under it. */}
        {title && (
          <span className="media-card-title">
            <bdi>{title}</bdi>
          </span>
        )}
        <small className="media-card-sub">
          {loading ? (
            <>
              {progressLine(state)} <span className="media-card-hint">— برای لغو بزنید</span>
            </>
          ) : failed ? (
            <>
              <span className="media-card-error">{state.error}</span> <span className="media-card-retry">تلاش دوباره</span>
            </>
          ) : state.status === 'done' ? (
            doneText
          ) : (
            info
          )}
        </small>
      </span>
    </div>
  );
}

/** Saves a Blob URL as a file (never opened in the page). */
export function saveUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
