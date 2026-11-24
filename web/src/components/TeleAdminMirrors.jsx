// Admin panel → Telegram → published channels (owner): Telegram channels whose posts appear in
// channels of this app, read once for everyone.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { toFa, formatDateTime, copyText } from '../util';
import { confirmDialog, copyDialog } from '../confirm';
import { teleMirrors, mirrorChannels, addMirror, runMirrors, patchMirror, newMirrorInvite, deleteMirror, saveMirrorSettings } from '../teleApi';
import { QrButton } from './QrCode';
import { RefreshCw, Trash2, Copy, Plus, Rss } from 'lucide-react';
import { Skeleton, ErrorState, EmptyState } from './States';

const VIS_LABELS = {
  public: 'عمومی (در «کاوش» دیده می‌شود)',
  all: 'همه کاربران خودکار عضو شوند',
  link: 'خصوصی (فقط با لینک دعوت)',
};
const inviteLink = (code) => `${location.origin}/#/join/${code}`;
export default function TeleMirrors() {
  const me = useStore((st) => st.me);
  const showToast = useStore((st) => st.showToast);
  const [data, setData] = useState(null);
  const [channels, setChannels] = useState(null);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [tgChatId, setTgChatId] = useState('');
  const [target, setTarget] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [withFiles, setWithFiles] = useState(false);
  const [visibility, setVisibility] = useState('public');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const load = () =>
    teleMirrors()
      .then((r) => {
        setError('');
        setData(r);
      })
      .catch((e) => (data ? showToast(e.message) : setError(e.message)));
  // Live from Telegram: every channel the owner's account follows (and a public one by @name).
  const findChannels = async (term = q) => {
    setSearching(true);
    try {
      const r = await mirrorChannels(term.trim());
      setChannels(r.channels);
      if (r.channels.length === 1) setTgChatId(r.channels[0].tgChatId);
    } catch (e) {
      showToast(e.message);
    }
    setSearching(false);
  };
  useEffect(() => {
    if (me.role === 'owner') load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (data?.connected && !channels) findChannels('');
  }, [data?.connected]); // eslint-disable-line react-hooks/exhaustive-deps
  if (me.role !== 'owner') return null;
  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={3} />;
  const act = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) showToast(ok);
      await load();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  };
  // No clipboard at all (plain http, old WebView): show the link to copy by hand.
  const copy = async (text) => ((await copyText(text)) ? showToast('لینک کپی شد') : copyDialog({ title: 'لینک دعوت', value: text }));
  const used = new Set(data.mirrors.map((m) => m.tgChatId));
  const free = (channels || []).filter((c) => !used.has(c.tgChatId));
  const addForm = (
    <form
      className="tele-group"
      onSubmit={(e) => {
        e.preventDefault();
        act(() => addMirror({ tgChatId, ...(target ? { chatId: Number(target) } : {}), withPhotos, withFiles, visibility }), 'اضافه شد').then(() => {
          setTgChatId('');
          setAdding(false);
        });
      }}
    >
      <label>
        ۱. کانال یا گروه تلگرام
        <span className="inline-form">
          <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو، ‎@نام‌کاربری یا لینک t.me" />
          <button type="button" className={`btn sm ${searching ? 'spin' : ''}`} disabled={searching} onClick={() => findChannels()}>
            <RefreshCw size={14} /> {searching ? 'در حال دریافت…' : 'جستجو'}
          </button>
        </span>
      </label>
      <select value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} aria-label="کانال تلگرام">
        <option value="">{channels ? `— انتخاب کنید (${toFa(free.length)}) —` : '— در حال دریافت… —'}</option>
        {free.map((c) => (
          <option key={c.tgChatId} value={c.tgChatId}>
            {c.kind === 'group' ? '👥 ' : '📢 '}
            {c.title}
            {c.username ? ` (@${c.username})` : ''}
            {c.joined ? '' : ' · عضو نیستید'}
          </option>
        ))}
      </select>
      {channels && !channels.length && <small className="muted">چیزی پیدا نشد. برای کانال عمومی‌ای که عضوش نیستید، ‎@نام‌کاربری آن را جستجو کنید.</small>}
      <label>
        ۲. کجا منتشر شود
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">کانال تازه در برنامه</option>
          {data.appChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        ۳. چه کسانی ببینند
        <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          {Object.entries(VIS_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} /> عکس‌ها را هم بیاور (با اولین باز کردن)
      </label>
      <label className="check">
        <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> ویدیو و فایل را هم بیاور (با اولین باز کردن)
      </label>
      <button className="btn sm primary" disabled={!tgChatId || busy}>
        افزودن
      </button>
    </form>
  );

  return (
    <div className="tele-mirrors">
      <p className="hint">پست‌های تلگرام خودکار در یک کانال همین برنامه منتشر می‌شوند؛ کاربران بدون تلگرام می‌خوانند و ترافیک فقط یک بار مصرف می‌شود.</p>
      {!data.connected ? (
        <p className="muted">اول حساب تلگرام خودتان را از منو ← تلگرام وصل کنید.</p>
      ) : (
        <>
          <div className="tele-actions">
            <button type="button" className="btn sm primary" onClick={() => setAdding(!adding)}>
              <Plus size={14} /> افزودن کانال
            </button>
            <button type="button" className="btn sm" disabled={busy || !data.mirrors.length} onClick={() => act(runMirrors, 'بررسی شد')}>
              <RefreshCw size={14} /> بررسی الان
            </button>
          </div>
          {adding && addForm}
          <ul className="tele-list">
            {data.mirrors.map((m) => (
              <li key={m.id}>
                <details className="tele-card tele-mirror">
                  <summary>
                    <span className={`tele-dot ${m.lastError ? 'off' : m.enabled ? 'on' : ''}`} />
                    <span className="grow">
                      <b>{m.chatTitle || m.title}</b>
                      <small>
                        {m.handle && <span dir="ltr">@{m.handle}</span>} {m.kind === 'group' ? '· گروه ' : ''}· {toFa(m.members)} عضو
                        {m.enabled ? '' : ' · متوقف'}
                      </small>
                    </span>
                  </summary>
                  <div className="tele-card-body">
                    <small className="muted">
                      از تلگرام: {m.title} · {m.lastRunAt ? `آخرین بررسی: ${formatDateTime(m.lastRunAt)}` : 'هنوز بررسی نشده'}
                    </small>
                    {m.lastError && <small className="tele-warn">{m.lastError}</small>}
                    <label>
                      چه کسانی ببینند
                      <select value={m.visibility} disabled={busy} onChange={(e) => act(() => patchMirror(m.id, { visibility: e.target.value }), 'ذخیره شد')}>
                        {Object.entries(VIS_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {m.visibility === 'link' && m.inviteCode && (
                      <span className="inline-form tele-invite">
                        <input readOnly dir="ltr" value={inviteLink(m.inviteCode)} onFocus={(e) => e.target.select()} />
                        <button type="button" className="btn sm" onClick={() => copy(inviteLink(m.inviteCode))}>
                          <Copy size={14} /> کپی
                        </button>
                        <QrButton value={inviteLink(m.inviteCode)} title="کد QR لینک دعوت" />
                        <button type="button" className="btn sm" disabled={busy} onClick={async () => (await confirmDialog({ title: 'لینک دعوت جدید ساخته شود؟', message: 'لینک قبلی دیگر کار نمی‌کند. کسانی که عضو شده‌اند می‌مانند.', confirmLabel: 'ساخت لینک جدید' })) && act(() => newMirrorInvite(m.id), 'لینک تازه ساخته شد')}>
                          لینک تازه
                        </button>
                      </span>
                    )}
                    <div className="tele-perms">
                      <label className="check">
                        <input type="checkbox" checked={m.withPhotos} onChange={() => act(() => patchMirror(m.id, { withPhotos: !m.withPhotos }))} /> عکس
                      </label>
                      <label className="check">
                        <input type="checkbox" checked={m.withFiles} onChange={() => act(() => patchMirror(m.id, { withFiles: !m.withFiles }))} /> ویدیو و فایل
                      </label>
                    </div>
                    <div className="tele-actions">
                      <button className="btn sm" disabled={busy} onClick={() => act(() => patchMirror(m.id, { enabled: !m.enabled }))}>
                        {m.enabled ? 'توقف' : 'ادامه'}
                      </button>
                      <button className="btn sm danger" disabled={busy} onClick={async () => (await confirmDialog({ title: 'انتشار این کانال متوقف و حذف شود؟', message: 'کانال برنامه و پست‌هایش می‌مانند.', confirmLabel: 'حذف', danger: true })) && act(() => deleteMirror(m.id))}>
                        <Trash2 size={14} /> حذف انتشار
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {!data.mirrors.length && <EmptyState compact icon={<Rss size={32} />} title="هنوز کانال یا گروهی منتشر نمی‌شود." />}
          <details className="tele-group">
            <summary>تنظیمات انتشار</summary>
            <label className="inline-form">
              بررسی پست‌های جدید هر
              <input
                type="number"
                min={1}
                max={1440}
                dir="ltr"
                className="num-input"
                defaultValue={data.minutes}
                key={`m-${data.minutes}`}
                onBlur={(e) => {
                  const n = Math.max(1, Math.min(1440, Math.round(Number(e.target.value)) || 5));
                  if (n !== data.minutes) act(() => saveMirrorSettings(n), 'ذخیره شد');
                }}
              />
              دقیقه
            </label>
          </details>
        </>
      )}
    </div>
  );
}
