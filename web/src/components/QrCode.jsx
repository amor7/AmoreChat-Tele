import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import qrcode from 'qrcode-generator';
import { X } from 'lucide-react';
import { useBackClose } from '../backnav';

// A link as a QR code, so another phone can open it with its camera (no copy/paste, no chat app
// needed to pass the link along). Drawn locally; nothing is fetched.

// Dark modules on white with a 4-module quiet zone, as scanners expect; the image itself is
// white, so it scans the same in the dark theme. null when the value doesn't fit in a QR code.
function qrDataUrl(value) {
  if (!value) return null;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    return qr.createDataURL(8, 4);
  } catch {
    return null;
  }
}

// Large view over everything. Its own layer (not Modal) because it often opens from inside
// another dialog: Escape and Back must close only this one.
function QrOverlay({ src, value, title, onClose }) {
  useBackClose(true, onClose);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop qr-backdrop" onClick={onClose}>
      <div className="modal qr-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="بستن" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body qr-modal-body">
          <img className="qr-code qr-big" src={src} alt={`کد QR: ${value}`} />
          <code dir="ltr" className="qr-value">
            {value}
          </code>
          <p className="muted">با دوربین گوشی اسکن کنید.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A small QR code; tap it for a large one. Renders nothing if `value` can't be encoded. */
export default function QrCode({ value, size = 96, title = 'کد QR' }) {
  const src = useMemo(() => qrDataUrl(value), [value]);
  const [big, setBig] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" className="qr-thumb" onClick={() => setBig(true)} title="نمایش بزرگ‌تر" aria-label={`${title} — نمایش بزرگ‌تر`}>
        <img className="qr-code" src={src} alt={`کد QR: ${value}`} style={{ width: size, height: size }} />
      </button>
      {big && <QrOverlay src={src} value={value} title={title} onClose={() => setBig(false)} />}
    </>
  );
}

/** A small "QR" button beside a copy-link button: shows the link's QR code only when asked. */
export function QrButton({ value, title = 'کد QR لینک', className = 'btn sm' }) {
  const src = useMemo(() => qrDataUrl(value), [value]);
  const [open, setOpen] = useState(false);
  if (!src) return null;
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title={title} aria-label={title}>
        QR
      </button>
      {open && <QrOverlay src={src} value={value} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}
