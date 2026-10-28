import { useEffect, useState } from 'react';

// Fill the box (cover) only when the video's shape is close to the box's shape.
// A portrait phone camera on a wide desktop screen would otherwise be zoomed in
// until nothing is recognisable, so those are shown whole (contain) instead.
const CLOSE_ENOUGH = 1.3;

export function useSmartFit(ref, enabled = true) {
  const [fit, setFit] = useState('contain');
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const update = () => {
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      const bw = el.clientWidth;
      const bh = el.clientHeight;
      if (!vw || !vh || !bw || !bh) return;
      const ratio = vw / vh / (bw / bh);
      setFit(ratio < CLOSE_ENOUGH && ratio > 1 / CLOSE_ENOUGH ? 'cover' : 'contain');
    };
    // "resize" fires when the sender rotates the phone or changes camera.
    el.addEventListener('loadedmetadata', update);
    el.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => {
      el.removeEventListener('loadedmetadata', update);
      el.removeEventListener('resize', update);
      ro.disconnect();
    };
  });
  return fit;
}
