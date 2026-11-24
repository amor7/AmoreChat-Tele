import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import { toFa } from '../util';
import { useLoad } from './AdminPanelsA1';
import { confirmDialog, promptDialog, isolate } from '../confirm';

// The names kept from everyone: release one, give it to a user, or add more.
export default function AdminHandles() {
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [data, load] = useLoad(`/admin/handles?q=${encodeURIComponent(q)}`);

  const run = async (fn, ok) => {
    try {
      await fn();
      showToast(ok);
      load();
    } catch (e) {
      showToast(e.message);
    }
  };
  const gift = async (handle) => {
    const username = await promptDialog({
      title: `${isolate(`@${handle}`)} به چه کسی هدیه داده شود؟`,
      message: 'این شناسه جای نام کاربری فعلی‌اش می‌نشیند و از این پس با آن وارد می‌شود.',
      label: 'نام کاربری فعلی او',
      confirmLabel: 'هدیه',
      required: true,
    });
    if (username) run(() => api('POST', `/admin/handles/${handle}/gift`, { username }), `@${handle} به او داده شد`);
  };

  return (
    <>
      <p className="hint">این شناسه‌ها را هیچ کاربری نمی‌تواند بگیرد. می‌توانید آزادشان کنید، یا به کاربر خاصی بدهید تا جای نام کاربری‌اش بنشیند.</p>
      <input placeholder={`جستجو در ${data ? toFa(data.total) : ''} شناسه…`} value={q} onChange={(e) => setQ(e.target.value)} dir="auto" />
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => api('POST', '/admin/handles', { handle: name }), 'به لیست اضافه شد').then(() => setName(''));
        }}
      >
        <input placeholder="شناسه جدید برای رزرو" value={name} onChange={(e) => setName(e.target.value)} dir="ltr" />
        <button className="btn sm primary" disabled={!name.trim()}>
          رزرو
        </button>
      </form>
      <ul className="user-list">
        {data?.names.map((n) => (
          <li key={n.handle} className="row-item">
            <span className="grow">
              <b dir="ltr">@{n.handle}</b>
              {n.inUse && <small className="muted">کاربری از قبل این نام را دارد</small>}
            </span>
            {!n.inUse && (
              <button className="btn sm" onClick={() => gift(n.handle)}>
                هدیه به کاربر
              </button>
            )}
            <button className="btn sm" onClick={async () => (await confirmDialog({ title: `${isolate(`@${n.handle}`)} برای همه آزاد شود؟`, confirmLabel: 'آزاد کردن' })) && run(() => api('DELETE', `/admin/handles/${n.handle}`), 'آزاد شد')}>
              آزاد کردن
            </button>
          </li>
        ))}
      </ul>
      {data?.kept.length > 0 && (
        <>
          <h4>شناسه‌های اصلی کانال‌های تلگرام</h4>
          <ul className="user-list">
            {data.kept.map((k) => (
              <li key={k.handle} className="row-item">
                <span className="grow">
                  <b dir="ltr">@{k.handle}</b>
                  <small className="muted" dir="auto">
                    {k.title} (@{k.chatHandle})
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
