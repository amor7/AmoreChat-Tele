import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { formatSize, faDigits } from '../util';
import { Upload, CheckCircle2, XCircle, RefreshCw, Trash2, Rocket } from 'lucide-react';

// Owner: update the server from the release files (no terminal, no GitHub). The server says which
// files it still needs; only those of the chosen ones are sent; the signature is checked first.
const CHUNK = 8 * 1024 * 1024;
const FIRST = ['manifest.json', 'SHA256SUMS', 'SHA256SUMS.sig'];
const RELEASES = 'https://github.com/amor7/AmoreChat-Tele/releases';

async function sendFile(file, from, onProgress) {
  for (let offset = from; offset < file.size || (offset === 0 && file.size === 0); ) {
    const piece = file.slice(offset, offset + CHUNK);
    const res = await fetch(`/api/admin/update/files/${encodeURIComponent(file.name)}?offset=${offset}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'amorechat', 'content-type': 'application/octet-stream' },
      body: piece,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ارسال ناموفق بود');
    offset = data.size;
    onProgress(offset);
    if (file.size === 0) break;
  }
}

export default function AdminUpdate() {
  const showToast = useStore((s) => s.showToast);
  const [s, setS] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [progress, setProgress] = useState({});
  const [busy, setBusy] = useState(false);
  const [lost, setLost] = useState(false);
  const pick = useRef(null);

  const load = async () => {
    try {
      const r = await api('GET', '/admin/update', undefined, { timeout: 120000 });
      setS(r);
      setLost(false);
      return r;
    } catch (e) {
      // While it installs, the app restarts: it is back in a minute.
      if (s?.result?.state === 'running' || s?.result?.state === 'queued') setLost(true);
      else showToast(e.message);
      return null;
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const running = s?.result?.state === 'running' || s?.result?.state === 'queued' || lost;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <p className="muted">…</p>;

  // The small files first (they say what else is needed), then only the needed ones.
  const upload = async (files) => {
    setBusy(true);
    try {
      const byName = new Map(files.map((f) => [f.name, f]));
      for (const name of FIRST) {
        const f = byName.get(name);
        if (f) await sendFile(f, 0, (n) => setProgress((p) => ({ ...p, [name]: n })));
      }
      const now = await load();
      for (const n of now?.needed || []) {
        const f = byName.get(n.name);
        if (!f || FIRST.includes(n.name)) continue;
        const have = now.files.find((x) => x.name === n.name)?.size || 0;
        const from = have > 0 && have < f.size ? have : have === f.size ? f.size : 0;
        if (from === f.size && f.size) continue;
        await sendFile(f, from, (x) => setProgress((p) => ({ ...p, [n.name]: x })));
      }
      await load();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  };
  const apply = async () => {
    if (!confirm(`نسخه ${faDigits(s.target)} نصب شود؟ اول از داده‌ها پشتیبان گرفته می‌شود؛ برنامه حدود یک دقیقه در دسترس نیست.`)) return;
    try {
      setS(await api('POST', '/admin/update/apply', {}, { timeout: 120000 }));
    } catch (e) {
      showToast(e.message);
    }
  };
  const clear = async () => {
    if (!confirm('فایل‌های فرستاده‌شده پاک شوند؟')) return;
    try {
      setS(await api('DELETE', '/admin/update/files'));
      setProgress({});
      setChosen([]);
    } catch (e) {
      showToast(e.message);
    }
  };

  const missing = s.needed.filter((n) => !n.have && !chosen.some((f) => f.name === n.name));
  const state = s.result?.state;
  return (
    <div className="admin-update">
      <p className="hint">
        نسخه نصب‌شده: <b dir="ltr">{faDigits(s.installed)}</b>
        {s.target ? (
          <>
            {' '}
            · نسخه فرستاده‌شده: <b dir="ltr">{faDigits(s.target)}</b>
          </>
        ) : null}
      </p>
      {!s.agent && (
        <p className="tele-warn">
          ابزار آپدیت از پنل روی این سرور فعال نیست. یک بار با دستور <code dir="ltr">sudo amorechat-update</code> (یا آپدیت آفلاین با پوشه) آپدیت کنید؛ از آن به بعد از همین‌جا می‌شود. سرورهای بدون systemd این امکان را ندارند.
        </p>
      )}
      <ol className="update-steps">
        <li>
          روی کامپیوتری که اینترنت دارد، فایل‌های نسخه جدید را از{' '}
          <a href={RELEASES} target="_blank" rel="noreferrer">
            صفحه Releases
          </a>{' '}
          بگیرید. اگر نمی‌دانید کدام‌ها: همه را انتخاب کنید؛ فقط آن‌هایی که این سرور لازم دارد فرستاده می‌شود.
        </li>
        <li>اینجا انتخابشان کنید. اول manifest و امضا فرستاده می‌شود و بعد می‌گوید چه فایل‌هایی دیگر لازم است.</li>
        <li>وقتی همه سبز شد، «نصب» را بزنید.</li>
      </ol>

      <input
        ref={pick}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          if (!files.length) return;
          setChosen(files);
          upload(files);
        }}
      />
      <div className="inline-form">
        <button className="btn primary sm" disabled={busy || running} onClick={() => pick.current?.click()}>
          <Upload size={14} /> {busy ? 'در حال ارسال…' : 'انتخاب فایل‌های نسخه'}
        </button>
        <button className="btn sm" disabled={busy} onClick={load}>
          <RefreshCw size={14} /> بررسی دوباره
        </button>
        {s.files.length > 0 && (
          <button className="btn sm danger" disabled={busy || running} onClick={clear}>
            <Trash2 size={14} /> پاک کردن فایل‌ها
          </button>
        )}
      </div>

      {s.needed.length > 0 && (
        <ul className="user-list update-files">
          {s.needed.map((n) => {
            const f = s.files.find((x) => x.name === n.name);
            const local = chosen.find((x) => x.name === n.name);
            const sent = progress[n.name] ?? f?.size ?? 0;
            const total = local?.size || f?.size || 0;
            const ok = f?.state === 'ok' || (n.name.startsWith('SHA256SUMS') && f && s.signed);
            const bad = f?.state === 'bad' || (n.name.startsWith('SHA256SUMS') && s.signed === false);
            return (
              <li key={n.name} className="row-item">
                {ok ? <CheckCircle2 size={16} className="ok" /> : bad ? <XCircle size={16} className="danger" /> : <span className="dot" />}
                <span className="grow" dir="ltr">
                  {n.name}
                </span>
                <small className="muted">
                  {total ? `${formatSize(Math.min(sent, total))} / ${formatSize(total)}` : n.have ? formatSize(f.size) : 'هنوز فرستاده نشده'}
                </small>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && s.target && (
        <p className="tele-warn">
          این فایل‌ها را هم از صفحه نسخه {faDigits(s.target)} بردارید و انتخاب کنید:{' '}
          {missing.map((m) => (
            <code key={m.name} dir="ltr">
              {m.name}{' '}
            </code>
          ))}
        </p>
      )}
      {s.problems.map((p) => (
        <p key={p} className="tele-warn">
          {p}
        </p>
      ))}

      <button className="btn primary" disabled={!s.ready || busy || running} onClick={apply}>
        <Rocket size={16} /> {running ? 'در حال نصب…' : s.target ? `نصب نسخه ${faDigits(s.target)}` : 'نصب'}
      </button>
      {lost && <p className="muted">برنامه در حال راه‌اندازی دوباره است؛ چند لحظه صبر کنید…</p>}
      {state === 'done' && <p className="ok">آپدیت انجام شد. صفحه را یک بار تازه کنید.</p>}
      {state === 'failed' && <p className="tele-warn">آپدیت انجام نشد؛ نسخه قبلی سر جایش است. جزئیات در گزارش پایین.</p>}
      {s.log && (
        <details open={running || state === 'failed'}>
          <summary>گزارش نصب</summary>
          <pre className="update-log" dir="ltr">
            {s.log}
          </pre>
        </details>
      )}
    </div>
  );
}
