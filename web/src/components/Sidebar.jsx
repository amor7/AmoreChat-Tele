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
import { UpdateBar } from './AndroidApp';
import { multiServer, appServers, switchServer, addServer } from '../native';

const TYPE_ICON = { group: Users, channel: Megaphone, voice: Volume2 };

function TypeIcon({ type }) {
  const Icon = TYPE_ICON[type];
  return Icon ? <Icon size={15} className="type-icon" /> : null;
}

export default function Sidebar() {
  const chats = useStore((s) => s.chats);
  const me = useStore((s) => s.me);
  const siteName = useStore((s) => s.config.siteName);
  const activeChatId = useStore((s) => s.activeChatId);
  const openModal = useStore((s) => s.openModal);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [found, setFound] = useState(null);
  const folders = useStore((s) => s.folders);
  const [folderId, setFolderId] = useState(() => {
    try {
      return Number(localStorage.getItem('amorechat:folder')) || null;
    } catch {
      return null;
    }
  });
  const pickFolder = (id) => {
    setFolderId(id);
    try {
      localStorage.setItem('amorechat:folder', id || '');
    } catch {
      /* ignore */
    }
  };
  const folder = folders.find((f) => f.id === folderId) || null;
  const [chatMenu, setChatMenu] = useState(null);
  const otherUnread = useOtherServersUnread();
  const press = useRef(null);
  const pressedAt = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setFound(null);
    const t = setTimeout(() => {
      api('GET', `/search?q=${encodeURIComponent(q)}`)
        .then((r) => setFound(r.messages))
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      // A private chat with no message yet is listed only while it is open (like Telegram).
      .filter((c) => c.type !== 'dm' || c.lastMessage || c.id === activeChatId)
      .filter((c) => (q ? true : inFolder(folder, c)))
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.peer?.username?.toLowerCase().includes(q))
      .sort(sortChats);
  }, [chats, query, folder, activeChatId]);

  // Long-press (phones) or right-click (desktop) on a chat: pin, mute, read, folders.
  const itemProps = (c) => ({
    onClick: (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      const to = `#/chat/${c.id}`;
      if (location.hash === to) return;
      // From the list: Back (arrow or phone button) returns to the list.
      if (location.hash.startsWith('#/chat/')) history.replaceState({ fromList: true }, '', to);
      else history.pushState({ fromList: true }, '', to);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    onContextMenu: (e) => {
      e.preventDefault();
      if (Date.now() - pressedAt.current < 1500) return;
      setChatMenu({ chat: c, x: e.clientX, y: e.clientY });
    },
    onTouchStart: (e) => {
      const t = e.touches[0];
      clearTimeout(press.current);
      press.current = setTimeout(() => {
        pressedAt.current = Date.now();
        navigator.vibrate?.(12);
        setChatMenu({ chat: c, x: t.clientX, y: t.clientY });
      }, 450);
    },
    onTouchMove: () => clearTimeout(press.current),
    onTouchEnd: (e) => {
      clearTimeout(press.current);
      if (Date.now() - pressedAt.current < 1500) e.preventDefault();
    },
  });

  const isAdmin = me.role === 'owner' || me.role === 'admin';

  async function logout() {
    await api('POST', '/auth/logout').catch(() => {});
    await clearOffline().catch(() => {});
    await globalThis.caches?.delete('files').catch(() => {});
    disconnectSocket();
    location.hash = '';
    location.reload();
  }

  useBackClose(menu, () => setMenu(false));

  const item = (label, action) => (
    <button
      onClick={() => {
        setMenu(false);
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <button className="icon-btn menu-btn" aria-label="منو" onClick={() => setMenu(!menu)}>
          <Menu size={22} />
          {otherUnread && <i className="menu-dot" />}
        </button>
        <input className="search" placeholder="جستجو" value={query} onChange={(e) => setQuery(e.target.value)} />
        {menu && (
          <>
            <div className="menu-backdrop" onClick={() => setMenu(false)} />
            <div className="menu">
              <div className="menu-user">
                <Avatar id={me.id} name={me.displayName} file={me.avatar} size={40} />
                <div>
                  <b>{me.displayName}</b>
                  <small dir="ltr">@{me.username}</small>
                </div>
              </div>
              {multiServer && <ServerSwitcher onPick={() => setMenu(false)} />}
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
      <div className="site-name">
        <span>{siteName}</span>
        <Ping />
      </div>
      {!query && <FolderTabs value={folderId} onChange={pickFolder} />}
      <ul className="chat-list">
        {!query && !folder && (
          <li>
            <VoiceChannels />
          </li>
        )}
        {list.map((c) => {
          const last = c.lastMessage;
          const sender = last?.sender && c.type === 'group' ? (last.sender.id === me.id ? 'شما: ' : last.sender.displayName + ': ') : '';
          return (
            <li key={c.id}>
              <a href={`#/chat/${c.id}`} className={`chat-item ${c.id === activeChatId ? 'active' : ''} ${c.isEmergency ? 'emergency' : ''}`} {...itemProps(c)}>
                <Avatar id={c.id} name={c.title} file={c.avatar} saved={c.type === 'saved'} online={c.peer?.online} />
                <div className="chat-item-body">
                  <div className="row">
                    <span className="title">
                      {!c.isEmergency && <TypeIcon type={c.type} />}
                      {c.title}
                      {isChatMuted(c) && <BellOff size={13} className="muted-icon" aria-label="بی‌صدا" />}
                    </span>
                    {last && <span className="time">{formatListTime(last.createdAt)}</span>}
                  </div>
                  <div className="row">
                    <span className="preview">
                      {sender}
                      <PreviewIcon m={last} />
                      <RichText text={messagePreview(last)} size={16} />
                    </span>
                    {c.unreadMentions > 0 && <span className="badge mention">@</span>}
                    {c.unread > 0 && <span className={`badge ${isChatMuted(c) ? 'quiet' : ''}`}>{toFa(c.unread)}</span>}
                    {!c.unread && c.pinnedAt && <Pin size={14} className="pin-mark" aria-label="سنجاق‌شده" />}
                  </div>
                </div>
              </a>
            </li>
          );
        })}
        {!list.length && !found?.length && <li className="muted center pad">گفتگویی پیدا نشد</li>}
        {found?.length > 0 && (
          <li>
            <div className="list-section">پیام‌ها</div>
            <MessageResults messages={found} onPick={openMessage} />
          </li>
        )}
      </ul>
      <UpdateBar />
      {chatMenu && <ChatMenu {...chatMenu} onClose={() => setChatMenu(null)} />}
      <button className="fab" aria-label="گفتگوی جدید" onClick={() => openModal('newChat')}>
        <SquarePen size={24} />
      </button>
    </aside>
  );
}

// Android app: every added server, with unread counts from the background connection.
function ServerSwitcher({ onPick }) {
  useStore((s) => s.nativeTick);
  const servers = appServers();
  return (
    <div className="server-switcher">
      {servers.map((s) => (
        <button
          key={s.url}
          className={s.current ? 'current' : ''}
          onClick={() => {
            onPick();
            if (!s.current) switchServer(s.url);
          }}
        >
          <Server size={17} />
          <span className="grow" dir="ltr">
            {s.name}
          </span>
          {!s.current && s.unread > 0 && <span className="badge">{s.unread}</span>}
          {s.current && <span className="tag">فعلی</span>}
        </button>
      ))}
      <button
        onClick={() => {
          onPick();
          addServer();
        }}
      >
        <Plus size={17} /> افزودن سرور دیگر
      </button>
    </div>
  );
}

// A dot on the menu button when another server has unread messages.
export function useOtherServersUnread() {
  useStore((s) => s.nativeTick);
  return multiServer ? appServers().some((s) => !s.current && s.unread > 0) : false;
}

const hasAnyAdminPerm = (me) =>
  ['manage_users', 'manage_invites', 'manage_settings', 'manage_chats', 'view_audit', 'handle_reports'].some((p) => hasSitePerm(me, p));
