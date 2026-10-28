import { useEffect, useRef, useState } from 'react';
import { api, upload } from '../api';
import { useStore, isUserOnline } from '../store';
import {
  hasChatPerm,
  hasSitePerm,
  CHAT_PERM_LABELS,
  ROLE_LABELS,
  formatLastSeen,
  formatDateTime,
  toFa,
  copyText,
  compressImage,
  AUTO_DELETE_OPTIONS,
} from '../util';
import { Modal, UserSearch } from './Modals';
import Avatar from './Avatar';
import { NotifyMute, MediaGallery } from './ChatExtras';
import { Camera, Settings, Link, UserPlus, VolumeX, MessageCircle, Timer } from 'lucide-react';

const MUTE_OPTIONS = [
  ['۱ ساعت', 3600e3],
  ['۱ روز', 86400e3],
  ['۱ هفته', 7 * 86400e3],
  ['همیشه', 100 * 365 * 86400e3],
];

export default function ChatInfo({ chatId, onClose }) {
  const me = useStore((s) => s.me);
  const chat = useStore((s) => s.chats[chatId]);
  const version = useStore((s) => s.chatVersion[chatId]);
  const showToast = useStore((s) => s.showToast);
  const [data, setData] = useState(null);

  const load = () =>
    api('GET', `/chats/${chatId}`)
      .then(setData)
      .catch((e) => showToast(e.message));
  useEffect(() => {
    load();
  }, [chatId, version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!chat) return null;
  if (chat.type === 'dm') return <PeerProfile chat={chat} onClose={onClose} />;

  const can = (p) => hasChatPerm(me, chat, p);
  const isOwner = chat.myRole === 'owner' || hasSitePerm(me, 'manage_chats');
  const run = async (fn, ok) => {
    try {
      await fn();
      if (ok) showToast(ok);
      load();
    } catch (e) {
      showToast(e.message);
    }
  };

  return (
    <Modal title={chat.type === 'channel' ? 'اطلاعات کانال' : 'اطلاعات گروه'} onClose={onClose}>
      <InfoHeader chat={chat} canEdit={can('edit_info') && !chat.isEmergency} />
      {chat.description && <p className="description">{chat.description}</p>}

      <NotifyMute chat={chat} />
      {can('edit_info') && <EditChat chat={chat} />}
      {can('invite_links') && !chat.isEmergency && <InviteLinks chatId={chat.id} />}

      <h4>
        {chat.type === 'channel' ? 'مشترکان' : 'اعضا'} ({toFa(chat.memberCount)})
      </h4>
      {data?.membersHidden && <p className="muted tiny">{chat.type === 'channel' ? 'لیست مشترکان کانال فقط برای مدیران کانال قابل مشاهده است.' : 'لیست اعضا فقط برای مدیران قابل مشاهده است. اینجا فقط مدیران را می‌بینید.'}</p>}
      {can('add_members') && !chat.isEmergency && <AddMembers chatId={chat.id} members={data?.members || []} onDone={load} />}
      <ul className="user-list">
        {data?.members.map((m) => (
          <MemberRow key={m.id} m={m} chat={chat} me={me} isOwner={isOwner} run={run} />
        ))}
      </ul>

      <h4>رسانه‌ها و فایل‌ها</h4>
      <MediaGallery chatId={chat.id} />

      {data?.bans?.length > 0 && (
        <>
          <h4>مسدودشده‌ها</h4>
          <ul className="user-list">
            {data.bans.map((b) => (
              <li key={b.id} className="row-item">
                <span className="grow">{b.displayName}</span>
                <button className="btn sm" onClick={() => run(() => api('DELETE', `/chats/${chat.id}/bans/${b.id}`), 'رفع مسدودیت شد')}>
                  رفع مسدودیت
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="actions danger-zone">
        {chat.myRole !== 'owner' && !chat.isEmergency && (
          <button
            className="btn danger"
            onClick={() =>
              confirm('از این گفتگو خارج می‌شوید؟') &&
              run(async () => {
                await api('POST', `/chats/${chat.id}/leave`);
                useStore.getState().removeChat(chat.id);
                onClose();
              })
            }
          >
            خروج
          </button>
        )}
        {isOwner && !chat.isEmergency && (
          <button
            className="btn danger"
            onClick={() =>
              confirm('این گفتگو برای همه حذف می‌شود. مطمئن هستید؟') &&
              run(async () => {
                await api('DELETE', `/chats/${chat.id}`);
                onClose();
              })
            }
          >
            حذف {chat.type === 'channel' ? 'کانال' : 'گروه'}
          </button>
        )}
      </div>
    </Modal>
  );
}

function InfoHeader({ chat, canEdit }) {
  const fileRef = useRef(null);
  const showToast = useStore((s) => s.showToast);

  async function onAvatar(e) {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const { blob } = await compressImage(f, 512, 0.85);
      const file = await upload(blob, { name: 'avatar.jpg' });
      await api('PATCH', `/chats/${chat.id}`, { avatar: file.id });
    } catch (err) {
      showToast(err.message);
    }
  }

  return (
    <div className="profile-head">
      {canEdit ? (
        <button className="avatar-edit" onClick={() => fileRef.current.click()} aria-label="تغییر عکس">
          <Avatar id={chat.id} name={chat.title} file={chat.avatar} size={72} />
          <span>
            <Camera size={15} />
          </span>
        </button>
      ) : (
        <Avatar id={chat.id} name={chat.title} file={chat.avatar} size={72} />
      )}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onAvatar} />
      <div>
        <b>{chat.title}</b>
        <div className="muted">
          {chat.type === 'channel' ? 'کانال' : 'گروه'} {chat.isPublic ? 'عمومی' : 'خصوصی'} · {toFa(chat.memberCount)} {chat.type === 'channel' ? 'مشترک' : 'عضو'}
        </div>
        {chat.myRole !== 'member' && <span className="role-badge">{ROLE_LABELS[chat.myRole]}</span>}
      </div>
    </div>
  );
}

function EditChat({ chat }) {
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    title: chat.title,
    description: chat.description,
    isPublic: chat.isPublic,
    slowMode: chat.slowMode,
    locked: chat.locked,
    autoDelete: chat.autoDelete || 0,
    ...(chat.type === 'group' ? { voiceStage: chat.voiceStage, hideMembers: chat.hideMembers } : {}),
  });

  async function save(e) {
    e.preventDefault();
    try {
      // Only send autoDelete when it changed: the server posts a notice about it.
      const { autoDelete, ...rest } = f;
      await api('PATCH', `/chats/${chat.id}`, autoDelete !== (chat.autoDelete || 0) ? f : rest);
      showToast('ذخیره شد');
      setOpen(false);
    } catch (err) {
      showToast(err.message);
    }
  }

  if (!open)
    return (
      <button className="btn wide" onClick={() => setOpen(true)}>
        <Settings size={17} /> ویرایش و تنظیمات
      </button>
    );
  return (
    <form className="form boxed" onSubmit={save}>
      <label>
        عنوان
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={100} />
      </label>
      <label>
        توضیحات
        <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={2} maxLength={500} />
      </label>
      {!chat.isEmergency && (
        <label className="check">
          <input type="checkbox" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} />
          عمومی (در بخش کاوش نمایش داده شود)
        </label>
      )}
      {!chat.isEmergency && <AutoDeleteSelect value={f.autoDelete} onChange={(v) => setF({ ...f, autoDelete: v })} />}
      {chat.type === 'group' && (
        <>
          <label>
            حالت آهسته
            <select value={f.slowMode} onChange={(e) => setF({ ...f, slowMode: Number(e.target.value) })}>
              <option value={0}>خاموش</option>
              <option value={10}>۱۰ ثانیه</option>
              <option value={30}>۳۰ ثانیه</option>
              <option value={60}>۱ دقیقه</option>
              <option value={300}>۵ دقیقه</option>
              <option value={3600}>۱ ساعت</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={f.locked} onChange={(e) => setF({ ...f, locked: e.target.checked })} />
            قفل گروه (فقط مدیران پیام بدهند)
          </label>
          <label className="check">
            <input type="checkbox" checked={f.hideMembers} onChange={(e) => setF({ ...f, hideMembers: e.target.checked })} />
            مخفی کردن لیست اعضا (فقط مدیران اعضا را ببینند)
          </label>
          <label className="check">
            <input type="checkbox" checked={f.voiceStage} onChange={(e) => setF({ ...f, voiceStage: e.target.checked })} />
            ویس‌چت مدیریت‌شده: فقط مدیران شروع می‌کنند و صحبت می‌کنند، بقیه با ✋ اجازه می‌گیرند
          </label>
        </>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          انصراف
        </button>
        <button className="btn primary">ذخیره</button>
      </div>
    </form>
  );
}

function InviteLinks({ chatId }) {
  const showToast = useStore((s) => s.showToast);
  const [invites, setInvites] = useState(null);
  const [opts, setOpts] = useState({ maxUses: '', expiresInHours: '' });
  const load = () =>
    api('GET', `/chats/${chatId}/invites`)
      .then((r) => setInvites(r.invites))
      .catch(() => {});
  useEffect(() => {
    load();
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (code) => `${location.origin}/#/join/${code}`;

  async function create() {
    try {
      const { invite } = await api('POST', `/chats/${chatId}/invites`, opts);
      (await copyText(link(invite.code))) && showToast('لینک ساخته و کپی شد');
      load();
    } catch (e) {
      showToast(e.message);
    }
  }

  return (
    <details className="boxed">
      <summary className="with-icon">
        <Link size={16} /> لینک‌های دعوت
      </summary>
      <div className="inline-form">
        <input type="number" min="1" placeholder="حداکثر استفاده" value={opts.maxUses} onChange={(e) => setOpts({ ...opts, maxUses: e.target.value })} />
        <input type="number" min="1" placeholder="اعتبار (ساعت)" value={opts.expiresInHours} onChange={(e) => setOpts({ ...opts, expiresInHours: e.target.value })} />
        <button className="btn primary sm" onClick={create}>
          ساخت لینک
        </button>
      </div>
      <ul className="user-list">
        {invites?.map((i) => (
          <li key={i.code} className="row-item">
            <span className="grow">
              <code dir="ltr">{i.code}</code>
              <small>
                {toFa(i.uses)}
                {i.max_uses ? `/${toFa(i.max_uses)}` : ''} استفاده
                {i.expires_at ? ` · تا ${formatDateTime(i.expires_at)}` : ''}
              </small>
            </span>
            <button className="btn sm" onClick={async () => (await copyText(link(i.code))) && showToast('کپی شد')}>
              کپی
            </button>
            <button className="btn sm danger" onClick={() => api('DELETE', `/chats/${chatId}/invites/${i.code}`).then(load)}>
              لغو
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

function AddMembers({ chatId, members, onDone }) {
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button className="btn wide" onClick={() => setOpen(true)}>
        <UserPlus size={17} /> افزودن عضو
      </button>
    );
  return (
    <div className="boxed">
      <UserSearch
        exclude={members.map((m) => m.id)}
        onPick={async (u) => {
          try {
            await api('POST', `/chats/${chatId}/members`, { userIds: [u.id] });
            showToast(`${u.displayName} اضافه شد`);
            onDone();
          } catch (e) {
            showToast(e.message);
          }
        }}
      />
      <button className="btn sm" onClick={() => setOpen(false)}>
        بستن
      </button>
    </div>
  );
}

function MemberRow({ m, chat, me, isOwner, run }) {
  const online = useStore((s) => isUserOnline(s, m));
  const [open, setOpen] = useState(false);
  const [perms, setPerms] = useState(m.chatPerms);
  const can = (p) => hasChatPerm(me, chat, p);
  const self = m.id === me.id;
  // Mirrors server rules: only the chat owner may act on admins.
  const outranks = m.chatRole === 'member' || (m.chatRole === 'admin' && isOwner);
  const muted = m.mutedUntil && m.mutedUntil > Date.now();
  const hasActions = !self && (isOwner || (outranks && (can('mute_members') || can('ban_members'))));

  const path = `/chats/${chat.id}/members/${m.id}`;
  const patch = (body, ok) => run(() => api('PATCH', path, body), ok);

  return (
    <li className="member">
      <button className="row-item" onClick={() => setOpen(!open)}>
        <Avatar id={m.id} name={m.displayName} file={m.avatar} size={38} online={online} />
        <span className="grow">
          <b>
            {m.displayName} {self && '(شما)'}
          </b>
          <small>{online ? 'آنلاین' : formatLastSeen(m.lastSeen)}</small>
        </span>
        {muted && <VolumeX size={16} aria-label="بی‌صدا" />}
        {m.chatRole !== 'member' && <span className="role-badge">{ROLE_LABELS[m.chatRole]}</span>}
      </button>
      {open && (
        <div className="member-actions">
          {!self && (
            <button
              className="btn sm"
              onClick={async () => {
                const { chat: dm } = await api('POST', '/chats/dm', { userId: m.id });
                useStore.getState().upsertChat(dm);
                useStore.getState().closeModal();
                location.hash = `#/chat/${dm.id}`;
              }}
            >
              <MessageCircle size={15} /> پیام خصوصی
            </button>
          )}
          {hasActions && isOwner && m.chatRole !== 'owner' && (
            <div className="perm-box">
              <b>{m.chatRole === 'admin' ? 'دسترسی‌های ادمین' : 'ارتقا به ادمین با دسترسی‌های:'}</b>
              {Object.entries(CHAT_PERM_LABELS)
                .filter(([p]) => chat.type === 'channel' || p !== 'post_messages')
                .map(([p, label]) => (
                  <label key={p} className="check">
                    <input
                      type="checkbox"
                      checked={perms.includes(p)}
                      onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))}
                    />
                    {label}
                  </label>
                ))}
              <div className="actions">
                <button className="btn primary sm" onClick={() => patch({ role: 'admin', perms }, 'ذخیره شد')}>
                  {m.chatRole === 'admin' ? 'ذخیره دسترسی‌ها' : 'ادمین کن'}
                </button>
                {m.chatRole === 'admin' && (
                  <button className="btn sm" onClick={() => patch({ role: 'member' }, 'از ادمینی برکنار شد')}>
                    برکناری از ادمینی
                  </button>
                )}
              </div>
            </div>
          )}
          {hasActions && outranks && can('mute_members') && chat.type === 'group' && (
            <div className="inline-form">
              <span className="with-icon">
                <VolumeX size={15} /> بی‌صدا:
              </span>
              {MUTE_OPTIONS.map(([label, ms]) => (
                <button key={label} className="btn sm" onClick={() => patch({ mutedUntil: Date.now() + ms }, 'بی‌صدا شد')}>
                  {label}
                </button>
              ))}
              {muted && (
                <button className="btn sm" onClick={() => patch({ mutedUntil: null }, 'صدادار شد')}>
                  لغو
                </button>
              )}
            </div>
          )}
          {hasActions && outranks && can('ban_members') && !chat.isEmergency && (
            <div className="inline-form">
              <button className="btn sm danger" onClick={() => confirm(`${m.displayName} حذف شود؟`) && run(() => api('DELETE', path), 'حذف شد')}>
                حذف از {chat.type === 'channel' ? 'کانال' : 'گروه'}
              </button>
              <button
                className="btn sm danger"
                onClick={() => confirm(`${m.displayName} مسدود شود؟ دیگر نمی‌تواند برگردد.`) && run(() => api('DELETE', `${path}?ban=1`), 'مسدود شد')}
              >
                مسدود کردن
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function AutoDeleteSelect({ value, onChange }) {
  const known = AUTO_DELETE_OPTIONS.some(([v]) => v === value);
  return (
    <label>
      <span className="with-icon">
        <Timer size={15} /> حذف خودکار پیام‌های جدید
      </span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {AUTO_DELETE_OPTIONS.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
        {!known && <option value={value}>{toFa(value)} ثانیه</option>}
      </select>
    </label>
  );
}

function PeerProfile({ chat, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [user, setUser] = useState(null);
  const online = useStore((s) => isUserOnline(s, chat.peer));
  useEffect(() => {
    if (chat.peer)
      api('GET', `/users/${chat.peer.id}`)
        .then((r) => setUser(r.user))
        .catch(() => {});
  }, [chat.peer]);
  const u = user || chat.peer;
  if (!u) return null;
  return (
    <Modal title="اطلاعات کاربر" onClose={onClose}>
      <div className="center">
        <Avatar id={u.id} name={u.displayName} file={u.avatar} size={96} />
        <h3>{u.displayName}</h3>
        <div className="muted" dir="ltr">
          @{u.username}
        </div>
        <p className="muted">{online ? 'آنلاین' : formatLastSeen(u.lastSeen)}</p>
        {user?.bio && <p>{user.bio}</p>}
        {user?.role && user.role !== 'user' && <span className="role-badge">{ROLE_LABELS[user.role]} سرور</span>}
      </div>
      <div className="form">
        <AutoDeleteSelect
          value={chat.autoDelete || 0}
          onChange={(v) =>
            api('PATCH', `/chats/${chat.id}`, { autoDelete: v })
              .then(() => showToast('ذخیره شد'))
              .catch((e) => showToast(e.message))
          }
        />
      </div>
      <NotifyMute chat={chat} />
      <h4>رسانه‌ها و فایل‌ها</h4>
      <MediaGallery chatId={chat.id} />
    </Modal>
  );
}
