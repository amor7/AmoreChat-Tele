// A person's page, like Telegram's: big photo (tap → full screen, with save), name, @username,
// last seen, bio, and the main actions (message, voice call, video call) as large buttons.
// Opened from a group (tap on a sender's photo or name, or a member in the group's info) and
// used as the header of a private chat's info page.
import { useEffect, useState } from 'react';
import { api, fileUrl } from '../api';
import { useStore, isUserOnline } from '../store';
import { ROLE_LABELS, formatLastSeen, copyText } from '../util';
import { startCall } from '../rtc';
import { Modal } from './Modals';
import Avatar from './Avatar';
import Lightbox from './Lightbox';
import { DownloadButton } from './Media';
import { MessageCircle, Phone, Video, AtSign, Info } from 'lucide-react';

/** Large photo + name + status. The photo opens full screen (with a save button) when there is one. */
export function ProfileHead({ user, online }) {
  const [viewing, setViewing] = useState(false);
  const photo = user.avatar;
  return (
    <div className="user-profile-head">
      {photo ? (
        <button type="button" className="profile-photo-btn" onClick={() => setViewing(true)} aria-label={`نمایش عکس پروفایل ${user.displayName || ''}`}>
          <Avatar id={user.id} name={user.displayName} file={photo} size={112} />
        </button>
      ) : (
        <Avatar id={user.id} name={user.displayName} size={112} />
      )}
      <h3>{user.displayName}</h3>
      <p className={`muted ${online ? 'is-online' : ''}`}>{online ? 'آنلاین' : formatLastSeen(user.lastSeen, user)}</p>
      {viewing && (
        <Lightbox
          src={fileUrl(photo)}
          alt={`عکس پروفایل ${user.displayName || ''}`}
          label="عکس پروفایل"
          portal
          onClose={() => setViewing(false)}
          download={<DownloadButton fileId={photo} name={`${user.username || 'profile'}.jpg`} className="lightbox-dl" />}
        />
      )}
    </div>
  );
}

/** Message / voice call / video call. Hidden for yourself. */
export function ProfileActions({ user, onDone }) {
  const showToast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);
  const message = async () => {
    setBusy(true);
    try {
      const { chat } = await api('POST', '/chats/dm', { userId: user.id });
      useStore.getState().upsertChat(chat);
      onDone?.();
      useStore.getState().closeModal();
      location.hash = `#/chat/${chat.id}`;
    } catch (e) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };
  const call = (video) => startCall(user, video).catch((e) => showToast(e.message));
  return (
    <div className="profile-actions">
      <button type="button" className="profile-action primary" onClick={message} disabled={busy}>
        <MessageCircle size={22} />
        <span>پیام</span>
      </button>
      <button type="button" className="profile-action" onClick={() => call(false)}>
        <Phone size={22} />
        <span>تماس صوتی</span>
      </button>
      <button type="button" className="profile-action" onClick={() => call(true)}>
        <Video size={22} />
        <span>تماس تصویری</span>
      </button>
    </div>
  );
}

/** @username and bio as tappable rows (username copies). */
export function ProfileDetails({ user }) {
  const showToast = useStore((s) => s.showToast);
  return (
    <ul className="profile-details">
      {user.username && (
        <li>
          <button
            type="button"
            className="row-item"
            onClick={() => copyText(`@${user.username}`).then(() => showToast('نام کاربری کپی شد'), () => {})}
          >
            <AtSign size={20} />
            <span className="grow">
              <b dir="ltr">@{user.username}</b>
              <small>نام کاربری؛ برای کپی بزنید</small>
            </span>
          </button>
        </li>
      )}
      {user.bio && (
        <li>
          <div className="row-item">
            <Info size={20} />
            <span className="grow">
              <b className="profile-bio">{user.bio}</b>
              <small>درباره</small>
            </span>
          </div>
        </li>
      )}
      {user.role && user.role !== 'user' && (
        <li className="profile-role">
          <span className="role-badge">{ROLE_LABELS[user.role]} سرور</span>
        </li>
      )}
    </ul>
  );
}

/** The fetched profile (fuller than the copy inside a message or member list). */
export function useUserProfile(id, fallback) {
  const [user, setUser] = useState(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    api('GET', `/users/${id}`)
      .then((r) => alive && setUser(r.user))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return user || fallback || null;
}

export default function UserProfile({ userId, user: given, onClose }) {
  const me = useStore((s) => s.me);
  const u = useUserProfile(userId, given ? { id: userId, ...given } : null);
  const online = useStore((s) => isUserOnline(s, u || { id: userId }));
  if (!u) return null;
  const self = u.id === me?.id;
  return (
    // Portal: opened from a group's member list it would otherwise sit inside that list and
    // pick up its button styles.
    <Modal title="اطلاعات کاربر" onClose={onClose} size="user-profile" portal>
      <ProfileHead user={u} online={online} />
      {!self && <ProfileActions user={u} onDone={onClose} />}
      <ProfileDetails user={u} />
    </Modal>
  );
}
