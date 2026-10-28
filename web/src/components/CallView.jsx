import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { formatClock } from '../util';
import { useSmartFit } from '../smartFit';
import Avatar from './Avatar';
import Ping from './Ping';
import { VolumeButton } from './VoiceTools';
import { ShareDialog } from './Voice';
import { ChevronDown, Mic, MicOff, Video as VideoIcon, VideoOff, PhoneOff, SwitchCamera, ScreenShare, ScreenShareOff, Volume2 } from 'lucide-react';
import { setMic, setCamera, flipCamera, hangUp, canShareScreen, startScreenShare, stopScreenShare, enableAudioPlayback } from '../rtc';

const run = (fn) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => useStore.getState().showToast(e.message));

const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

function Video({ pub, mirror, className, ...rest }) {
  const ref = useRef(null);
  const track = pub?.videoTrack;
  const big = className?.includes('call-main');
  const fit = useSmartFit(ref, big);
  useEffect(() => {
    if (!track || !ref.current) return;
    track.attach(ref.current);
    return () => track.detach(ref.current);
  }, [track]);
  return track ? (
    <video
      ref={ref}
      className={`${className} ${mirror ? 'mirror' : ''}`}
      // Screen shares are always shown whole; cameras use the smart choice.
      style={{ objectFit: big ? (className.includes('contain') ? 'contain' : fit) : 'cover' }}
      data-fit={big ? fit : undefined}
      autoPlay
      playsInline
      muted
      {...rest}
    />
  ) : null;
}

// Seconds since the other person joined (both sides count from the same moment).
function useCallTimer(connected) {
  const start = useRef(null);
  const [, tick] = useState(0);
  if (connected && !start.current) start.current = Date.now();
  if (!connected) start.current = null;
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [connected]);
  return start.current ? (Date.now() - start.current) / 1000 : 0;
}

// The small self-view box: tap to swap, drag to move between corners.
function usePip() {
  const [corner, setCorner] = useState('top-end');
  const drag = useRef(null);
  const handlers = {
    onPointerDown(e) {
      drag.current = { x: e.clientX, y: e.clientY, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e) {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 12) d.moved = true;
      // Keep the selfie mirror while dragging (an inline transform replaces the CSS one).
      const mirror = e.currentTarget.classList.contains('mirror') ? ' scaleX(-1)' : '';
      if (d.moved) e.currentTarget.style.transform = `translate(${dx}px, ${dy}px)${mirror}`;
    },
    onPointerUp(e, onTap) {
      const d = drag.current;
      drag.current = null;
      e.currentTarget.style.transform = '';
      if (!d?.moved) return onTap();
      // Snap to the nearest corner. Layout is RTL, so "start" is the right side.
      const top = e.clientY < window.innerHeight / 2;
      const right = e.clientX > window.innerWidth / 2;
      setCorner(`${top ? 'top' : 'bottom'}-${right ? 'start' : 'end'}`);
    },
  };
  return { corner, handlers };
}

