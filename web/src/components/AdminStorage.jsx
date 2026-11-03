import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { formatSize, formatDateTime, toFa } from '../util';
import { useLoad } from './AdminPanelsA1';
import { HardDrive, Trash2, X } from 'lucide-react';

const LABELS = { image: 'عکس', video: 'ویدیو', music: 'موزیک', voice: 'پیام صوتی', app: 'برنامه', archive: 'فشرده', document: 'سند', other: 'متفرقه' };
const CHAT_LABELS = { dm: 'گفتگوی خصوصی', saved: 'پیام‌های ذخیره‌شده' };
const chatName = (c) => CHAT_LABELS[c.type] || c.title || 'گفتگو';
const PAGE = 50;

const queryOf = (f, extra = {}) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v && k !== 'userName' && k !== 'chatName') p.set(k, v);
  return p.toString();
};
// What goes to the server as a filter: the same keys, without the display names.
const filterOf = ({ userName, chatName: _c, ...f }) => Object.fromEntries(Object.entries(f).filter(([, v]) => v));

function Bars({ rows, onPick, active }) {
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <ul className="storage-bars">
      {rows.map((r) => (
        <li key={r.key}>
          <button className={active === r.key ? 'active' : ''} onClick={() => onPick(r)}>
            <span className="storage-bar-label">
              <b dir="auto">{r.label}</b>
              <small>
                {formatSize(r.bytes)} · {toFa(r.count)} فایل
              </small>
            </span>
            <span className="storage-bar">
              <i style={{ width: `${(r.bytes / max) * 100}%` }} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function AdminStorage({ start }) {
  const me = useStore((s) => s.me);
  const showToast = useStore((s) => s.showToast);
  const [filter, setFilter] = useState(() => (start ? { userId: String(start.id), userName: start.name } : {}));
  const [sort, setSort] = useState('size');
  const [files, setFiles] = useState([]);
  const [more, setMore] = useState(false);
  const [ticked, setTicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [s, reload] = useLoad(`/admin/storage?${queryOf(filter)}`);

  const page = async (offset) => {
    try {
      const r = await api('GET', `/admin/storage/files?${queryOf(filter, { sort, offset, limit: PAGE })}`);
      setFiles((old) => (offset ? [...old, ...r.files] : r.files));
      setMore(r.files.length === PAGE);
    } catch (e) {
      showToast(e.message);
    }
  };
  useEffect(() => {
    setTicked([]);
    page(0);
  }, [filter, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setFilter((f) => ({ ...f, ...patch }));
  const refresh = () => {
    setTicked([]);
    reload();
    page(0);
  };

  const remove = async (body) => {
    setBusy(true);
    let deleted = 0;
    let bytes = 0;
    try {
      for (;;) {
        const r = await api('POST', '/admin/storage/delete', body);
        deleted += r.deleted;
        bytes += r.bytes;
        if (body.ids || !r.remaining || !r.deleted) break;
      }
      showToast(`${toFa(deleted)} فایل حذف شد · ${formatSize(bytes)} آزاد شد`);
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
    refresh();
  };

  const removeShown = (f, count, size) => {
    const password = prompt(`${toFa(count)} فایل (${formatSize(size)}) برای همیشه از سرور حذف می‌شوند و در چت‌ها «حذف شده» نشان داده می‌شوند.\nبرای تأیید رمز عبور خود را بنویسید:`);
    if (password) remove({ filter: f, password });
  };

  if (!s) return <p className="muted">…</p>;
  const filtered = Object.keys(filterOf(filter)).length > 0;
  const cards = [
    ['دیسک آزاد', s.disk ? `${formatSize(s.disk.free)} از ${formatSize(s.disk.total)}` : '—'],
    ['فایل‌ها', formatSize(s.uploadsBytes)],
    ['دیتابیس', formatSize(s.dbBytes)],
    ['بکاپ‌ها', formatSize(s.backupsBytes)],
    ['رشد روزانه (هفته اخیر)', formatSize(s.perDay)],
    ['تخمین پر شدن دیسک', s.daysLeft == null ? '—' : `حدود ${toFa(s.daysLeft)} روز دیگر`],
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

      <div className="storage-cleanup">
        {s.unused.count > 0 && (
          <button className="btn sm" disabled={busy} onClick={() => removeShown({ unused: 1 }, s.unused.count, s.unused.bytes)}>
            <Trash2 size={15} /> پاک‌سازی فایل‌های بی‌استفاده ({formatSize(s.unused.bytes)})
          </button>
        )}
        {me.role === 'owner' && (
          <button
            className="btn sm"
            disabled={busy}
            title="بعد از حذف پیام و فایل زیاد، فضای خالی دیتابیس را به دیسک برمی‌گرداند"
            onClick={async () => {
              if (!confirm('تا پایان فشرده‌سازی (روی دیتابیس بزرگ چند دقیقه) برنامه برای همه جواب نمی‌دهد. ادامه؟')) return;
              setBusy(true);
              try {
                const r = await api('POST', '/admin/storage/compact', {}, { timeout: 10 * 60000 });
                showToast(r.nothingToDo ? 'دیتابیس فضای خالی قابل‌توجهی ندارد؛ کاری لازم نبود' : `${formatSize(Math.max(0, r.saved))} آزاد شد`);
                reload();
              } catch (e) {
                showToast(e.message);
              }
              setBusy(false);
            }}
          >
            <HardDrive size={15} /> فشرده‌سازی دیتابیس
          </button>
        )}
        {s.kept.count > 0 && (
          <small className="muted">
            {formatSize(s.kept.bytes)} مربوط به پیام‌های حذف‌شده‌ای است که برای مدیران نگه داشته شده‌اند و خودکار پاک می‌شوند.
          </small>
        )}
      </div>

      {(filter.userId || filter.chatId) && (
        <div className="storage-tags">
          {filter.userId && (
            <button className="tag" onClick={() => set({ userId: '', userName: '' })}>
              {filter.userName} <X size={12} />
            </button>
          )}
          {filter.chatId && (
            <button className="tag" onClick={() => set({ chatId: '', chatName: '' })}>
              {filter.chatName} <X size={12} />
            </button>
          )}
        </div>
      )}

      <h4>نوع فایل</h4>
      <Bars
        rows={s.categories.map((c) => ({ ...c, key: c.category, label: LABELS[c.category] }))}
        active={filter.category}
        onPick={(r) => set({ category: filter.category === r.key ? '' : r.key })}
      />

      {!filter.userId && (
        <>
          <h4>پرمصرف‌ترین کاربران</h4>
          <Bars
            rows={s.users.map((u) => ({ ...u, key: String(u.id), label: u.id ? u.name || u.username : 'کپی تلگرام و بدون صاحب' }))}
            onPick={(r) => set({ userId: r.id ? String(r.id) : 'none', userName: r.label })}
          />
        </>
      )}
      {!filter.chatId && s.chats.length > 0 && (
        <>
          <h4>پرحجم‌ترین گفتگوها</h4>
          <Bars rows={s.chats.map((c) => ({ ...c, key: String(c.id), label: chatName(c) }))} onPick={(r) => set({ chatId: String(r.id), chatName: r.label })} />
        </>
      )}

      <h4>
        فایل‌ها ({toFa(s.matched.count)} · {formatSize(s.matched.bytes)})
      </h4>
      <div className="storage-filters">
        <input placeholder="جستجوی نام فایل…" value={filter.q || ''} onChange={(e) => set({ q: e.target.value })} />
        <select value={filter.minMb || ''} onChange={(e) => set({ minMb: e.target.value })}>
          <option value="">هر حجمی</option>
          {[10, 100, 500, 1024].map((n) => (
            <option key={n} value={n}>
              بیشتر از {n === 1024 ? '۱ گیگابایت' : `${toFa(n)} مگابایت`}
            </option>
          ))}
        </select>
        <select value={filter.olderDays || ''} onChange={(e) => set({ olderDays: e.target.value })}>
          <option value="">هر زمانی</option>
          {[30, 90, 180, 365].map((n) => (
            <option key={n} value={n}>
              قدیمی‌تر از {toFa(n)} روز
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="size">اول پرحجم‌ها</option>
          <option value="date">اول جدیدها</option>
        </select>
      </div>

      <div className="storage-actions">
        {ticked.length > 0 && (
          <button className="btn sm danger" disabled={busy} onClick={() => confirm(`${toFa(ticked.length)} فایل برای همیشه حذف شود؟`) && remove({ ids: ticked })}>
            <Trash2 size={15} /> حذف انتخاب‌شده‌ها ({toFa(ticked.length)})
          </button>
        )}
        {filtered && s.matched.count > 0 && (
          <button className="btn sm danger" disabled={busy} onClick={() => removeShown(filterOf(filter), s.matched.count, s.matched.bytes)}>
            <Trash2 size={15} /> حذف همه این {toFa(s.matched.count)} فایل
          </button>
        )}
      </div>

      <ul className="storage-files">
        {files.map((f) => (
          <li key={f.id}>
            <label className="check">
              <input
                type="checkbox"
                disabled={f.avatar}
                checked={ticked.includes(f.id)}
                onChange={(e) => setTicked(e.target.checked ? [...ticked, f.id] : ticked.filter((x) => x !== f.id))}
              />
              <span className="grow">
                <b dir="auto">{f.name}</b>
                <small className="muted">
                  {formatSize(f.bytes)} · {LABELS[f.category]} · {f.owner?.name || 'بدون صاحب'} · {formatDateTime(f.createdAt)}
                  {f.chats.length > 0 && ` · ${f.chats.map(chatName).join('، ')}`}
                  {f.avatar && ' · عکس پروفایل (حذف نمی‌شود)'}
                </small>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {more && (
        <button className="btn sm" onClick={() => page(files.length)}>
          فایل‌های بیشتر
        </button>
      )}
    </>
  );
}
