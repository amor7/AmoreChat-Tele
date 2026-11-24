import { createPortal } from 'react-dom';
import { useDialog } from '../a11y';
import { X } from 'lucide-react';

/**
 * A full-screen photo: the app's own photos (ImageViewer in Modals.jsx) and Telegram photos.
 * Built on useDialog, not Modal (architect rule for new overlays): focus moves inside and stays
 * there, Escape closes the top layer only, Back closes it, focus goes back to the photo.
 * - `download`: the download control (an element with class lightbox-dl); each caller has its
 *   own way to save (the app's files go through download.js, Telegram's are already a Blob).
 * - `back`: off only for the one hosted by Modals(), which registers Back itself.
 * - `portal`: render into <body>, out of the message bubble it was opened from (a bubble may be
 *   a containing block for fixed elements in some WebViews).
 * Pinch zoom is left to the browser; double-tap zoom is not built in.
 */
export default function Lightbox({ src, alt = 'عکس', label = 'نمایش عکس', onClose, download = null, back = true, portal = false }) {
  const dialog = useDialog({ onClose, back });
  const view = (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={label} {...dialog}>
      <button className="lightbox-close" onClick={onClose} aria-label="بستن">
        <X size={24} />
      </button>
      <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      {download}
    </div>
  );
  return portal ? createPortal(view, document.body) : view;
}
