import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderTabs, ChatMenu, inFolder, sortChats } from './Folders';
import { useBackClose } from '../backnav';
import { MessageResults, openMessage } from './Modals';
import { VoiceChannels } from './Voice';
import { RichText } from './Emoji';
import PreviewIcon from './PreviewIcon';
import { Menu, SquarePen, UserRound, Compass, Shield, LogOut, Users, Megaphone, Volume2, BellOff, Pin, FolderPlus, Server, Plus, Cable } from 'lucide-react';
import { useStore } from '../store';
import { api } from '../api';
import { disconnectSocket, isChatMuted } from '../socket';
import { clearOffline } from '../offline';
import { formatListTime, messagePreview, toFa, hasSitePerm } from '../util';
import Avatar from './Avatar';
import Ping from './Ping';

export default function Sidebar() {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const activeChatId = useStore((s) => s.activeChatId);
  const siteName = useStore((s) => s.config?.siteName || 'AmoreChat');
  const multiServer = useStore((s) => s.multiServer);
  const openModal = useStore((s) => s.openModal);
  const logout = async () => {
    try { await api('POST', '/auth/logout'); } catch {}
    disconnectSocket();
    clearOffline();
    useStore.getState().setMe(null);
    location.hash = '#/';
  };
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [found, setFound] = useState(null);
  const folders = useStore((s) => s.folders);
  const [folderId, setFolderId] = useState(() => {
    try { return Number(localStorage.getItem('amorechat:folder')) || null; } catch { return null; }
  });
  const pickFolder = (id) => {
    setFolderId(id);
    try { localStorage.setItem('amorechat:folder', id || ''); } catch {}
  };
  const folder = folders.find((f) => f.id === folderId) || null;
  const [chatMenu, setChatMenu] = useState(null);
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const hasAnyAdminPerm = (u) => u.role === 'owner' || (u.adminPerms && u.adminPerms.length > 0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setFound(null);
    const t = setTimeout(() => {
      api('GET', `/search?q=${encodeURIComponent(q)}`).then((r) => setFound(r.messages)).catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => c.type !== 'dm' || c.lastMessage || c.id === activeChatId)
      .filter((c) => (q ? true : inFolder(folder, c)))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.peer?.username?.toLowerCase().includes(q))
      .sort(sortChats);
  }, [chats, query, folder, activeChatId]);

  const item = (label, onClick) => (
    <button type="button" onClick={() => { setMenu(false); onClick(); }}>{label}</button>
  );

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label="منو"><Menu size={20} /></button>
        <input className="search" placeholder="جستجو…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {menu && (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(false)} />
            <div className="menu">
              <div className="menu-user">
                <Avatar id={me.id} name={me.displayName} file={me.avatar} size={40} />
                <div><b>{me.displayName}</b><small dir="ltr">@{me.username}</small></div>
              </div>
              {item(<><UserRound size={18} /> پروفایل و تنظیمات</>, () => openModal('profile'))}
              {item(<><Cable size={18} /> Tele (تلگرام)</>, () => openModal('tele'))}
              {item(<><SquarePen size={18} /> گفتگوی جدید</>, () => openModal('newChat'))}
              {item(<><Compass size={18} /> کاوش گروه‌ها و کانال‌ها</>, () => openModal('discover'))}
              {item(<><FolderPlus size={18} /> پوشه‌های گفتگو</>, () => openModal('folders'))}
              {isAdmin && hasAnyAdminPerm(me) && item(<><Shield size={18} /> پنل مدیریت</>, () => openModal('admin'))}
              {item(<><LogOut size={18} /> خروج</>, logout)}
            </div>
          </>
        )}
      </header>
      <div className="site-name"><span>{siteName}</span><Ping /></div>
      {!query && <FolderTabs value={folderId} onChange={pickFolder} />}
      <ul className="chat-list">
        {list.map((c) => (
          <li key={c.id} className={c.id === activeChatId ? 'active' : ''}>
            <button type="button" className="chat-item" onClick={() => { location.hash = `#/chat/${c.id}`; }}>
              <Avatar id={c.peer?.id || c.id} name={c.title} file={c.peer?.avatar || c.avatar} size={44} online={c.peer?.online} />
              <span className="grow">
                <b>{c.title}</b>
                <small>{c.lastMessage ? messagePreview(c.lastMessage) : '—'}</small>
              </span>
              <span className="meta">{c.lastMessage ? formatListTime(c.lastMessage.createdAt) : ''}</span>
            </button>
          </li>
        ))}
      </ul>
      {found && <MessageResults messages={found} onClose={() => setFound(null)} />}
      <button className="fab" aria-label="گفتگوی جدید" onClick={() => openModal('newChat')}><Plus size={22} /></button>
      {chatMenu && <ChatMenu {...chatMenu} onClose={() => setChatMenu(null)} />}
    </aside>
  );
}