export default function CallView() {
  const rtc = useStore((s) => s.rtc);
  const call = useStore((s) => s.call);
  const [swapped, setSwapped] = useState(false);
  const [controls, setControls] = useState(true);
  const [share, setShare] = useState(false);
  const hideTimer = useRef(null);
  const pip = usePip();

  const local = rtc.participants.find((p) => p.isLocal);
  const remote = rtc.participants.find((p) => !p.isLocal);
  const peer = call?.peer || { displayName: rtc.title };
  const elapsed = useCallTimer(!!remote);

  // Remote screen share wins over their camera, like in other messengers.
  const remoteVideo = remote?.screen || remote?.camera;
  const localVideo = local?.camera;
  const anyVideo = !!(remoteVideo || localVideo);
  const canSwap = !!(remoteVideo && localVideo);
  // Each video keeps its own <video> element and only changes role ("big" / "small"),
  // so swapping is instant instead of re-attaching tracks (which flashes black).
  const remoteRole = !remoteVideo ? null : swapped && canSwap ? 'small' : 'big';
  const localRole = !localVideo ? null : swapped && canSwap ? 'big' : remote ? 'small' : 'big';
  const hasBig = remoteRole === 'big' || localRole === 'big';

  // Auto-hide controls while there is video; any tap brings them back.
  const poke = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    if (anyVideo && remote) hideTimer.current = setTimeout(() => setControls(false), 4000);
  };
  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, [anyVideo, !!remote]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!canSwap) setSwapped(false);
  }, [canSwap]);

  const pipProps = {
    role: 'button',
    'aria-label': 'جابه‌جایی تصویر',
    onClick: (e) => e.stopPropagation(),
    onPointerDown: pip.handlers.onPointerDown,
    onPointerMove: pip.handlers.onPointerMove,
    onPointerUp: (e) => pip.handlers.onPointerUp(e, () => canSwap && setSwapped((v) => !v)),
  };
  const roleProps = (role, mainClass) => (role === 'big' ? { className: mainClass } : { className: `call-pip ${pip.corner}`, ...pipProps });

  let status;
  if (rtc.state === 'reconnecting') status = 'اتصال ضعیف است؛ در حال اتصال دوباره…';
  else if (call?.state === 'ringing') status = call.role === 'caller' ? 'در حال زنگ زدن…' : 'در حال اتصال…';
  else if (!remote) status = 'در حال اتصال…';
  else status = formatClock(elapsed);

  const minimize = () => useStore.setState((s) => ({ rtc: { ...s.rtc, expanded: false } }));

  return (
    <div className={`call-view ${controls ? '' : 'hide-controls'} ${swapped ? 'swapped' : ''}`} data-remote={remote ? '1' : '0'} onClick={poke}>
      {!hasBig && (
        <div className={`call-avatar ${remote?.speaking ? 'speaking' : ''}`}>
          <Avatar id={peer.id} name={peer.displayName} file={peer.avatar} size={132} />
        </div>
      )}
      <Video key="remote" pub={remoteVideo} {...roleProps(remoteRole, `call-main ${remote?.screen ? 'contain' : ''}`)} />
      <Video key="local" pub={localVideo} mirror {...roleProps(localRole, 'call-main')} />

      {/* Outside .call-top so it stays visible when the controls auto-hide. */}
      <div className="call-ping">
        <Ping dark />
      </div>
      <div className="call-top">
        <button
          className="icon-btn"
          aria-label="کوچک کردن"
          onClick={(e) => {
            e.stopPropagation();
            minimize();
          }}
        >
          <ChevronDown size={24} />
        </button>
        <div className="call-title">
          <b>{peer.displayName}</b>
          <span>
            {status}
            {remote && !remote.micOn && <MicOff size={14} className="inline-icon" />}
          </span>
        </div>
      </div>

      {!rtc.canPlayAudio && (
        <button
          className="btn primary audio-unlock call-audio-unlock"
          onClick={(e) => {
            e.stopPropagation();
            run(enableAudioPlayback);
          }}
        >
          <Volume2 size={18} /> برای شنیدن صدا بزنید
        </button>
      )}

      <div className="call-controls" onClick={(e) => e.stopPropagation()}>
        <button className={`ctl ${rtc.micOn ? '' : 'off'}`} onClick={() => run(() => setMic(!rtc.micOn))} aria-label={rtc.micOn ? 'بستن میکروفون' : 'باز کردن میکروفون'}>
          {rtc.micOn ? <Mic size={24} /> : <MicOff size={24} />}
        </button>
        <button className={`ctl ${rtc.camOn ? 'on' : ''}`} onClick={() => run(() => setCamera(!rtc.camOn))} aria-label="دوربین">
          {rtc.camOn ? <VideoIcon size={24} /> : <VideoOff size={24} />}
        </button>
        <button className="ctl hangup" onClick={() => run(hangUp)} aria-label="قطع تماس">
          <PhoneOff size={28} />
        </button>
        {remote && <VolumeButton userId={remote.userId} />}
        {rtc.camOn && isTouch && (
          <button className="ctl" onClick={() => run(flipCamera)} aria-label="تعویض دوربین">
            <SwitchCamera size={24} />
          </button>
        )}
        {rtc.canStream && canShareScreen() && (
          <button
            className={`ctl ${rtc.screenOn ? 'on' : ''}`}
            onClick={() => (rtc.screenOn ? run(stopScreenShare) : setShare(true))}
            aria-label="اشتراک صفحه"
          >
            {rtc.screenOn ? <ScreenShareOff size={24} /> : <ScreenShare size={24} />}
          </button>
        )}
        {share && <ShareDialog onClose={() => setShare(false)} />}
      </div>
    </div>
  );
}
