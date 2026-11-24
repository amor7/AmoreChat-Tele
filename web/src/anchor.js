// Keeps a fixed-position element (a long-press menu, the emoji picker) with its corner at a
// point but inside the screen.
import { useLayoutEffect, useState } from 'react';

/**
 * Position for an element of `ref` at anchor {x, y}, clamped 8px inside the window. Placed again
 * when the element grows (emoji images load, the picker replaces the menu) and when the window
 * resizes or the phone turns. undefined without an anchor.
 */
export function useAnchoredPosition(ref, anchor) {
  const x = anchor?.x;
  const y = anchor?.y;
  const [pos, setPos] = useState(anchor ? { left: x, top: y } : undefined);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
      const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
      // Same place: no new object, so no extra render (ResizeObserver fires often while images load).
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = typeof ResizeObserver !== 'undefined' && ref.current ? new ResizeObserver(place) : null;
    ro?.observe(ref.current);
    window.addEventListener('resize', place);
    window.addEventListener('orientationchange', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('orientationchange', place);
    };
  }, [x, y]); // eslint-disable-line react-hooks/exhaustive-deps
  return pos;
}
