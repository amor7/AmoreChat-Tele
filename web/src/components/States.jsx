// Shared "nothing here", "something went wrong" and "loading" views, so every list and pane
// says it the same way. Copy stays with the caller; these only set the shape.

/**
 * Nothing to show yet. Fills its pane (`.empty-pane`); `compact` for inside a list.
 * `icon` and `action` are elements (an <Icon/>, a <button>).
 */
export function EmptyState({ icon, title, hint, action, compact = false, className = '' }) {
  return (
    <div className={`${compact ? 'empty-state compact' : 'empty-pane'} ${className}`.trim()}>
      {icon}
      {title && (compact ? <b className="empty-title">{title}</b> : <h2>{title}</h2>)}
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

/** A failed load, announced at once (role="alert"), with a retry button when `onRetry` is given. */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="error-state" role="alert">
      <p>{message || 'بارگذاری نشد.'}</p>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          تلاش دوباره
        </button>
      )}
    </div>
  );
}

// Varied widths read as text rather than a grid of bars.
const WIDTHS = [92, 76, 84, 60, 70];

// Screen readers hear one short sentence; the grey blocks themselves are hidden from them.
function Loading() {
  return (
    <span className="sr-only" role="status">
      در حال بارگذاری…
    </span>
  );
}

/**
 * Placeholder text lines while something loads. `announce={false}` for all but one of several
 * skeletons on screen, so a screen reader hears "loading" once.
 */
export function Skeleton({ lines = 3, announce = true }) {
  return (
    <div className="skeleton">
      {announce && <Loading />}
      <div aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="skeleton-line" style={{ width: `${WIDTHS[i % WIDTHS.length]}%` }} />
        ))}
      </div>
    </div>
  );
}

/** Placeholder rows of a list (chat list, dialogs), optionally with a round avatar. */
export function SkeletonList({ rows = 5, avatar = false, announce = true }) {
  return (
    <div className="skeleton skeleton-list">
      {announce && <Loading />}
      <div aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-row">
            {avatar && <span className="skeleton-avatar" />}
            <span className="skeleton-text">
              <span className="skeleton-line" style={{ width: `${WIDTHS[i % WIDTHS.length] - 30}%` }} />
              <span className="skeleton-line" style={{ width: `${WIDTHS[(i + 2) % WIDTHS.length]}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A short "working on it" line (joining a channel, fetching chats), announced politely. */
export function BusyState({ text, compact = false }) {
  return (
    <div className={compact ? 'empty-state compact' : 'empty-pane'} role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

/** Placeholder message bubbles while a chat's history loads for the first time. */
export function SkeletonMessages({ rows = 6, announce = true }) {
  return (
    <div className="skeleton skeleton-messages">
      {announce && <Loading />}
      <div aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={`skeleton-bubble ${i % 3 === 1 ? 'mine' : ''}`}>
            <span className="skeleton-line" style={{ width: `${WIDTHS[i % WIDTHS.length]}%` }} />
            {i % 2 === 0 && <span className="skeleton-line" style={{ width: `${WIDTHS[(i + 3) % WIDTHS.length] - 25}%` }} />}
          </div>
        ))}
      </div>
    </div>
  );
}
