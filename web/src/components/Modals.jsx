import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api, fileUrl } from '../api';
import { toFa, postBlockReason, messagePreview, formatListTime } from '../util';
import Avatar from './Avatar';
import { DownloadButton } from './Media';
import { RichText } from './Emoji';
import PreviewIcon from './PreviewIcon';
import { X, Megaphone, Users, Volume2 } from 'lucide-react';
import NewChat from './NewChat';
import Profile from './Profile';
import ChatInfo from './ChatInfo';
import Admin from './Admin';
import { Readers } from './ChatExtras';
import { ShareTarget, AppUpdateNotes } from './AndroidApp';
import { FoldersModal, FolderEditor } from './Folders';
import { useBackClose } from '../backnav';

export function Modal({ title, onClose, children, size = '' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${size}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="بستن" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// Debounced user search with a result list; used for DMs, group creation and adding members.
export function UserSearch({ onPick, exclude = [], placeholder = 'جستجوی نام یا نام کاربری' }) {
  const me = useStore((s) => s.me);
  const [q, setQ] = useState('');
  const [users, setUsers] = useState([]);

  useEffect(() => {
    if (!q.trim()) return setUsers([]);
    const t = setTimeout(() => {
      api('GET', `/users/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setUsers(r.users))
        .catch((e) => e.status === 429 && useStore.getState().showToast(e.message));
    }, 400);
    return () => clearTimeout(t);
  }, [q]);

  const shown = users.filter((u) => u.id !== me.id && !exclude.includes(u.id));
  return (
    <div className="user-search">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} autoFocus />
      <ul className="user-list">
        {shown.map((u) => (
          <li key={u.id}>
            <button onClick={() => onPick(u)}>
              <Avatar id={u.id} name={u.displayName} file={u.avatar} size={36} online={u.online} />
              <span>
                <b>{u.displayName}</b>
                <small dir="ltr">@{u.username}</small>
              </span>
            </button>
          </li>
        ))}
        {q.trim() && !shown.length && (
          <li className="muted pad">کاربری پیدا نشد. کسانی که با شما گروه یا گفتگوی مشترکی ندارند فقط با <b>نام کاربری کامل</b> پیدا می‌شوند (مثلاً ali_rezaei).</li>
        )}
      </ul>
    </div>
  );
}

function Discover({ onClose }) {
  const [chats, setChats] = useState(null);
  const [listAll, setListAll] = useState(true);
  const [q, setQ] = useState('');
  const st = useStore.getState;
  // The full list (if the admin allows it), or a search by at least 3 letters of the name.
  useEffect(() => {
    const term = q.trim();
    if (term && term.length < 3) return;
    const t = setTimeout(() => {
      api('GET', `/chats/discover${term ? `?q=${encodeURIComponent(term)}` : ''}`)
        .then((r) => {
          setChats(r.chats);
          setListAll(r.listAll !== false);
        })
        .catch((e) => st().showToast(e.message));
    }, term ? 300 : 0);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const short = q.trim() && q.trim().length < 3;

  async function join(id) {
    try {
      const { chat } = await api('POST', `/chats/${id}/join`);
      st().upsertChat(chat);
      onClose();
      location.hash = `#/chat/${id}`;
    } catch (e) {
      st().showToast(e.message);
    }
  }

  return (
    <Modal title="کاوش گروه‌ها و کانال‌های عمومی" onClose={onClose}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجوی نام گروه یا کانال (حداقل ۳ حرف)" autoFocus />
      {short && <p className="muted">حداقل ۳ حرف بنویسید.</p>}
      {!short && !chats && <p className="muted">…</p>}
      {!short && chats?.length === 0 && (
        <p className="muted">{q.trim() ? 'گروه یا کانال عمومی با این نام پیدا نشد.' : listAll ? 'گروه یا کانال عمومی دیگری وجود ندارد.' : 'نام گروه یا کانالی را که دنبالش هستید جستجو کنید، یا با لینک دعوت عضو شوید.'}</p>
      )}
      <ul className="user-list">
        {!short && chats?.map((c) => (
          <li key={c.id} className="row-item">
            <Avatar id={c.id} name={c.title} file={c.avatar} size={40} />
            <span className="grow">
              <b>
                {c.type === 'channel' ? <Megaphone size={15} /> : c.type === 'voice' ? <Volume2 size={15} /> : <Users size={15} />}{' '}
                {c.title}
              </b>
              <small>
                {toFa(c.memberCount)} {c.type === 'channel' ? 'مشترک' : 'عضو'} {c.description && `— ${c.description}`}
              </small>
            </span>
            <button className="btn primary sm" onClick={() => join(c.id)}>
              عضویت
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function JoinInvite({ code, onClose }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const st = useStore.getState;

  useEffect(() => {
    api('GET', `/join/${encodeURIComponent(code)}`)
      .then((r) => setInfo(r.chat))
      .catch((e) => setError(e.message));
  }, [code]);

  const close = () => {
    history.replaceState(null, '', '/');
    onClose();
  };

  async function join() {
    try {
      const { chat } = await api('POST', `/join/${encodeURIComponent(code)}`);
      st().upsertChat(chat);
      onClose();
      location.hash = `#/chat/${chat.id}`;
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Modal title="دعوت به گفتگو" onClose={close} size="small">
      {error && <div className="error">{error}</div>}
      {info && (
        <div className="center">
          <Avatar id={info.id} name={info.title} file={info.avatar} size={72} />
          <h3>{info.title}</h3>
          <p className="muted">
            {info.type === 'channel' ? 'کانال' : 'گروه'} · {toFa(info.memberCount)} {info.type === 'channel' ? 'مشترک' : 'عضو'}
          </p>
          {info.description && <p>{info.description}</p>}
          {info.isMember ? (
            <a className="btn primary" href={`#/chat/${info.id}`} onClick={onClose}>
              باز کردن
            </a>
          ) : (
            <button className="btn primary" onClick={join}>
              عضویت
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function Forward({ message, onClose }) {
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
      const { sent } = await api('POST', `/messages/${message.id}/forward`, { chatIds: picked });
      showToast(`به ${toFa(sent.length)} گفتگو فوروارد شد`);
      onClose();
    } catch (e) {
      showToast(e.message);
    }
    setBusy(false);
  }

  return (
    <Modal title="فوروارد به…" onClose={onClose}>
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
        <button className="btn primary" disabled={!picked.length || busy} onClick={send}>
          ارسال به {toFa(picked.length)} گفتگو
        </button>
      </div>
    </Modal>
  );
}

// Full-text search across all chats, or one chat when chatId is given.
export function MessageResults({ messages, onPick }) {
  const chats = useStore((s) => s.chats);
  return (
    <ul className="user-list">
      {messages.map((m) => {
        const chat = chats[m.chatId];
        return (
          <li key={m.id}>
            <button onClick={() => onPick(m)}>
              <Avatar id={m.sender?.id} name={m.sender?.displayName} file={m.sender?.avatar} size={36} />
              <span className="grow">
                <b>
                  {m.sender?.displayName}
                  {chat && chat.type !== 'dm' ? ` · ${chat.title}` : ''}
                </b>
                <small className="preview">
                  <PreviewIcon m={m} />
              <RichText text={messagePreview(m)} size={16} />
                </small>
              </span>
              <small className="muted">{formatListTime(m.createdAt)}</small>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function openMessage(m) {
  useStore.setState({ jumpTo: { chatId: m.chatId, messageId: m.id }, modal: null });
  location.hash = `#/chat/${m.chatId}`;
}

function Search({ chatId, onClose }) {
  const chatTitle = useStore((s) => s.chats[chatId]?.title);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);

  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => {
      api('GET', `/search?q=${encodeURIComponent(q.trim())}${chatId ? `&chatId=${chatId}` : ''}`)
        .then((r) => setResults(r.messages))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [q, chatId]);

  return (
    <Modal title={chatId ? `جستجو در «${chatTitle}»` : 'جستجوی پیام‌ها'} onClose={onClose}>
      <input placeholder="حداقل ۲ حرف…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {results?.length === 0 && <p className="muted pad">نتیجه‌ای پیدا نشد</p>}
      {results && <MessageResults messages={results} onPick={openMessage} />}
    </Modal>
  );
}

function ImageViewer({ fileId, name, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="نمایش عکس">
      <button className="lightbox-close" onClick={onClose} aria-label="بستن">
        <X size={24} />
      </button>
      <img src={fileUrl(fileId)} alt="" onClick={(e) => e.stopPropagation()} />
      <DownloadButton fileId={fileId} name={name || 'image.jpg'} className="lightbox-dl" />
    </div>
  );
}

export default function Modals() {
  const modal = useStore((s) => s.modal);
  const close = useStore((s) => s.closeModal);
  useBackClose(!!modal, close);
  if (!modal) return null;
  switch (modal.type) {
    case 'newChat':
      return <NewChat onClose={close} />;
    case 'discover':
      return <Discover onClose={close} />;
    case 'join':
      return <JoinInvite code={modal.code} onClose={close} />;
    case 'profile':
      return <Profile onClose={close} />;
    case 'chatInfo':
      return <ChatInfo chatId={modal.chatId} onClose={close} />;
    case 'admin':
      return <Admin onClose={close} />;
    case 'image':
      return <ImageViewer fileId={modal.fileId} name={modal.name} onClose={close} />;
    case 'forward':
      return <Forward message={modal.message} onClose={close} />;
    case 'folders':
      return <FoldersModal onClose={close} />;
    case 'folderEdit':
      return <FolderEditor folder={modal.folder} chatIds={modal.chatIds} onClose={close} />;
    case 'appUpdate':
      return <AppUpdateNotes onClose={close} />;
    case 'shareTarget':
      return <ShareTarget files={modal.files} text={modal.text} onClose={close} />;
    case 'readers':
      return <Readers message={modal.message} onClose={close} />;
    case 'search':
      return <Search chatId={modal.chatId} onClose={close} />;
    default:
      return null;
  }
}
