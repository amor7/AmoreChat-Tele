import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { formatDateTime, formatSize, toFa, copyText } from '../util';
import { DatabaseBackup, Download, Megaphone, Volume2, Users as UsersIcon } from 'lucide-react';
import { useLoad } from './AdminPanelsA1';
import { QrButton } from './QrCode';
import { confirmDialog, promptDialog, isolate } from '../confirm';
import { Skeleton, ErrorState, EmptyState } from './States';

export function Backups() {
  const showToast = useStore((s) => s.showToast);
  const [data, load, error] = useLoad('/admin/backups');
  const [busy, setBusy] = useState(false);
  if (!data) return error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={4} />;
  return (
    <div className="backup-tab">
      <p className="hint">
        پشتیبان شامل همه‌ی پیام‌ها، کاربران و هش رمزهاست؛ فایلش را جای امن نگه دارید. سرور هر روز خودکار یک نسخه از دیتابیس می‌گیرد.
      </p>
      <div className="backup-cards">
        <a className="backup-card" href="/api/admin/backup/db" download>
          <DatabaseBackup size={26} />
          <b>دیتابیس (پیام‌ها و تنظیمات)</b>
          <small>حدود {formatSize(data.dbSize)} · سریع</small>
        </a>
        <a className="backup-card" href="/api/admin/backup/full" download>
          <Download size={26} />
          <b>پشتیبان کامل (دیتابیس + همه‌ی فایل‌ها)</b>
          <small>حدود {formatSize(data.dbSize + data.uploadsSize)} · فایل tar</small>
        </a>
      </div>
      <h4>نسخه‌های خودکار روزانه</h4>
      <button
        className="btn sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api('POST', '/admin/backups', null, { timeout: 15 * 60000 });
            load();
          } catch (e) {
            showToast(e.message);
          }
          setBusy(false);
        }}
      >
        ساخت نسخهٔ جدید روی سرور
      </button>
      <ul className="backup-list">
        {data.files.map((f) => (
          <li key={f.name}>
            <span className="grow">
              {formatDateTime(f.createdAt)} <small className="muted">· {formatSize(f.size)}</small>
              {f.check && <small className={f.check.ok ? 'ok' : 'tele-warn'}> · {f.check.ok ? `سالم، ${toFa(f.check.messages)} پیام` : `خراب: ${f.check.error}`}</small>}
            </span>
            <button
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('POST', `/admin/backups/${f.name}/check`, {}, { timeout: 30 * 60000 });
                  load();
                } catch (e) {
                  showToast(e.message);
                }
                setBusy(false);
              }}
            >
              بررسی
            </button>
            <button
              className="btn sm danger"
              disabled={busy}
              onClick={async () => {
                const password = await promptDialog({
                  title: `همه چیز به ${formatDateTime(f.createdAt)} برگردد؟`,
                  message: 'پیام‌های بعد از آن از بین می‌رود؛ فایل‌های آپلودی پاک نمی‌شوند. برنامه حدود یک دقیقه در دسترس نیست و شاید دوباره باید وارد شوید.',
                  label: 'رمز عبور خودتان',
                  type: 'password',
                  confirmLabel: 'بازگردانی',
                  required: true,
                  danger: true,
                });
                if (!password) return;
                setBusy(true);
                try {
                  await api('POST', `/admin/backups/${f.name}/restore`, { password }, { timeout: 30 * 60000 });
                  showToast('در حال بازگردانی…');
                  setTimeout(() => location.reload(), 45000);
                } catch (e) {
                  showToast(e.message);
                  setBusy(false);
                }
              }}
            >
              بازگردانی
            </button>
            <a className="btn sm" href={`/api/admin/backups/${f.name}`} download>
              <Download size={15} /> دانلود
            </a>
          </li>
        ))}
      </ul>
      {!data.files.length && <EmptyState compact hint="هنوز نسخه‌ای ساخته نشده" />}
      <details className="hint">
        <summary>بازگردانی پشتیبان روی سرور</summary>
        <p>روی سرور: برنامه را متوقف کنید، فایل را جای data/amorechat.db بگذارید (و برای پشتیبان کامل پوشهٔ uploads را هم از tar باز کنید) و دوباره اجرا کنید. جزئیات در README.</p>
      </details>
    </div>
  );
}

