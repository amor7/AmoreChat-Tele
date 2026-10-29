import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { toFa, postBlockReason } from '../util';
import { Modal } from './Modals';
import Avatar from './Avatar';

// Forwarding between Telegram and the app's own chats (both ways). Photos and voice go along only
// for users an admin allowed them; otherwise the text (and the file's name) is sent.

const num = (id) => Math.abs(Number(String(id || '').replace(/^[uc]/, '')) || 0);

/** A Telegram message → chats of this app. */
export function TeleToChat({ message, onClose }) {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const showToast = useStore((s) => s.showToast);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);

  const list = Object.values(chats)
    .filter((c) => !postBlockReason(me, c))
    .filter((c) => !q.trim() || c.title.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (a.type === 'saved' ? -1 : b.type === 'saved' ? 1 : (b.lastMessage?.id || 0) - (a.lastMessage?.id || 0)));

  async function send() {
    setBusy(true);
    try {
      const { sent } = await api('POST', `/tele/messages/${message.id}/forward`, { chatIds: picked }, { timeout: 120000 });
      showToast(`به ${toFa(sent.length)} گفتگو فرستاده شد`);
      onClose();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  }

  return (
    <Modal title="ارسال پیام تلگرام به…" onClose={onClose}>
      <p className="hint">{(message.text || '').split('\n')[0].slice(0, 120)}</p>
      <input placeholder="جستجو" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="user-list">
        {list.map((c) => (
          <li key={c.id}>
            <label className="row-item check-row">
              <input
                type="checkbox"
                checked={picked.includes(c.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))}
                disabled={!picked.includes(c.id) && picked.length >= 20}
              />
              <Avatar id={c.id} name={c.title} file={c.avatar} saved={c.type === 'saved'} size={36} />
              <span className="grow">{c.title}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="actions sticky-actions">
        <button className="btn" onClick={onClose}>
          انصراف
        </button>
        <button className="btn primary" disabled={!picked.length || busy} onClick={send}>
          {busy ? 'در حال ارسال…' : `ارسال${picked.length ? ` (${toFa(picked.length)})` : ''}`}
        </button>
      </div>
    </Modal>
  );
}

/** A message of this app → the user's Telegram chats (the ones they added). */
export function ChatToTele({ message, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [status, setStatus] = useState(null);
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('GET', '/tele/status')
      .then(setStatus)
      .catch((e) => showToast(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = status?.account?.status === 'connected';
  const dialogs = (status?.dialogs || []).filter((d) => d.selected && d.kind !== 'channel');

  async function send() {
    setBusy(true);
    try {
      const { sent } = await api('POST', '/tele/forward', { messageId: message.id, dialogIds: picked }, { timeout: 120000 });
      showToast(`به ${toFa(sent.length)} گفتگوی تلگرام فرستاده شد`);
      onClose();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  }

  return (
    <Modal title="ارسال به تلگرام" onClose={onClose}>
      {!status && <p className="muted">…</p>}
      {status && !connected && (
        <p className="hint">
          حساب تلگرام شما وصل نیست. از منو ← <a href="#/tele" onClick={onClose}>تلگرام</a> وارد شوید.
        </p>
      )}
      {connected && !dialogs.length && <p className="hint">هنوز گفتگویی در بخش تلگرام اضافه نکرده‌اید.</p>}
      {connected && !!dialogs.length && (
        <ul className="user-list">
          {dialogs.map((d) => (
            <li key={d.id}>
              <label className="row-item check-row">
                <input
                  type="checkbox"
                  checked={picked.includes(d.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))}
                  disabled={!picked.includes(d.id) && picked.length >= 10}
                />
                <Avatar id={num(d.tgChatId)} name={d.title} size={36} />
                <span className="grow">{d.title || 'بدون نام'}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="actions sticky-actions">
        <button className="btn" onClick={onClose}>
          انصراف
        </button>
        {connected && (
          <button className="btn primary" disabled={!picked.length || busy} onClick={send}>
            {busy ? 'در حال ارسال…' : `ارسال${picked.length ? ` (${toFa(picked.length)})` : ''}`}
          </button>
        )}
      </div>
    </Modal>
  );
}
