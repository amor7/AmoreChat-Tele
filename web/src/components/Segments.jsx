// Sub-pages inside one admin page (Telegram, VPN), so each shows one thing at a time.
// `items`: [[key, label], ...]. The .tele-seg class (and its look) is kept from those pages.
export default function Segments({ items, value, onChange }) {
  return (
    <div className="tele-seg" role="tablist">
      {items.map(([key, label]) => (
        <button key={key} role="tab" aria-selected={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}
