import { useEffect, useState } from 'react';
import { Cpu, MemoryStick, HardDrive, ArrowDownUp, Users, Phone, AudioLines, TriangleAlert, CircleCheck, Info } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { formatSize, formatDateTime, toFa } from '../util';

const RANGES = [
  ['1h', '۱ ساعت'],
  ['24h', '۲۴ ساعت'],
  ['7d', '۷ روز'],
  ['30d', '۳۰ روز'],
];
const pct = (a, b) => (b ? (100 * a) / b : 0);
const rate = (bps) => (bps == null ? '—' : `${formatSize(bps)}/ث`);
const level = (p, warn, bad) => (p >= bad ? 'bad' : p >= warn ? 'warn' : 'ok');

// Small dependency-free line chart: one or two series over time.
function Chart({ points, lines, max, format, height = 120 }) {
  const W = 600;
  const H = height;
  const pad = 4;
  const xs = points.map((p) => p.t);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const top = max ?? Math.max(1, ...points.flatMap((p) => lines.map((l) => p[l.key] ?? 0))) * 1.1;
  const X = (t) => (x1 === x0 ? W / 2 : pad + ((t - x0) / (x1 - x0)) * (W - 2 * pad));
  const Y = (v) => H - pad - (Math.max(0, v) / top) * (H - 2 * pad);
  if (points.length < 2) return <div className="chart-empty">هنوز داده کافی جمع نشده (هر دقیقه یک نمونه)</div>;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="grid" />
        ))}
        {lines.map((l) => {
          const pts = points.filter((p) => p[l.key] != null);
          if (pts.length < 2) return null;
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p[l.key]).toFixed(1)}`).join(' ');
          return (
            <g key={l.key} style={{ color: l.color }}>
              <path d={`${d} L${X(pts.at(-1).t)},${H} L${X(pts[0].t)},${H} Z`} className="area" />
              <path d={d} className="line" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {lines.map((l) => (
          <span key={l.key}>
            <i style={{ background: l.color }} /> {l.label}
          </span>
        ))}
        <span className="muted">بیشینه: {format(top / 1.1)}</span>
      </div>
    </div>
  );
}

function Card({ icon: Icon, label, value, sub, state = 'ok' }) {
  return (
    <div className={`hcard ${state}`}>
      <Icon size={20} />
      <div>
        <small>{label}</small>
        <b>{value}</b>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

export default function Health() {
  const showToast = useStore((s) => s.showToast);
  const [range, setRange] = useState('24h');
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api('GET', `/admin/health?range=${range}`)
        .then((d) => alive && setData(d))
        .catch((e) => showToast(e.message));
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p className="muted">…</p>;
  const n = data.now;
  const memP = pct(n.memUsed, n.memTotal);
  const diskP = pct(n.diskUsed, n.diskTotal);
  const open = data.alerts.filter((a) => !a.resolved_at);
  const pts = data.series;

  return (
    <div className="health">
      {open.length > 0 ? (
        open.map((a) => (
          <div key={a.id} className="health-alert bad">
            <TriangleAlert size={18} /> {a.text} <small>از {formatDateTime(a.started_at)}</small>
          </div>
        ))
      ) : (
        <div className="health-alert ok">
          <CircleCheck size={18} /> همه‌چیز سالم است
        </div>
      )}

      <div className="hcards">
        <Card icon={Cpu} label="پردازنده" value={n.cpu == null ? '…' : `${toFa(Math.round(n.cpu))}٪`} sub={`بار: ${n.load.toLocaleString('fa-IR', { maximumFractionDigits: 2 })}`} state={level(n.cpu ?? 0, 70, 90)} />
        <Card icon={MemoryStick} label="رم" value={`${toFa(Math.round(memP))}٪`} sub={`${formatSize(n.memUsed)} از ${formatSize(n.memTotal)}`} state={level(memP, 80, 92)} />
        <Card icon={HardDrive} label="دیسک" value={`${toFa(Math.round(diskP))}٪`} sub={`${formatSize(n.diskTotal - n.diskUsed)} آزاد`} state={level(diskP, 80, 90)} />
        <Card icon={ArrowDownUp} label="ترافیک" value={`↓ ${rate(n.netRx)}`} sub={`↑ ${rate(n.netTx)}`} />
        <Card icon={Users} label="آنلاین" value={toFa(n.online)} />
        <Card icon={Phone} label="تماس / ویس‌چت" value={`${toFa(n.calls)} / ${toFa(n.voice)} نفر`} />
        <Card
          icon={AudioLines}
          label="سرور صدا"
          value={n.media == null ? 'غیرفعال' : n.media ? 'سالم' : 'قطع'}
          state={n.media === false ? 'bad' : 'ok'}
        />
      </div>

      <div className="segmented">
        {RANGES.map(([k, label]) => (
          <button key={k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>
            {label}
          </button>
        ))}
      </div>

      <h4>پردازنده و رم (٪)</h4>
      <Chart
        points={pts.map((p) => ({ t: p.t, cpu: p.cpu, mem: pct(p.memUsed, p.memTotal) }))}
        lines={[
          { key: 'cpu', label: 'پردازنده', color: '#6366f1' },
          { key: 'mem', label: 'رم', color: '#10b981' },
        ]}
        max={100}
        format={(v) => `${toFa(Math.round(v))}٪`}
      />
      <h4>ترافیک شبکه</h4>
      <Chart
        points={pts}
        lines={[
          { key: 'netRx', label: 'دریافت', color: '#0ea5e9' },
          { key: 'netTx', label: 'ارسال', color: '#f59e0b' },
        ]}
        format={rate}
      />
      {!data.netHostWide && (
        <p className="hint with-icon">
          <Info size={15} /> فقط ترافیک خود برنامه اندازه‌گیری می‌شود (بدون تماس‌ها). نصب Docker با docker-compose جدید (آپدیت) ترافیک کل سرور را نشان می‌دهد.
        </p>
      )}
      <h4>کاربران آنلاین و تماس‌ها</h4>
      <Chart
        points={pts}
        lines={[
          { key: 'online', label: 'آنلاین', color: '#8b5cf6' },
          { key: 'voice', label: 'در ویس‌چت', color: '#ec4899' },
          { key: 'calls', label: 'تماس', color: '#14b8a6' },
        ]}
        format={(v) => toFa(Math.round(v))}
      />
      <h4>دیسک (٪)</h4>
      <Chart points={pts.map((p) => ({ t: p.t, disk: pct(p.diskUsed, p.diskTotal) }))} lines={[{ key: 'disk', label: 'دیسک', color: '#ef4444' }]} max={100} format={(v) => `${toFa(Math.round(v))}٪`} height={80} />

      {data.cert && (
        <>
          <h4>گواهی HTTPS</h4>
          {data.cert.mode === 'off' ? (
            <p className="muted">بدون SSL (http): پیام‌ها کار می‌کنند؛ تماس و ویس‌چت به SSL نیاز دارند (TLS_MODE در فایل .env).</p>
          ) : data.cert.error ? (
            <p className="muted">بررسی نشد ({data.cert.error})</p>
          ) : (
            <p className={data.cert.mode !== 'internal' && data.cert.daysLeft < 20 ? 'health-alert bad' : 'muted'}>
              {data.cert.mode === 'internal'
                ? 'گواهی داخلی سرور (بدون نیاز به اینترنت خارج؛ خودکار تمدید می‌شود)'
                : `${data.cert.issuer || 'گواهی'} — معتبر تا ${formatDateTime(data.cert.notAfter)} (${toFa(data.cert.daysLeft)} روز مانده)`}
              {data.cert.mode === 'auto' && ' · تمدید خودکار حدود ۳۰ روز قبل از پایان؛ اگر به ۲۰ روز برسد هشدار می‌گیرید.'}
            </p>
          )}
        </>
      )}

      {data.dns && (
        <>
          <h4>DNS دامنه (در زمان قطعی)</h4>
          {data.dns.foreign || data.dns.notIr ? (
            <p className="health-alert bad">
              {data.dns.notIr ? 'دامنه زیر .ir نیست' : `DNS روی سرورهای خارجی است (${data.dns.ns.join('، ')})`} — در قطعی اینترنت بین‌الملل، آدرس سرور پیدا نمی‌شود و برنامه باز
              نمی‌شود. DNS را به یک سرویس داخلی (مثل ابر آروان) منتقل کنید.
            </p>
          ) : (
            <p className="muted">{data.dns.ns.length ? `داخلی (${data.dns.ns.join('، ')}) — در قطعی هم پیدا می‌شود` : 'بررسی نشد'}</p>
          )}
        </>
      )}

      <h4>بکاپ دوم</h4>
      {data.mirror.enabled ? (
        <p className="muted">
          فعال {data.mirror.last ? `— آخرین کپی: ${formatDateTime(data.mirror.last.at)} (${toFa(data.mirror.last.files)} فایل جدید)` : '— بعد از بکاپ روزانه بعدی انجام می‌شود'}
        </p>
      ) : (
        <p className="hint">
          خاموش. برای کپی خودکار بکاپ و همه فایل‌ها روی یک دیسک یا سرور دیگر، آن را روی سرور mount کنید و در فایل <code>.env</code> بنویسید{' '}
          <code dir="ltr">BACKUP_MIRROR_DIR=/mnt/backup</code> و <code dir="ltr">sudo docker compose up -d</code> بزنید.
        </p>
      )}

      <h4>هشدارهای اخیر</h4>
      <ul className="alert-list">
        {data.alerts.map((a) => (
          <li key={a.id} className={a.resolved_at ? 'resolved' : 'open'}>
            {a.resolved_at ? <CircleCheck size={15} /> : <TriangleAlert size={15} />}
            <span className="grow">{a.text}</span>
            <small>
              {formatDateTime(a.started_at)}
              {a.resolved_at && ` ← ${formatDateTime(a.resolved_at)}`}
            </small>
          </li>
        ))}
        {!data.alerts.length && <li className="muted">هشداری ثبت نشده</li>}
      </ul>
    </div>
  );
}
