import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Modal } from './Modals';

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

// Large view over everything. It often opens from inside another dialog, so it registers its
// own Back (back) and sits above the other dialogs and the lightbox (qr-backdrop): Escape and
// Back close only this one, thanks to the shared layer stacks.
function QrOverlay({ src, value, title, onClose }) {
  return (
    <Modal title={title} onClose={onClose} size="qr-modal" bodyClassName="qr-modal-body" backdropClassName="qr-backdrop" portal>
      <img className="qr-code qr-big" src={src} alt={`کد QR: ${value}`} />
      <code dir="ltr" className="qr-value">
        {value}
      </code>
      <p className="muted">با دوربین گوشی اسکن کنید.</p>
    </Modal>
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
