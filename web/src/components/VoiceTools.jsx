import { useState } from 'react';
import { Volume1, Volume2, VolumeX, Hand, Mic, MicOff, LogOut, Ban, X, ChevronDown, ChevronLeft, PhoneOff, Users } from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { getVolume, setVolume } from '../rtc';
import { hasSitePerm, toFa } from '../util';
import Avatar from './Avatar';

const run = (fn) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => useStore.getState().showToast(e.message));

// Who may start / run a voice chat in a stage chat (the server checks the exact permissions).
export const isStageAdmin = (me, chat) => !!chat && ((chat.type !== 'channel' && hasSitePerm(me, 'manage_chats')) || chat.myRole === 'owner' || chat.myRole === 'admin');

// ---------- Per-person volume, 0–200% (remembered on this device) ----------
export function VolumeSlider({ userId, kind = 'voice', label }) {
  useStore((s) => s.volumesVersion); // re-render after a change
  const v = Math.round(getVolume(userId, kind) * 100);
  const Icon = v === 0 ? VolumeX : v < 100 ? Volume1 : Volume2;
  return (
    <label className="vol-slider" onClick={(e) => e.stopPropagation()}>
      <span className="vol-head">
        <Icon size={16} /> {label || 'صدا'}
        <b dir="ltr">{toFa(v)}%</b>
      </span>
      <input type="range" min="0" max="200" step="5" value={v} onChange={(e) => setVolume(userId, kind, Number(e.target.value) / 100)} onDoubleClick={() => setVolume(userId, kind, 1)} aria-label={label || 'صدا'} />
    </label>
  );
}

// Small speaker button with a volume popover (1:1 call screen).
export function VolumeButton({ userId, size = 24 }) {
  const [open, setOpen] = useState(false);
  useStore((s) => s.volumesVersion);
  const v = getVolume(userId);
  const Icon = v === 0 ? VolumeX : v < 1 ? Volume1 : Volume2;
  return (
    <div className="vol-anchor">
      <button className={`ctl ${v !== 1 ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-label="صدای طرف مقابل">
        <Icon size={size} />
      </button>
      {open && (
        <div className="vol-pop">
          <VolumeSlider userId={userId} label="صدای طرف مقابل" />
        </div>
      )}
    </div>
  );
}

// ---------- Admin panel of a stage voice chat: raised hands, listeners, mute all, end ----------
export function StagePanel({ chatId }) {
  const participants = useStore((s) => s.voiceRooms[chatId]) || [];
  const meta = useStore((s) => s.voiceMeta[chatId]);
  const meId = useStore((s) => s.me.id);
  const [open, setOpen] = useState(true);
  const [showListeners, setShowListeners] = useState(false);
  const hands = (meta?.hands || []).map((id) => participants.find((p) => p.userId === id)).filter(Boolean);
  const listeners = participants.filter((p) => !p.speaker && !p.hand);
  const mod = (action, userId, extra = {}) => run(() => api('POST', `/rtc/${chatId}/moderate`, { action, userId, ...extra }));

  return (
    <div className="stage-panel">
      <button className="stage-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={16} /> : <ChevronLeft size={16} />}
        <b>مدیریت ویس‌چت</b>
        {hands.length > 0 && (
          <span className="hand-count">
            <Hand size={14} /> {toFa(hands.length)}
          </span>
        )}
      </button>
      {open && (
        <>
          {hands.length > 0 && (
            <ul className="stage-list">
              {hands.map((p) => (
                <li key={p.userId}>
                  <Avatar id={p.userId} name={p.name} file={p.avatar} size={30} />
                  <span className="grow">
                    <Hand size={14} className="hand-icon" /> {p.name}
                  </span>
                  <button className="btn sm primary" onClick={() => mod('grant', p.userId)}>
                    <Mic size={14} /> اجازه صحبت
                  </button>
                  <button className="icon-btn" title="رد درخواست" onClick={() => mod('dismiss_hand', p.userId)}>
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="stage-sub" onClick={() => setShowListeners(!showListeners)}>
            <Users size={14} /> شنونده‌ها ({toFa(listeners.length)}) {showListeners ? <ChevronDown size={14} /> : <ChevronLeft size={14} />}
          </button>
          {showListeners && (
            <ul className="stage-list">
              {listeners.map((p) => (
                <li key={p.userId}>
                  <Avatar id={p.userId} name={p.name} file={p.avatar} size={30} />
                  <span className="grow">
                    {p.name}
                    {p.userId === meId && ' (شما)'}
                  </span>
                  {p.userId !== meId && (
                    <>
                      <button className="btn sm" onClick={() => mod('grant', p.userId)}>
                        <Mic size={14} /> اجازه صحبت
                      </button>
                      <button className="icon-btn" title="بیرون کردن" onClick={() => mod('kick', p.userId)}>
                        <LogOut size={16} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="بیرون کردن و منع ورود به این ویس‌چت"
                        onClick={() => confirm(`${p.name} بیرون شود و تا پایان این ویس‌چت نتواند برگردد؟`) && mod('kick', p.userId, { ban: true })}
                      >
                        <Ban size={16} />
                      </button>
                    </>
                  )}
                </li>
              ))}
              {!listeners.length && <li className="muted">شنونده‌ای نیست</li>}
            </ul>
          )}
          <div className="stage-actions">
            <button className="btn sm" onClick={() => mod('mute_all')}>
              <MicOff size={14} /> بی‌صدا کردن همه
            </button>
            <button className="btn sm danger" onClick={() => confirm('ویس‌چت برای همه تمام شود؟') && mod('end')}>
              <PhoneOff size={14} /> پایان برای همه
            </button>
          </div>
        </>
      )}
    </div>
  );
}
