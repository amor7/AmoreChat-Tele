import { useRef } from 'react';
import { useMenu } from '../a11y';
import { useAnchoredPosition } from '../anchor';

/**
 * A pop-up menu (role="menu") on the shared layer stack: Escape and Back close it, arrow keys
 * move between the items, Tab leaves it (useMenu in a11y.js).
 * - `anchor` {x, y}: a floating menu at that point (long-press / right-click), kept on screen.
 * - `backdrop` (default on): a transparent layer that closes the menu on a tap outside;
 *   `onBackdrop` replaces onClose for that tap (e.g. to ignore the touch that opened it). A
 *   right-click / long-press on it never shows the browser's own menu over ours.
 * Items are <MenuItem>s, direct children, so `.menu > button` styles keep working. A row of
 * other buttons (quick reactions) goes in a role="group" inside: arrows reach it too.
 */
export function Menu({ label, onClose, onBackdrop, anchor, className = 'menu', backdrop = true, back = true, onContextMenu, children }) {
  const ref = useRef(null);
  const menu = useMenu({ onClose, back, ref });
  const pos = useAnchoredPosition(ref, anchor);
  const outside = onBackdrop || onClose;
  return (
    <>
      {backdrop && (
        <div
          className="menu-backdrop"
          onClick={outside}
          onContextMenu={(e) => {
            e.preventDefault();
            onBackdrop?.(e);
          }}
        />
      )}
      <div className={className} style={pos} role="menu" aria-label={label} onContextMenu={onContextMenu} {...menu}>
        {children}
      </div>
    </>
  );
}

/** One action of a <Menu>: a real button, so Enter / Space / tap all work as usual. */
export function MenuItem({ icon, onClick, danger = false, disabled = false, className = '', children, ...rest }) {
  const cls = `${className} ${danger ? 'danger' : ''}`.trim();
  return (
    // tabIndex -1: inside a menu the arrow keys move between items; Tab leaves the menu.
    <button type="button" role="menuitem" tabIndex={-1} className={cls || undefined} onClick={onClick} disabled={disabled} {...rest}>
      {icon}
      {icon && children ? ' ' : null}
      {children}
    </button>
  );
}
