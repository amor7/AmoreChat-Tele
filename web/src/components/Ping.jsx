import { useStore } from '../store';
import { toFa } from '../util';

// Always-visible connection indicator: round-trip time to the server (socket ack) and,
// during a call/voice room, LiveKit's own view of our media connection.
const LK_LABEL = { excellent: 'عالی', good: 'خوب', poor: 'ضعیف', lost: 'قطع' };

export function pingLevel(ms, connected, lkQuality) {
  if (!connected || lkQuality === 'lost') return 'off';
  if (lkQuality === 'poor' || ms > 400) return 'bad';
  if (ms > 150) return 'mid';
  return 'good';
}

export default function Ping({ dark = false }) {
  const ping = useStore((s) => s.ping);
  const connected = useStore((s) => s.connected);
  const lk = useStore((s) => s.rtc?.participants?.find((p) => p.isLocal)?.quality);
  const rtcState = useStore((s) => s.rtc?.state);
  const weak = useStore((s) => s.netWeak);
  const level = rtcState === 'reconnecting' ? 'bad' : pingLevel(ping ?? 0, connected, lk);
  const text = !connected ? 'قطع' : ping == null ? '…' : `${toFa(ping)}ms`;
  const title = [
    connected ? `پینگ تا سرور: ${ping ?? '…'} میلی‌ثانیه` : 'ارتباط با سرور قطع است',
    lk && lk !== 'unknown' ? `کیفیت تماس: ${LK_LABEL[lk] || lk}` : '',
    weak ? 'اینترنت ضعیف: حالت کم‌مصرف خودکار' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <span className={`ping ping-${level} ${dark ? 'dark' : ''}`} title={title} aria-label={title} role="status">
      <i className="ping-bars">
        <b />
        <b />
        <b />
      </i>
      <span dir="ltr">{text}</span>
      {weak && <span className="weak-tag">کم‌مصرف</span>}
    </span>
  );
}
