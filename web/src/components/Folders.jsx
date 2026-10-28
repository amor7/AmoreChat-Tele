import { useLayoutEffect, useRef, useState } from 'react';
import { Pin, PinOff, Bell, BellOff, CheckCheck, FolderPlus, Settings2, Trash2, ArrowUp, ArrowDown, Plus, Check } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { isChatMuted } from '../socket';
import { Modal } from './Modals';
import { useBackClose } from '../backnav';
import Avatar from './Avatar';

export const FOLDER_TYPES = [
  ['dms', 'گفتگوهای خصوصی'],
  ['groups', 'گروه‌ها'],
  ['channels', 'کانال‌ها'],
  ['voice', 'کانال‌های صوتی'],
  ['unread', 'خوانده‌نشده‌ها'],
];

export function inFolder(folder, c) {
  if (!folder) return c.type !== 'voice';
  if (folder.chatIds.includes(c.id)) return true;
  const f = folder.filters;
  return (
    (f.includes('dms') && (c.type === 'dm' || c.type === 'saved')) ||
    (f.includes('groups') && c.type === 'group') ||
    (f.includes('channels') && c.type === 'channel') ||
    (f.includes('voice') && c.type === 'voice') ||
    (f.includes('unread') && c.unread > 0)
  );
}

// Emergency channel first, then pinned (in pin order), then by latest activity.
export function sortChats(a, b) {
  if (a.isEmergency !== b.isEmergency) return a.isEmergency ? -1 : 1;
  if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
  if (a.pinnedAt && b.pinnedAt) return a.pinnedAt - b.pinnedAt;
  return (b.lastMessage?.createdAt || b.createdAt) - (a.lastMessage?.createdAt || a.createdAt);
}

// ---------- Tabs above the chat list ----------
export function FolderTabs({ value, onChange }) {
  const folders = useStore((s) => s.folders);
  const chats = useStore((s) => s.chats);
  const openModal = useStore((s) => s.openModal);
  if (!folders.length) return null;
  const unread = (f) => Object.values(chats).filter((c) => inFolder(f, c) && c.unread > 0).length;
  const tab = (f, label) => {
    const n = unread(f);
    return (
      <button key={f?.id || 'all'} className={(value || null) === (f?.id || null) ? 'active' : ''} onClick={() => onChange(f?.id || null)}>
        {label}
        {n > 0 && <span className="tab-badge">{n}</span>}
      </button>
    );
  };
  return (
    <div className="folder-tabs">
      {tab(null, 'همه')}
      {folders.map((f) => tab(f, `${f.emoji ? f.emoji + ' ' : ''}${f.name}`))}
      <button className="folder-edit" aria-label="مدیریت پوشه‌ها" onClick={() => openModal('folders')}>
        <Settings2 size={16} />
      </button>
    </div>
  );
}

// ---------- Long-press / right-click menu of a chat in the list ----------
export function ChatMenu({ chat, x, y, onClose }) {
  const folders = useStore((s) => s.folders);
  const showToast = useStore((s) => s.showToast);
  const openModal = useStore((s) => s.openModal);
  const ref = useRef(null);
  const openedAt = useRef(Date.now());
  useBackClose(true, onClose);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);
  const close = (e) => {
    e?.preventDefault?.();
    if (Date.now() - openedAt.current > 450) onClose();
  };
  const run = (fn) => async () => {
    onClose();
    try {
      await fn();
    } catch (e) {
      showToast(e.message);
    }
  };
  const upsert = (r) => r?.chat && useStore.getState().upsertChat(r.chat);
  const muted = isChatMuted(chat);

  return (
    <>
      <div className="menu-backdrop" onClick={close} onContextMenu={close} />
      <div className="menu floating" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
        <button onClick={run(async () => upsert(await api('PATCH', `/chats/${chat.id}/pin`, { pinned: !chat.pinnedAt })))}>
          {chat.pinnedAt ? <PinOff size={17} /> : <Pin size={17} />} {chat.pinnedAt ? 'برداشتن سنجاق' : 'سنجاق بالای لیست'}
        </button>
        {chat.type !== 'saved' && (
          <button
            onClick={run(async () => {
              const r = await api('PATCH', `/chats/${chat.id}/notify`, { mutedUntil: muted ? null : -1 });
              useStore.getState().upsertChat({ ...chat, notifyMutedUntil: r.notifyMutedUntil });
            })}
          >
            {muted ? <Bell size={17} /> : <BellOff size={17} />} {muted ? 'روشن کردن اعلان' : 'بی‌صدا'}
          </button>
        )}
        {chat.unread > 0 && (
          <button onClick={run(async () => upsert(await api('POST', `/chats/${chat.id}/read-all`)))}>
            <CheckCheck size={17} /> خوانده شد
          </button>
        )}
        {folders.map((f) => {
          const inside = f.chatIds.includes(chat.id);
          return (
            <button
              key={f.id}
              onClick={run(() => api('PATCH', `/folders/${f.id}`, { chatIds: inside ? f.chatIds.filter((id) => id !== chat.id) : [...f.chatIds, chat.id] }))}
            >
              {inside ? <Check size={17} /> : <FolderPlus size={17} />} {inside ? 'در پوشه' : 'افزودن به'} «{f.name}»
            </button>
          );
        })}
        <button onClick={run(() => openModal('folderEdit', { folder: null, chatIds: [chat.id] }))}>
          <Plus size={17} /> پوشه جدید با این گفتگو
        </button>
      </div>
    </>
  );
}

