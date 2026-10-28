import { useEffect, useState } from 'react';
import { Bell, BellOff, Play, FileText, Mic, Link as LinkIcon, Image as ImageIcon } from 'lucide-react';
import { api, fileUrl } from '../api';
import { useStore } from '../store';
import { isChatMuted } from '../socket';
import { formatDay, formatDateTime, formatSize, formatClock, toFa } from '../util';
import { Modal, openMessage } from './Modals';
import Avatar from './Avatar';

// ---------- Per-chat notification mute (mine only; @mentions still notify) ----------
const NOTIFY_OPTIONS = [
  ['۱ ساعت', 3600e3],
  ['۸ ساعت', 8 * 3600e3],
  ['۱ روز', 86400e3],
  ['۱ هفته', 7 * 86400e3],
  ['همیشه', -1],
];

export function NotifyMute({ chat }) {
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const muted = isChatMuted(chat);
  const set = async (v) => {
    setOpen(false);
    try {
      const r = await api('PATCH', `/chats/${chat.id}/notify`, { mutedUntil: v === -1 || v == null ? v : Date.now() + v });
      useStore.getState().upsertChat({ ...chat, notifyMutedUntil: r.notifyMutedUntil });
    } catch (e) {
      showToast(e.message);
    }
  };
  const forever = muted && chat.notifyMutedUntil > Date.now() + 50 * 365 * 86400e3;
  return (
    <div className="notify-mute">
      <button className="row-item" onClick={() => (muted ? set(null) : setOpen(!open))}>
        {muted ? <BellOff size={20} /> : <Bell size={20} />}
        <span className="grow">
          <b>{muted ? 'اعلان‌ها خاموش است' : 'اعلان‌ها روشن است'}</b>
          <small className="muted">
            {muted
              ? `${forever ? 'برای همیشه' : `تا ${formatDateTime(chat.notifyMutedUntil)}`} · منشن‌ها و پاسخ به شما همچنان خبر می‌دهند. برای روشن کردن بزنید.`
              : 'برای بی‌صدا کردن این گفتگو بزنید'}
          </small>
        </span>
      </button>
      {open && (
        <div className="chips">
          {NOTIFY_OPTIONS.map(([label, v]) => (
            <button key={label} className="chip-btn" onClick={() => set(v)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Shared media / files / voice / links of one chat ----------
const TABS = [
  ['media', 'عکس و ویدیو', ImageIcon],
  ['files', 'فایل', FileText],
  ['voice', 'صدا', Mic],
  ['links', 'لینک', LinkIcon],
];
const URL_RE = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"،؛]/g;

export function MediaGallery({ chatId }) {
  const [kind, setKind] = useState('media');
  const [items, setItems] = useState(null);
  const [more, setMore] = useState(false);
  const openModal = useStore((s) => s.openModal);

  const load = (before) =>
    api('GET', `/chats/${chatId}/media?kind=${kind}${before ? `&before=${before}` : ''}`)
      .then((r) => {
        setItems((prev) => (before ? [...(prev || []), ...r.messages] : r.messages));
        setMore(r.messages.length === 60);
      })
      .catch(() => setItems([]));
  useEffect(() => {
    setItems(null);
    load();
  }, [chatId, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="gallery">
      <div className="tabs scroll">
        {TABS.map(([k, label, Icon]) => (
          <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      {!items && <p className="muted center">…</p>}
      {items?.length === 0 && <p className="muted center">چیزی اینجا نیست</p>}
      {kind === 'media' && items?.length > 0 && (
        <div className="gallery-grid">
          {items.map((m) => (
            <button
              key={m.id}
              className="gallery-cell"
              title={formatDay(m.createdAt)}
              onClick={() => (m.type === 'image' ? openModal('image', { fileId: m.file.id, name: m.file.name }) : openMessage(m))}
            >
              {m.type === 'image' ? (
                <img src={fileUrl(m.file.id)} alt="" loading="lazy" />
              ) : m.file.thumb ? (
                <img src={`${fileUrl(m.file.id)}?thumb=1`} alt="" loading="lazy" />
              ) : (
                <span className="gallery-video" />
              )}
              {m.type === 'video' && (
                <span className="gallery-badge">
                  <Play size={12} /> {m.file.duration ? formatClock(Math.round(m.file.duration)) : ''}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {kind !== 'media' && items?.length > 0 && (
        <ul className="gallery-list">
          {items.map((m) => {
            const links = kind === 'links' ? [...new Set(m.text.match(URL_RE) || [])] : [];
            return (
              <li key={m.id}>
                {kind === 'links' ? (
                  links.map((l) => (
                    <a key={l} href={l} target="_blank" rel="noopener noreferrer" dir="ltr" className="gallery-link">
                      {l}
                    </a>
                  ))
                ) : (
                  <button className="row-item" onClick={() => openMessage(m)}>
                    {kind === 'voice' ? <Mic size={20} /> : <FileText size={20} />}
                    <span className="grow">
                      <b>{kind === 'voice' ? m.sender?.displayName || 'پیام صوتی' : m.file?.name}</b>
                      <small className="muted">
                        {kind === 'voice' && m.file?.duration ? formatClock(Math.round(m.file.duration)) + ' · ' : ''}
                        {formatSize(m.file?.size)} · {formatDay(m.createdAt)}
                      </small>
                    </span>
                  </button>
                )}
                {kind === 'links' && (
                  <button className="link-btn muted tiny" onClick={() => openMessage(m)}>
                    {m.sender?.displayName} · {formatDay(m.createdAt)} — رفتن به پیام
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <button className="btn wide" onClick={() => load(items.at(-1).id)}>
          بیشتر
        </button>
      )}
    </div>
  );
}

// ---------- "Seen by" for a message in a group / channel ----------
export function Readers({ message, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);
  useEffect(() => {
    api('GET', `/messages/${message.id}/readers`)
      .then(setData)
      .catch((e) => (showToast(e.message), onClose()));
  }, [message.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="دیده‌شده توسط" onClose={onClose} size="small">
      {!data && <p className="muted center">…</p>}
      {data && (
        <>
          <p className="muted">
            {toFa(data.readers.length)} نفر از {toFa(data.total)} عضو این پیام را دیده‌اند
          </p>
          <ul className="user-list">
            {data.readers.map((u) => (
              <li key={u.id} className="row-item">
                <Avatar id={u.id} name={u.displayName} file={u.avatar} size={34} />
                <span className="grow">
                  <b>{u.displayName}</b>
                  <small dir="ltr">@{u.username}</small>
                </span>
              </li>
            ))}
          </ul>
          {!data.readers.length && <p className="muted center">هنوز کسی ندیده</p>}
        </>
      )}
    </Modal>
  );
}
