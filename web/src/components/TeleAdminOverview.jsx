// Admin panel → Telegram → overview: what is working and what needs attention, each with a way to it.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toFa } from '../util';
import { adminTeleAccounts, adminProxies, teleMirrors } from '../teleApi';
import { mbText } from './TeleAdminAccounts';
import { CircleCheck, Circle, TriangleAlert, ChevronLeft } from 'lucide-react';
import { Skeleton } from './States';

export default function TeleOverview({ go, onVpn }) {
  const me = useStore((s) => s.me);
  const [d, setD] = useState(null);
  useEffect(() => {
    // Each part may fail on its own (no permission, Telegram down): the rest still shows.
    const quiet = (req) => req().catch(() => null);
    Promise.all([quiet(adminTeleAccounts), quiet(adminProxies), me.role === 'owner' ? quiet(teleMirrors) : null]).then(([accounts, net, mirrors]) => setD({ accounts, net, mirrors }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <Skeleton lines={4} />;

  const users = d.accounts?.accounts || [];
  const proxies = d.net?.proxies || [];
  const mirrors = d.mirrors?.mirrors || [];
  const running = !!d.net?.egress?.running;
  const connected = users.filter((a) => a.status === 'connected').length;
  const usage = users.reduce((n, a) => n + a.used, 0);
  const capped = users.filter((a) => a.effectiveQuotaMb > 0 && a.used >= a.effectiveQuotaMb * 1048576);
  const broken = mirrors.filter((m) => m.lastError);
  const ownerReady = d.mirrors ? !!d.mirrors.connected : true;

  const steps = [
    ['پروکسی اضافه کنید', proxies.length > 0, onVpn],
    ['در VPN ← تنظیمات، مسیر تلگرام را روشن کنید', !!d.net?.policy?.enabled, onVpn],
    ...(me.role === 'owner' ? [['حساب تلگرام خودتان را از منو ← تلگرام وصل کنید', ownerReady, null]] : []),
  ];
  const issues = [
    !running && d.net?.policy?.enabled && ['تونل قطع است؛ کاربران به تلگرام وصل نمی‌شوند', onVpn],
    broken.length > 0 && [`${toFa(broken.length)} کانال منتشرشده خطا دارد`, () => go('channels')],
    capped.length > 0 && [`${toFa(capped.length)} کاربر به سقف مصرف رسیده`, () => go('users')],
  ].filter(Boolean);
  const ready = steps.every(([, done]) => done);
  const cards = [
    // No answer about the tunnel (the request failed) is not the same as «off».
    ['تونل', !d.net ? 'نامعلوم' : running ? 'وصل' : 'خاموش'],
    ['کاربران وصل', `${toFa(connected)} از ${toFa(users.length)}`],
    ['مصرف این ماه', mbText(usage)],
    ...(d.mirrors ? [['کانال‌های منتشرشده', toFa(mirrors.filter((m) => m.enabled).length)]] : []),
  ];

  return (
    <>
      <div className="stat-grid">
        {cards.map(([label, value]) => (
          <div key={label} className="stat">
            <small>{label}</small>
            <b>{value}</b>
          </div>
        ))}
      </div>
      {!ready && (
        <div className="tele-group">
          <h4>راه‌اندازی</h4>
          <ol className="tele-steps">
            {steps.map(([label, done, action]) => (
              <li key={label} className={done ? 'done' : ''}>
                {done ? <CircleCheck size={18} /> : <Circle size={18} />}
                {action && !done ? (
                  <button type="button" className="tele-link" onClick={action}>
                    {label} <ChevronLeft size={14} />
                  </button>
                ) : (
                  <span>{label}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {issues.map(([text, action]) => (
        <button key={text} type="button" className="tele-issue" onClick={action}>
          <TriangleAlert size={17} />
          <span className="grow">{text}</span>
          <ChevronLeft size={16} />
        </button>
      ))}
      {ready && !issues.length && (
        <p className="tele-fine">
          <CircleCheck size={18} /> همه‌چیز سالم است.
        </p>
      )}
      {users.length > 0 && (
        <div className="tele-group">
          <h4>پرمصرف‌ترین کاربران این ماه</h4>
          <ul className="tele-top">
            {users.slice(0, 5).map((a) => (
              <li key={a.id}>
                <span className="grow">{a.name}</span>
                <small dir="auto">{mbText(a.used)}</small>
                <span className="tele-usage-bar">
                  {/* Data-driven width: the one inline style left (no class can know it). */}
                  <span style={{ width: `${users[0].used ? (a.used / users[0].used) * 100 : 0}%` }} />
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="tele-link" onClick={() => go('users')}>
            همه کاربران <ChevronLeft size={14} />
          </button>
        </div>
      )}
    </>
  );
}