// ---------- Manage folders ----------
export function FoldersModal({ onClose }) {
  const folders = useStore((s) => s.folders);
  const openModal = useStore((s) => s.openModal);
  const showToast = useStore((s) => s.showToast);
  const move = async (i, d) => {
    const ids = folders.map((f) => f.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    useStore.setState({ folders: ids.map((id) => folders.find((f) => f.id === id)) });
    await api('PUT', '/folders/order', { ids }).catch((e) => showToast(e.message));
  };
  return (
    <Modal title="پوشه‌های گفتگو" onClose={onClose} size="small">
      <p className="hint">گفتگوها را در پوشه‌ها دسته‌بندی کنید (مثلاً کار، خانواده، کانال‌ها). هر پوشه یک زبانه بالای لیست گفتگوها می‌شود.</p>
      <ul className="folder-list">
        {folders.map((f, i) => (
          <li key={f.id}>
            <button className="grow row-item" onClick={() => openModal('folderEdit', { folder: f })}>
              {f.emoji} <b>{f.name}</b>
            </button>
            <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="بالا">
              <ArrowUp size={16} />
            </button>
            <button className="icon-btn" disabled={i === folders.length - 1} onClick={() => move(i, 1)} aria-label="پایین">
              <ArrowDown size={16} />
            </button>
          </li>
        ))}
      </ul>
      <button className="btn primary wide" onClick={() => openModal('folderEdit', { folder: null })}>
        <Plus size={17} /> پوشه جدید
      </button>
    </Modal>
  );
}

const EMOJIS = ['💼', '🏠', '👨‍👩‍👧', '📢', '🎮', '📚', '⭐', '❤️', '🔔', '🛒', '⚽', '🎵'];

export function FolderEditor({ folder, chatIds: initialChats = [], onClose }) {
  const chats = useStore((s) => s.chats);
  const showToast = useStore((s) => s.showToast);
  const [name, setName] = useState(folder?.name || '');
  const [emoji, setEmoji] = useState(folder?.emoji || '');
  const [filters, setFilters] = useState(folder?.filters || []);
  const [ids, setIds] = useState(folder?.chatIds || initialChats);
  const [q, setQ] = useState('');
  const toggle = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const all = Object.values(chats)
    .filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()))
    .sort(sortChats);

  async function save() {
    try {
      const body = { name, emoji, filters, chatIds: ids };
      if (folder) await api('PATCH', `/folders/${folder.id}`, body);
      else await api('POST', '/folders', body);
      await useStore.getState().loadFolders();
      onClose();
    } catch (e) {
      showToast(e.message);
    }
  }
  async function remove() {
    if (!confirm(`پوشه «${folder.name}» حذف شود؟ (گفتگوها حذف نمی‌شوند)`)) return;
    await api('DELETE', `/folders/${folder.id}`).catch((e) => showToast(e.message));
    await useStore.getState().loadFolders();
    onClose();
  }

  return (
    <Modal title={folder ? 'ویرایش پوشه' : 'پوشه جدید'} onClose={onClose}>
      <div className="form">
        <label>
          نام پوشه
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="مثلاً کار" autoFocus />
        </label>
        <div className="emoji-row">
          {EMOJIS.map((e) => (
            <button key={e} className={emoji === e ? 'active' : ''} onClick={() => setEmoji(emoji === e ? '' : e)}>
              {e}
            </button>
          ))}
        </div>
        <b>همه‌ی این نوع‌ها:</b>
        {FOLDER_TYPES.map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={filters.includes(k)} onChange={() => toggle(filters, setFilters, k)} />
            {label}
          </label>
        ))}
        <b>و این گفتگوها:</b>
        <input placeholder="جستجو" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="user-list folder-chats">
          {all.map((c) => (
            <li key={c.id}>
              <label className="row-item check-row">
                <input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggle(ids, setIds, c.id)} />
                <Avatar id={c.id} name={c.title} file={c.avatar} saved={c.type === 'saved'} size={32} />
                <span className="grow">{c.title}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className="actions sticky-actions">
        {folder && (
          <button className="btn danger" onClick={remove}>
            <Trash2 size={16} /> حذف پوشه
          </button>
        )}
        <button className="btn primary" onClick={save} disabled={!name.trim() || (!filters.length && !ids.length)}>
          ذخیره
        </button>
      </div>
    </Modal>
  );
}