export function Invites() {
  const showToast = useStore((s) => s.showToast);
  const [data, load, error] = useLoad('/admin/invites');
  const [f, setF] = useState({ maxUses: '1', expiresInHours: '72', note: '' });
  const link = (code) => `${location.origin}/#/invite/${code}`;

  async function create(e) {
    e.preventDefault();
    try {
      const { invite } = await api('POST', '/admin/invites', f);
      (await copyText(link(invite.code))) && showToast('لینک دعوت ساخته و کپی شد');
      load();
    } catch (err) {
      showToast(err.message);
    }
  }

  return (
    <>
      <form className="inline-form boxed" onSubmit={create}>
        <input placeholder="یادداشت (مثلاً: برای علی)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <input type="number" min="0" placeholder="تعداد استفاده (۰=نامحدود)" value={f.maxUses} onChange={(e) => setF({ ...f, maxUses: e.target.value })} />
        <input type="number" min="0" placeholder="اعتبار به ساعت (۰=همیشه)" value={f.expiresInHours} onChange={(e) => setF({ ...f, expiresInHours: e.target.value })} />
        <button className="btn primary sm">ساخت کد دعوت</button>
      </form>
      <ul className="user-list">
        {data?.invites.map((i) => {
          const expired = (i.expires_at && i.expires_at < Date.now()) || (i.max_uses && i.uses >= i.max_uses);
          return (
            <li key={i.id} className={`row-item ${expired ? 'faded' : ''}`}>
              <span className="grow">
                <code dir="ltr">{i.code}</code> {i.note && <b>{i.note}</b>}
                <small>
                  {toFa(i.uses)}
                  {i.max_uses ? `/${toFa(i.max_uses)}` : ''} استفاده
                  {i.expires_at ? ` · انقضا ${formatDateTime(i.expires_at)}` : ''}
                  {i.creator ? ` · ${i.creator}` : ''}
                </small>
              </span>
              {!expired && (
                <button className="btn sm" onClick={async () => (await copyText(link(i.code))) && showToast('کپی شد')}>
                  کپی لینک
                </button>
              )}
              {!expired && <QrButton value={link(i.code)} title="کد QR لینک دعوت" />}
              <button className="btn sm danger" onClick={() => api('DELETE', `/admin/invites/${i.id}`).then(load)}>
                حذف
              </button>
            </li>
          );
        })}
      </ul>
      {!data && (error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={3} />)}
      {data && !data.invites.length && <EmptyState compact hint="هنوز کد دعوتی ساخته نشده" />}
    </>
  );
}

const CHAT_KINDS = [
  ['all', 'همه'],
  ['group', 'گروه'],
  ['channel', 'کانال'],
  ['voice', 'کانال صوتی'],
];

export function Chats({ onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [data, load, error] = useLoad('/admin/chats');
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const list = (data?.chats || []).filter((c) => (kind === 'all' || c.type === kind) && (!q || `${c.title} ${c.handle} ${c.ownerName} ${c.ownerUsername}`.toLowerCase().includes(q.toLowerCase().replace(/^@/, ''))));
  const open = (c) => {
    onClose();
    useStore.getState().openModal('chatInfo', { chatId: c.id });
  };
  return (
    <>
      <input placeholder="جستجوی نام، شناسه یا مالک…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips admin-kinds">
        {CHAT_KINDS.map(([k, label]) => (
          <button key={k} className={`chip-btn ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>
            {label} {data && <small>({toFa(k === 'all' ? data.chats.length : data.chats.filter((c) => c.type === k).length)})</small>}
          </button>
        ))}
      </div>
      <p className="hint">هر گروه، کانال یا کانال صوتی را می‌توانید از همین‌جا برای همه حذف کنید، بدون اینکه عضو یا ادمین آن شوید.</p>
      <ul className="user-list">
        {list.map((c) => (
          <li key={c.id} className="row-item">
            <span className="grow">
              <b>
                {c.type === 'channel' ? <Megaphone size={15} /> : c.type === 'voice' ? <Volume2 size={15} /> : <UsersIcon size={15} />}{' '}
                {c.title} {c.fromTelegram && <span className="tag">کپی از تلگرام</span>}
              </b>
              <small>
                مالک: {c.ownerName ? `${c.ownerName} (@${c.ownerUsername})` : 'ندارد'}
                {c.handle && ` · @${c.handle}`}
              </small>
              <small>
                {toFa(c.memberCount)} عضو · {toFa(c.messageCount)} پیام · {c.isPublic ? 'عمومی' : 'خصوصی'}
                {!c.isMember && ' · شما عضو نیستید'}
              </small>
            </span>
            {c.isMember && useStore.getState().chats[c.id] && (
              <button className="btn sm" onClick={() => open(c)}>
                اطلاعات
              </button>
            )}
            {!c.isEmergency && (
              <button
                className="btn sm danger"
                onClick={async () =>
                  (await confirmDialog({ title: `«${isolate(c.title)}» برای همه حذف شود؟`, confirmLabel: 'حذف', danger: true })) &&
                  api('DELETE', `/chats/${c.id}`)
                    .then(load)
                    .catch((e) => showToast(e.message))
                }
              >
                حذف
              </button>
            )}
          </li>
        ))}
      </ul>
      {!data && (error ? <ErrorState message={error} onRetry={load} /> : <Skeleton lines={4} />)}
      {data && !list.length && <EmptyState compact hint={data.chats.length ? 'گفتگویی پیدا نشد' : 'هنوز گروه یا کانالی ساخته نشده'} />}
    </>
  );
}
