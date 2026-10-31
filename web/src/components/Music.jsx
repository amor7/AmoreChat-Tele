import { useEffect } from 'react';
import { fileUrl } from '../api';
import { useStore } from '../store';
import { formatClock, formatSize, toFa, faDigits } from '../util';
import { playMessage, toggle, next, prev, seek, toggleShuffle, cycleRepeat, cycleSpeed, closeMusic, playIndex, trackInfo } from '../music';
import { DownloadButton } from './Media';
import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Music as MusicIcon, X, ChevronDown, ListMusic } from 'lucide-react';

function Cover({ fileId, thumb, size }) {
  return (
    <span className="music-cover" style={{ width: size, height: size }}>
      {thumb ? <img src={`${fileUrl(fileId)}?thumb=1`} alt="" loading="lazy" /> : <MusicIcon size={size / 2} />}
    </span>
  );
}

function Seek({ duration, className = '' }) {
  const pos = useStore((s) => s.musicPos || 0);
  return (
    <input
      className={`music-seek ${className}`}
      type="range"
      dir="ltr"
      min={0}
      max={Math.max(1, Math.round(duration || 0))}
      step={1}
      value={Math.min(Math.round(pos), Math.round(duration || 0))}
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
        <Cover fileId={f.id} thumb={f.thumb} size={46} />
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
  const size = large ? 30 : 20;
  return (
    <>
      <button className="icon-btn" aria-label="قبلی" onClick={prev}>
        <SkipBack size={size} fill="currentColor" />
      </button>
      <button className={`icon-btn ${large ? 'music-main' : ''}`} aria-label={s.playing ? 'توقف' : 'پخش'} onClick={toggle}>
        {s.playing ? <Pause size={size} fill="currentColor" /> : <Play size={size} fill="currentColor" />}
      </button>
      <button className="icon-btn" aria-label="بعدی" onClick={() => next()}>
        <SkipForward size={size} fill="currentColor" />
      </button>
    </>
  );
}

// The bar under the top of the app while something is in the player, and the full player.
export function MusicBar() {
  const s = useStore((x) => x.music);
  const open = (sheet) => useStore.setState((x) => ({ music: { ...x.music, sheet } }));
  useEffect(() => {
    if (!s?.sheet) return;
    const esc = (e) => e.key === 'Escape' && open(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [s?.sheet]);
  if (!s) return null;
  const t = s.queue[s.order[s.at]];
  if (!t) return null;
  const RepeatIcon = s.repeat === 'one' ? Repeat1 : Repeat;
  const repeatLabel = { off: 'تکرار خاموش', all: 'تکرار همه', one: 'تکرار همین آهنگ' }[s.repeat];
  return (
    <>
      <div className="music-bar">
        <Buttons s={s} />
        <button className="music-bar-text" onClick={() => open(true)} aria-label="باز کردن پلیر">
          <b dir="auto">{t.title}</b>
          {t.artist && <small dir="auto">{t.artist}</small>}
        </button>
        <button className="icon-btn" aria-label="صف پخش" onClick={() => open(true)}>
          <ListMusic size={20} />
        </button>
        <button className="icon-btn" aria-label="بستن پلیر" onClick={closeMusic}>
          <X size={20} />
        </button>
        <Seek duration={s.duration} className="music-bar-seek" />
      </div>
      {s.sheet && (
        <div className="music-sheet-back" onClick={() => open(false)}>
          <div className="music-sheet" role="dialog" aria-label="پلیر موزیک" onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn music-sheet-close" aria-label="بستن" onClick={() => open(false)}>
              <ChevronDown size={24} />
            </button>
            <Cover fileId={t.fileId} thumb={t.thumb} size={200} />
            <h3 dir="auto">{t.title}</h3>
            {t.artist && <p className="muted" dir="auto">{t.artist}</p>}
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
              <button className={`icon-btn ${s.repeat !== 'off' ? 'active' : ''}`} aria-label={repeatLabel} title={repeatLabel} onClick={cycleRepeat}>
                <RepeatIcon size={22} />
              </button>
              <button className="btn sm music-speed" aria-label="سرعت پخش" onClick={cycleSpeed}>
                {faDigits(s.speed)}×
              </button>
            </div>
            <div className="music-queue-head">
              صف پخش · {toFa(s.queue.length)} آهنگ
            </div>
            <ol className="music-queue">
              {s.queue.map((q, i) => (
                <li key={q.messageId}>
                  <button className={q.messageId === t.messageId ? 'current' : ''} onClick={() => playIndex(i)}>
                    <Cover fileId={q.fileId} thumb={q.thumb} size={36} />
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
