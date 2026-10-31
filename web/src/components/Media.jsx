import { useEffect, useRef, useState } from 'react';
import { fileUrl } from '../api';
import { useStore, useDataSaver } from '../store';
import { formatSize, formatClock, decodeWaveform } from '../util';
import { startDownload, cancelDownload } from '../download';
import { claimPlayback } from '../playback';
import { Play, Pause, Download, X, Image as ImageIcon } from 'lucide-react';

const SPEEDS = [1, 1.5, 2];

export function VoicePlayer({ file, mine }) {
  const audio = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(file.duration || 0);
  const [speed, setSpeed] = useState(1);
  const bars = decodeWaveform(file.waveform) || Array.from({ length: 40 }, (_, i) => 0.3 + 0.25 * Math.abs(Math.sin(i * 1.7)));

  function toggle() {
    const a = audio.current;
    if (a.paused) {
      claimPlayback(a);
      a.play().catch(() => {});
    } else a.pause();
  }

  function seek(e) {
    const r = e.currentTarget.getBoundingClientRect();
    // The waveform is drawn left-to-right (dir=ltr), like a timeline.
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (dur) audio.current.currentTime = ratio * dur;
  }

  const progress = dur ? pos / dur : 0;
  return (
    <div className={`voice-player ${mine ? 'mine' : ''}`}>
      <button className="play-btn" onClick={toggle} aria-label={playing ? 'توقف' : 'پخش'}>
        {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="voice-body">
        <div className="wave" dir="ltr" onClick={seek}>
          {bars.map((b, i) => (
            <span key={i} className={i / bars.length < progress ? 'on' : ''} style={{ height: `${Math.max(12, b * 100)}%` }} />
          ))}
        </div>
        <div className="voice-meta">
          <span>{formatClock(playing || pos ? pos : dur)}</span>
          <button
            className="speed"
            onClick={() => {
              const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
              setSpeed(next);
              audio.current.playbackRate = next;
            }}
          >
            {speed}×
          </button>
        </div>
      </div>
      <audio
        ref={audio}
        src={fileUrl(file.id)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPos(0);
        }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
      />
    </div>
  );
}

export function ImageMessage({ file }) {
  const openModal = useStore((s) => s.openModal);
  const dataSaver = useDataSaver();
  const [show, setShow] = useState(!dataSaver);
  const ratio = file.width && file.height ? `${file.width} / ${file.height}` : undefined;
  // Portrait photos get narrower instead of being cropped by the max height (420px).
  const width = file.width && file.height ? Math.min(360, Math.round((420 * file.width) / file.height)) : undefined;
  const box = { aspectRatio: ratio, width };
  if (!show) {
    return (
      <button className="media media-placeholder" style={{ ...box, aspectRatio: ratio || '4 / 3' }} onClick={() => setShow(true)}>
        <span className="with-icon">
          <ImageIcon size={18} /> نمایش عکس
        </span>
        <small>{formatSize(file.size)}</small>
      </button>
    );
  }
  return (
    <button className="media" style={box} onClick={() => openModal('image', { fileId: file.id, name: file.name })}>
      <img src={fileUrl(file.id)} alt="" loading="lazy" />
    </button>
  );
}

const qualityLabel = (q) => (q === 'orig' ? 'اصلی' : `${q}p`);

export function VideoMessage({ file }) {
  const dataSaver = useDataSaver();
  const video = useRef(null);
  const resumeAt = useRef(0);
  const [started, setStarted] = useState(false);
  // Options: processed variants (smallest first) plus the main file.
  const options = [...file.variants.map((v) => ({ q: v.q, size: v.size })), { q: 'orig', size: file.size }];
  const preferred = dataSaver ? options[0].q : (options.find((o) => o.q === 720) || options.at(-1)).q;
  const [quality, setQuality] = useState(preferred);
  const ratio = file.width && file.height ? `${file.width} / ${file.height}` : '16 / 9';
  const src = quality === 'orig' ? fileUrl(file.id) : `${fileUrl(file.id)}?v=${quality}`;

  useEffect(() => {
    // Variants appear when processing finishes; pick a sensible default then.
    if (!started) setQuality(preferred);
  }, [file.variants.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (file.status === 'processing') {
    return (
      <div className="media video-processing" style={{ aspectRatio: ratio }}>
        <span className="spinner" />
        <small>در حال آماده‌سازی ویدیو…</small>
      </div>
    );
  }

  if (!started) {
    const current = options.find((o) => o.q === quality);
    return (
      <div
        className="media video-poster"
        role="button"
        tabIndex={0}
        aria-label="پخش ویدیو"
        style={{ aspectRatio: ratio }}
        onClick={() => setStarted(true)}
        onKeyDown={(e) => e.key === 'Enter' && setStarted(true)}
      >
        {file.thumb && !dataSaver && <img src={`${fileUrl(file.id)}?thumb=1`} alt="" loading="lazy" />}
        <span className="play-overlay">
          <Play size={26} fill="currentColor" />
        </span>
        <small className="video-info">
          {file.duration ? formatClock(file.duration) + ' · ' : ''}
          {formatSize(current?.size)}
        </small>
        <DownloadButton fileId={file.id} name={file.name} variant={quality} className="on-media" />
      </div>
    );
  }

  return (
    <div className="video-wrap">
      <video
        ref={video}
        className="media"
        style={{ aspectRatio: ratio }}
        src={src}
        poster={file.thumb ? `${fileUrl(file.id)}?thumb=1` : undefined}
        controls
        autoPlay
        playsInline
        onPlay={(e) => claimPlayback(e.currentTarget)}
        onLoadedMetadata={(e) => {
          if (resumeAt.current) {
            e.currentTarget.currentTime = resumeAt.current;
            resumeAt.current = 0;
            e.currentTarget.play().catch(() => {});
          }
        }}
      />
      <DownloadButton fileId={file.id} name={file.name} variant={quality} className="on-media" />
      {options.length > 1 && (
        <select
          className="quality-select"
          value={quality}
          onChange={(e) => {
            resumeAt.current = video.current?.currentTime || 0;
            setQuality(e.target.value === 'orig' ? 'orig' : Number(e.target.value));
          }}
          aria-label="کیفیت"
        >
          {options.map((o) => (
            <option key={o.q} value={o.q}>
              {qualityLabel(o.q)} · {formatSize(o.size)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

const dlKey = (fileId, variant) => `${fileId}:${variant || 'orig'}`;
const dlUrl = (fileId, variant) => fileUrl(fileId, true) + (variant && variant !== 'orig' ? `&v=${variant}` : '');
function dlName(name, variant) {
  if (!variant || variant === 'orig') return name;
  return (name || 'video').replace(/\.\w+$/, '') + `-${variant}p.mp4`;
}

function Ring({ progress }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${progress == null ? 'indeterminate' : ''}`} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={r} className="ring-track" />
      <circle cx="20" cy="20" r={r} className="ring-bar" strokeDasharray={c} strokeDashoffset={c * (1 - (progress ?? 0.25))} />
    </svg>
  );
}

// Download icon when idle; progress ring with X (tap to cancel) while downloading.
export function DownloadButton({ fileId, name, variant, className = '' }) {
  const key = dlKey(fileId, variant);
  const dl = useStore((s) => s.downloads[key]);
  const onClick = (e) => {
    e.stopPropagation();
    if (dl) cancelDownload(key);
    else startDownload(key, dlUrl(fileId, variant), dlName(name, variant));
  };
  return (
    <button className={`dl-btn ${dl ? 'active' : ''} ${className}`} onClick={onClick} aria-label={dl ? 'لغو دانلود' : 'دانلود'} title={dl ? 'لغو دانلود' : 'دانلود'}>
      {dl && <Ring progress={dl.progress} />}
      <span className="dl-icon">{dl ? <X size={16} /> : <Download size={18} />}</span>
    </button>
  );
}

export function FileCard({ file }) {
  const key = dlKey(file.id);
  const dl = useStore((s) => s.downloads[key]);
  const start = () => (dl ? cancelDownload(key) : startDownload(key, dlUrl(file.id), file.name));
  return (
    <div className="file-card" role="button" tabIndex={0} onClick={start} onKeyDown={(e) => e.key === 'Enter' && start()}>
      <span className={`file-icon ${dl ? 'active' : ''}`}>
        {dl && <Ring progress={dl.progress} />}
        <span className="dl-icon">{dl ? <X size={16} /> : <Download size={18} />}</span>
      </span>
      <span>
        <span className="file-name" dir="auto">
          {file.name}
        </span>
        <small>
          {dl
            ? `${formatSize(dl.received)} از ${formatSize(file.size)} — برای لغو بزنید`
            : formatSize(file.size)}
        </small>
      </span>
    </div>
  );
}
