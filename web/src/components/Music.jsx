import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '../api';
import { useStore } from '../store';
import { formatClock, formatSize, toFa, faDigits } from '../util';
import { playMessage, toggle, next, prev, seek, seekBy, toggleShuffle, cycleRepeat, cycleSpeed, setVolume, closeMusic, playIndex, restoreMusic, trackInfo } from '../music';
import { DownloadButton } from './Media';
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Music as MusicIcon, X, ChevronDown, ListMusic, Volume2, VolumeX } from 'lucide-react';

function Cover({ fileId, thumb, className = '' }) {
  return <span className={`music-cover ${className}`}>{thumb ? <img src={`${fileUrl(fileId)}?thumb=1`} alt="" loading="lazy" /> : <MusicIcon />}</span>;
}

// The timeline: drawn by us so the filled part always matches the song (and the page's input
// styles don't push it).
function Seek({ duration, className = '' }) {
  const pos = useStore((s) => s.musicPos || 0);
  const max = Math.max(1, duration || 0);
  const value = Math.min(pos, max);
  return (
    <input
      className={`music-seek ${className}`}
      type="range"
      dir="ltr"
      min={0}
      max={max}
      step={0.1}
      value={value}
      style={{ '--p': `${(value / max) * 100}%` }}
      aria-label="جای پخش"
      onChange={(e) => seek(Number(e.target.value))}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

const Clock = ({ of }) => {
  const pos = useStore((s) => s.musicPos || 0);
  return <small dir="ltr">{formatClock(of == null ? pos : of)}</small>;
};

// A music file in a chat.
export function MusicMessage({ m }) {
  const f = m.file;
  const { title, artist } = trackInfo(f);
  const isCurrent = useStore((s) => s.music && s.music.queue[s.music.order[s.music.at]]?.messageId === m.id);
  const playing = useStore((s) => isCurrent && s.music?.playing);
  const duration = useStore((s) => (isCurrent && s.music?.duration) || f.duration);
  return (
    <div className={`music-msg ${isCurrent ? 'current' : ''}`}>
      <button className="music-play" onClick={() => playMessage(m)} aria-label={playing ? 'توقف' : 'پخش'}>
        <Cover fileId={f.id} thumb={f.thumb} className="in-chat" />
        <span className="music-play-icon">{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</span>
      </button>
      <span className="music-text">
        <b dir="auto">{title}</b>
        <small dir="auto">{[artist, duration ? formatClock(duration) : '', formatSize(f.size)].filter(Boolean).join(' · ')}</small>
        {isCurrent && <Seek duration={duration} />}
      </span>
      <DownloadButton fileId={f.id} name={f.name} />
    </div>
  );
}

function Buttons({ s, large }) {
  const size = large ? 30 : 18;
  return (
    <span className="music-btns" dir="ltr">
      <button className="icon-btn" aria-label="قبلی" onClick={prev}>
        <SkipBack size={size} fill="currentColor" />
      </button>
      <button className={`icon-btn ${large ? 'music-main' : ''}`} aria-label={s.playing ? 'توقف' : 'پخش'} onClick={toggle}>
        {s.playing ? <Pause size={size} fill="currentColor" /> : <Play size={size} fill="currentColor" />}
      </button>
      <button className="icon-btn" aria-label="بعدی" onClick={() => next()}>
        <SkipForward size={size} fill="currentColor" />
      </button>
    </span>
  );
}

function Volume({ value }) {
  const [before, setBefore] = useState(1);
  const Icon = value ? Volume2 : VolumeX;
  return (
    <span className="music-volume music-desk">
      <button
        className="icon-btn"
        aria-label={value ? 'بی‌صدا' : 'باصدا'}
        onClick={() => {
          if (value) setBefore(value);
          setVolume(value ? 0 : before);
        }}
      >
        <Icon size={18} />
      </button>
      <input className="music-seek" type="range" dir="ltr" min={0} max={1} step={0.05} value={value} style={{ '--p': `${value * 100}%` }} aria-label="بلندی صدا" onChange={(e) => setVolume(Number(e.target.value))} />
    </span>
  );
}

const typing = (el) => el?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'VIDEO', 'AUDIO'].includes(el?.tagName);

// The bar at the top while something is in the player, and the panel with the queue (a sheet on
// phones, a small panel under the bar on desktop).
export function MusicBar() {
  const s = useStore((x) => x.music);
  const meId = useStore((x) => x.me?.id);
  const bar = useRef(null);
  const open = (sheet) => useStore.setState((x) => ({ music: { ...x.music, sheet } }));
  useEffect(() => {
    if (meId) restoreMusic(meId);
  }, [meId]);
  const active = !!s;
  const sheet = !!s?.sheet;
  useEffect(() => {
    if (!active) return;
    const keys = (e) => {
      if (e.key === 'Escape' && sheet) return open(false);
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('.modal')) return;
      if (e.key === ' ') toggle();
      else if (e.key === 'ArrowRight') seekBy(5);
      else if (e.key === 'ArrowLeft') seekBy(-5);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [active, sheet]);
  if (!s) return null;
  const t = s.queue[s.order[s.at]];
  if (!t) return null;
  const RepeatIcon = s.repeat === 'one' ? Repeat1 : Repeat;
  const repeatLabel = { off: 'تکرار خاموش', all: 'تکرار همه', one: 'تکرار همین آهنگ' }[s.repeat];
  const repeatButton = (size) => (
    <button className={`icon-btn ${s.repeat !== 'off' ? 'active' : ''}`} aria-label={repeatLabel} title={repeatLabel} onClick={cycleRepeat}>
      <RepeatIcon size={size} />
    </button>
  );
  const speedButton = (
    <button className="btn sm music-speed" aria-label="سرعت پخش" onClick={cycleSpeed}>
      {faDigits(s.speed)}×
    </button>
  );
  return (
    <>
      <div className="music-bar" ref={bar}>
        <Buttons s={s} />
        <button className="music-bar-text" onClick={() => open(!s.sheet)} aria-label="باز کردن پلیر">
          <b dir="auto">{t.title}</b>
          {t.artist && <small dir="auto">{t.artist}</small>}
        </button>
        <span className="music-bar-time music-desk" dir="ltr">
          <Clock /> / <Clock of={s.duration} />
        </span>
        <Volume value={s.volume} />
        <span className="music-desk">{repeatButton(18)}</span>
        <span className="music-desk">{speedButton}</span>
        <button className={`icon-btn ${s.sheet ? 'active' : ''}`} aria-label="صف پخش" onClick={() => open(!s.sheet)}>
          <ListMusic size={18} />
        </button>
        <button className="icon-btn" aria-label="بستن پلیر" onClick={closeMusic}>
          <X size={18} />
        </button>
        <Seek duration={s.duration} className="music-bar-seek" />
      </div>
      {s.sheet && (
        <div className="music-sheet-back" style={{ '--bar-bottom': `${bar.current?.getBoundingClientRect().bottom || 0}px` }} onClick={() => open(false)}>
          <div className="music-sheet" role="dialog" aria-label="پلیر موزیک" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn music-sheet-close" aria-label="بستن" onClick={() => open(false)}>
              <ChevronDown size={24} />
            </button>
            <Cover fileId={t.fileId} thumb={t.thumb} className="large" />
            <h3 dir="auto">{t.title}</h3>
            {t.artist && (
              <p className="muted" dir="auto">
                {t.artist}
              </p>
            )}
            <Seek duration={s.duration} />
            <div className="music-times" dir="ltr">
              <Clock />
              <Clock of={s.duration} />
            </div>
            <div className="music-controls">
              <button className={`icon-btn ${s.shuffle ? 'active' : ''}`} aria-label={s.shuffle ? 'شافل روشن' : 'شافل خاموش'} aria-pressed={s.shuffle} title="شافل" onClick={toggleShuffle}>
                <Shuffle size={22} />
              </button>
              <Buttons s={s} large />
              {repeatButton(22)}
              {speedButton}
            </div>
            <div className="music-queue-head">صف پخش · {toFa(s.queue.length)} آهنگ</div>
            <ol className="music-queue">
              {s.queue.map((q, i) => (
                <li key={q.messageId}>
                  <button className={q.messageId === t.messageId ? 'current' : ''} onClick={() => playIndex(i)}>
                    <Cover fileId={q.fileId} thumb={q.thumb} className="small" />
                    <span className="music-text">
                      <b dir="auto">{q.title}</b>
                      {q.artist && <small dir="auto">{q.artist}</small>}
                    </span>
                    {q.duration > 0 && <small dir="ltr">{formatClock(q.duration)}</small>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </>
  );
}
