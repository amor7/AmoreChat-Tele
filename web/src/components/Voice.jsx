import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  SwitchCamera,
  ScreenShare,
  ScreenShareOff,
  Radio,
  PhoneOff,
  LogOut,
  ChevronDown,
  ChevronLeft,
  Volume2,
  EllipsisVertical,
  LayoutGrid,
  Eye,
  Users,
  Phone,
  MonitorPlay,
  Hand,
  Ban,
} from 'lucide-react';
import { api } from '../api';
import { useStore } from '../store';
import { hasChatPerm, toFa } from '../util';
import Avatar from './Avatar';
import Ping from './Ping';
import CallView from './CallView';
import { VolumeSlider, StagePanel, isStageAdmin } from './VoiceTools';
import { useBackClose } from '../backnav';
import { useSmartFit } from '../smartFit';
import {
  joinVoice,
  leave,
  setMic,
  setCamera,
  flipCamera,
  startScreenShare,
  stopScreenShare,
  setDeafened,
  setPtt,
  watchStream,
  setStreamQuality,
  enableAudioPlayback,
  canShareScreen,
  acceptCall,
  declineCall,
  hangUp,
  setHand,
} from '../rtc';

const run = (fn) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => useStore.getState().showToast(e.message));

const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const expand = () => useStore.setState((s) => ({ rtc: { ...s.rtc, expanded: true } }));

// Attaches a LiveKit video track to a <video>; detaches on unmount.
// fit: 'cover' | 'contain' | 'smart' (fill only when the shapes match, see smartFit.js).
export function VideoView({ pub, mirror, fit = 'cover', className = '' }) {
  const ref = useRef(null);
  const track = pub?.videoTrack;
  const smart = useSmartFit(ref, fit === 'smart');
  useEffect(() => {
    if (!track || !ref.current) return;
    track.attach(ref.current);
    return () => track.detach(ref.current);
  }, [track]);
  if (!track) return null;
  const objectFit = fit === 'smart' ? smart : fit;
  return <video ref={ref} className={`rtc-video ${mirror ? 'mirror' : ''} ${className}`} style={{ objectFit }} data-fit={objectFit} autoPlay playsInline muted />;
}

// ---------- Sidebar: Discord-style voice channels with who's inside ----------
export function VoiceChannels() {
  const channels = useStore((s) => s.voiceChannels);
  const rtc = useStore((s) => s.rtc);
  const [open, setOpen] = useState(true);
  if (!channels.length) return null;
  return (
    <div className="voice-channels">
      <button className="list-section toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronLeft size={14} />} کانال‌های صوتی
      </button>
      {open &&
        channels.map((c) => (
          <div key={c.id} className={`vc ${rtc?.chatId === c.id ? 'active' : ''}`}>
            <div className="vc-row">
              <a href={`#/chat/${c.id}`} className="vc-name">
                <Volume2 size={16} /> {c.title}
              </a>
              {rtc?.chatId !== c.id && (
                <button className="btn sm ghost" onClick={() => run(() => joinVoice(c.id))}>
                  ورود
                </button>
              )}
            </div>
            {c.participants?.map((p) => (
              <div key={p.userId} className="vc-user">
                <Avatar id={p.userId} name={p.name} file={p.avatar} size={22} />
                <span>{p.name}</span>
                {p.screen && <span className="live-badge">LIVE</span>}
                {p.camera && <Video size={13} />}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

// ---------- Banner inside a chat: "voice chat in progress — join" ----------
export function VoiceBanner({ chat }) {
  const config = useStore((s) => s.config);
  const participants = useStore((s) => s.voiceRooms[chat.id]) || [];
  const listeners = useStore((s) => s.voiceMeta[chat.id]?.listeners) || 0;
  const rtc = useStore((s) => s.rtc);
  if (!config.rtc || !['group', 'channel', 'voice'].includes(chat.type)) return null;
  const inside = rtc?.chatId === chat.id;
  if (!participants.length && chat.type !== 'voice' && !inside) return null;
  const total = participants.length + listeners;
  return (
    <div className={`voice-banner ${inside ? 'inside' : ''}`}>
      <div className="vb-faces">
        {participants.slice(0, 5).map((p) => (
          <Avatar key={p.userId} id={p.userId} name={p.name} file={p.avatar} size={28} />
        ))}
        {!participants.length && (
          <span className="vb-icon">
            <Mic size={16} />
          </span>
        )}
      </div>
      <span className="grow vb-text">
        {participants.length ? `ویس‌چت · ${toFa(total)} نفر` : 'کسی داخل نیست'}
        {participants.some((p) => p.screen) && <span className="live-badge">LIVE</span>}
      </span>
      {inside ? (
        <button className="btn sm" onClick={expand}>
          نمایش
        </button>
      ) : (
        <button className="btn primary sm" onClick={() => run(() => joinVoice(chat.id))}>
          {participants.length ? 'پیوستن' : 'شروع ویس‌چت'}
        </button>
      )}
    </div>
  );
}

// ---------- Compact bar while connected ----------
export function VoiceBar() {
  const rtc = useStore((s) => s.rtc);
  const call = useStore((s) => s.call);
  if (!rtc || rtc.expanded) return null;
  const isCall = rtc.kind === 'call';
  const speaking = rtc.participants.filter((p) => p.speaking && !p.isLocal).map((p) => p.name);
  return (
    <div className="voice-bar">
      <button className="vbar-info" onClick={expand}>
        <span className={`dot ${rtc.state}`} />
        <span>
          <b>{isCall ? (call?.state === 'ringing' ? 'در حال زنگ زدن…' : 'در تماس') : 'متصل به ویس‌چت'}</b>
          <small>{speaking.length ? `در حال صحبت: ${speaking.join('، ')}` : rtc.title}</small>
        </span>
      </button>
      <Ping />
      <Controls compact />
    </div>
  );
}

// ---------- Control buttons ----------
function Controls({ compact }) {
  const rtc = useStore((s) => s.rtc);
  const [share, setShare] = useState(false);
  if (!rtc) return null;
  const isCall = rtc.kind === 'call';
  const speak = rtc.canSpeak !== false;
  const stream = speak && rtc.canStream;
  const s = compact ? 18 : 22;
  return (
    <div className={`rtc-controls ${compact ? 'compact' : ''}`}>
      {rtc.stage && !speak && (
        <button className={`ctl hand ${rtc.hand ? 'on' : ''}`} onClick={() => run(() => setHand(!rtc.hand))} title={rtc.hand ? 'پایین آوردن دست' : 'دست بلند کردن (درخواست صحبت)'}>
          <Hand size={s} />
        </button>
      )}
      {speak && !rtc.ptt && (
        <button className={`ctl ${rtc.micOn ? '' : 'off'}`} onClick={() => run(() => setMic(!rtc.micOn))} title={rtc.micOn ? 'بستن میکروفون' : 'باز کردن میکروفون'}>
          {rtc.micOn ? <Mic size={s} /> : <MicOff size={s} />}
        </button>
      )}
      {speak && rtc.ptt && (
        <button
          className={`ctl ptt ${rtc.micOn ? 'on' : ''}`}
          onPointerDown={() => setMic(true)}
          onPointerUp={() => setMic(false)}
          onPointerLeave={() => rtc.micOn && setMic(false)}
          title="برای صحبت نگه دارید (یا کلید Space)"
        >
          <Radio size={s} />
        </button>
      )}
      {!compact && (
        <button className={`ctl ${rtc.deafened ? 'off' : ''}`} onClick={() => setDeafened(!rtc.deafened)} title={rtc.deafened ? 'شنیدن' : 'قطع صدا'}>
          {rtc.deafened ? <HeadphoneOff size={s} /> : <Headphones size={s} />}
        </button>
      )}
      {!compact && (isCall || stream) && (
        <button className={`ctl ${rtc.camOn ? 'on' : ''}`} onClick={() => run(() => setCamera(!rtc.camOn))} title="دوربین">
          {rtc.camOn ? <Video size={s} /> : <VideoOff size={s} />}
        </button>
      )}
      {!compact && rtc.camOn && isTouch && (
        <button className="ctl" onClick={() => run(flipCamera)} title="تعویض دوربین">
          <SwitchCamera size={s} />
        </button>
      )}
      {!compact && stream && canShareScreen() && (
        <button className={`ctl ${rtc.screenOn ? 'on' : ''}`} onClick={() => (rtc.screenOn ? run(stopScreenShare) : setShare(true))} title="اشتراک صفحه (استریم)">
          {rtc.screenOn ? <ScreenShareOff size={s} /> : <ScreenShare size={s} />}
        </button>
      )}
      {!compact && speak && !isCall && (
        <button className={`ctl ${rtc.ptt ? 'on' : ''}`} onClick={() => setPtt(!rtc.ptt)} title="حالت بی‌سیم (Push-to-talk)">
          <Radio size={s} />
        </button>
      )}
      <button className="ctl hangup" onClick={() => run(isCall ? hangUp : leave)} title={isCall ? 'قطع تماس' : 'خروج'}>
        {isCall ? <PhoneOff size={s} /> : <LogOut size={s} />}
      </button>
      {share && <ShareDialog onClose={() => setShare(false)} />}
    </div>
  );
}

const SHARE_KEY = 'amorechat:share';
function lastShare() {
  try {
    return JSON.parse(localStorage.getItem(SHARE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function ShareDialog({ onClose }) {
  const max = useStore((s) => s.rtc?.streamQuality) || 720;
  const options = [480, 720, 1080].filter((q) => q <= max);
  const last = lastShare();
  const [quality, setQuality] = useState(options.includes(last.quality) ? last.quality : Math.min(max, 720));
  const maxFps = useStore((s) => s.rtc?.streamFps) || 30;
  const fpsOptions = [15, 30, 60].filter((f) => f <= maxFps);
  const [fps, setFps] = useState(fpsOptions.includes(last.fps) ? last.fps : 30);
  const [audio, setAudio] = useState(last.audio !== false);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal small" onClick={(e) => e.stopPropagation()}>
        <h3 className="with-icon">
          <MonitorPlay size={22} /> شروع استریم
        </h3>
        <p className="hint">بعد از «شروع»، مرورگر می‌پرسد چه چیزی نمایش داده شود: کل صفحه، یک پنجره یا یک تب.</p>
        <label className="form-label">کیفیت {max < 1080 && <small className="muted">(حداکثر مجاز شما {max}p)</small>}</label>
        <div className="segmented">
          {options.map((q) => (
            <button key={q} className={quality === q ? 'active' : ''} onClick={() => setQuality(q)}>
              {q}p
            </button>
          ))}
        </div>
        <label className="form-label">نرخ فریم</label>
        <div className="segmented">
          {fpsOptions.map((f) => (
            <button key={f} className={fps === f ? 'active' : ''} onClick={() => setFps(f)}>
              {toFa(f)} فریم {f === 15 ? '(متن و اسلاید)' : f === 30 ? '(ویدیو)' : '(بازی، روان‌ترین)'}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
          اشتراک صدای سیستم / تب
        </label>
        <div className="actions">
          <button className="btn" onClick={onClose}>
            انصراف
          </button>
          <button
            className="btn primary"
            onClick={() => {
              try {
                localStorage.setItem(SHARE_KEY, JSON.stringify({ quality, fps, audio }));
              } catch {
                /* not remembered */
              }
              onClose();
              run(() => startScreenShare({ quality, fps, audio }));
            }}
          >
            شروع
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------- Full view: Google Meet style grid with spotlight ----------

// Biggest tile size that fits n tiles of the given aspect ratio into w×h.
function bestGrid(n, w, h, aspect, gap) {
  let best = { cols: 1, tw: 0, th: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const tw = Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * aspect);
    if (tw > best.tw) best = { cols, tw, th: tw / aspect };
  }
  return best;
}

// Measures an element that may mount later (callback ref), e.g. when the view expands.
function useSize() {
  const [el, setEl] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

export function RoomView() {
  const rtc = useStore((s) => s.rtc);
  const me = useStore((s) => s.me);
  const chat = useStore((s) => (rtc?.chatId ? s.chats[rtc.chatId] : null));
  // null = automatic, 'grid' = user asked for everyone, otherwise the key of the spotlighted tile.
  const [spot, setSpot] = useState(null);
  const [gridRef, size] = useSize();
  useBackClose(!!rtc?.expanded, () => useStore.setState((s) => ({ rtc: s.rtc && { ...s.rtc, expanded: false } })));

  if (!rtc?.expanded) return null;
  // 1:1 calls get their own WhatsApp-style screen.
  if (rtc.kind === 'call') return <CallView />;

  const collapse = () => useStore.setState((s) => ({ rtc: { ...s.rtc, expanded: false } }));
  const stageAdmin = !!rtc.stage?.admin;
  const canMod = (perm) => stageAdmin || (!rtc.stage && !!chat && hasChatPerm(me, chat, perm));

  // One tile per person (camera or avatar) plus one per screen share.
  const tiles = [
    ...rtc.participants.filter((p) => p.screen).map((p) => ({ key: `s:${p.identity}`, type: 'screen', p, pub: p.screen })),
    ...rtc.participants.map((p) => ({ key: `p:${p.identity}`, type: 'person', p, pub: p.camera })),
  ];
  // Two tiles (you + one other): show the other one big, WhatsApp style.
  const auto = tiles.length === 2 ? tiles.find((t) => !(t.type === 'person' && t.p.isLocal))?.key : null;
  const spotKey = spot === 'grid' ? null : tiles.some((t) => t.key === spot) ? spot : auto;
  const main = tiles.find((t) => t.key === spotKey);
  const others = main ? tiles.filter((t) => t !== main) : [];

  const mobile = size.w && size.w < 700;
  const aspect = mobile && tiles.length > 2 ? 3 / 4 : 16 / 9;
  // The stage has 12px padding on each side.
  const grid = bestGrid(tiles.length, size.w - 24, size.h - 24, aspect, 10);

  const tileProps = (t, mode) => ({
    key: t.key,
    t,
    mode,
    chatId: rtc.chatId,
    canMute: canMod('mute_members'),
    canKick: canMod('ban_members'),
    stageAdmin,
    // Tap: open in spotlight; tap the spotlighted one again: back to everyone.
    onClick: () => setSpot(mode === 'main' ? 'grid' : t.key),
    onWatch: () => {
      watchStream(t.p.identity, true);
      setSpot(t.key);
    },
  });

  return (
    <div className="room-view">
      <header className="room-head">
        <button className="icon-btn" onClick={collapse} aria-label="کوچک کردن">
          <ChevronDown size={22} />
        </button>
        <div className="grow">
          <b>{rtc.title}</b>
          <small>
            {rtc.state === 'connecting' && 'در حال اتصال…'}
            {rtc.state === 'reconnecting' && 'اتصال قطع شد؛ در حال اتصال دوباره…'}
            {rtc.state === 'connected' && (
              <>
                <Users size={13} /> <RoomCount chatId={rtc.chatId} fallback={rtc.participants.length} stage={!!rtc.stage} />
              </>
            )}
          </small>
        </div>
        <Ping />
        {rtc.canSpeak === false && <span className="tag">{rtc.hand ? '✋ منتظر اجازه' : 'فقط شنونده'}</span>}
        {main && tiles.length > 1 && (
          <button className="icon-btn" onClick={() => setSpot('grid')} title="نمایش همه" aria-label="نمایش همه">
            <LayoutGrid size={20} />
          </button>
        )}
      </header>

      {stageAdmin && <StagePanel chatId={rtc.chatId} />}

      {!rtc.canPlayAudio && (
        <button className="btn primary audio-unlock" onClick={() => run(enableAudioPlayback)}>
          <Volume2 size={18} /> برای شنیدن صدا بزنید
        </button>
      )}

      <div className={`room-stage ${main ? (others.length === 1 ? 'spot pip-mode' : 'spot') : 'grid'}`} ref={gridRef}>
        {main ? (
          <>
            <div className="spot-main">
              <MeetTile {...tileProps(main, 'main')} />
            </div>
            {others.length === 1 ? (
              <div className="spot-pip">
                <MeetTile {...tileProps(others[0], 'pip')} />
              </div>
            ) : (
              <div className="filmstrip">
                {others.map((t) => (
                  <MeetTile {...tileProps(t, 'strip')} />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="meet-grid">
            {tiles.map((t) => (
              <div key={t.key} className="grid-cell" style={{ width: grid.tw || undefined, height: grid.th || undefined }}>
                <MeetTile {...tileProps(t, 'grid')} />
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="room-foot">
        <Controls />
      </footer>
    </div>
  );
}

// "3 speakers · 12 listeners" in stage voice chats, otherwise "N people".
function RoomCount({ chatId, fallback, stage }) {
  const participants = useStore((s) => s.voiceRooms[chatId]);
  const listeners = useStore((s) => s.voiceMeta[chatId]?.listeners) || 0;
  if (!stage || !participants) return <>{toFa(fallback)} نفر</>;
  const speakers = participants.filter((p) => p.speaker).length;
  const hearing = participants.length - speakers + listeners;
  return (
    <>
      {toFa(speakers)} سخنران · {toFa(hearing)} شنونده
    </>
  );
}

const AVATAR_SIZE = { main: 128, grid: 84, strip: 48, pip: 40 };

function MeetTile({ t, mode, chatId, canMute, canKick, stageAdmin, onClick, onWatch }) {
  const { p, pub, type } = t;
  const [menu, setMenu] = useState(false);
  const [level, setLevel] = useState('high');
  const needsWatch = type === 'screen' && !p.isLocal && !p.watching;
  const hasVideo = !!pub?.videoTrack && !needsWatch;
  // Screens are always shown whole; cameras fill the tile only when the shapes match.
  const fit = type === 'screen' ? 'contain' : mode === 'strip' || mode === 'pip' ? 'cover' : 'smart';
  // Everyone gets the menu on other people (volume); moderators also get the actions.
  const showMenu = type === 'person' && !p.isLocal && mode !== 'pip';

  const mod = (action, extra = {}) =>
    run(async () => {
      await api('POST', `/rtc/${chatId}/moderate`, { userId: p.userId, action, ...extra });
      setMenu(false);
    });

  return (
    <div className={`mtile ${mode} ${type} ${type === 'person' && p.speaking ? 'speaking' : ''} ${hasVideo ? 'has-video' : ''}`} onClick={onClick}>
      {needsWatch ? (
        <button
          className="watch-btn"
          onClick={(e) => {
            e.stopPropagation();
            onWatch();
          }}
        >
          <span className="live-badge">LIVE</span>
          <b>{p.name}</b>
          <span className="watch-cta">
            <Eye size={18} /> تماشای استریم
          </span>
        </button>
      ) : hasVideo ? (
        <VideoView pub={pub} mirror={type === 'person' && p.isLocal} fit={fit} />
      ) : (
        <div className="mtile-avatar">
          <Avatar id={p.userId} name={p.name} file={p.avatar} size={AVATAR_SIZE[mode]} />
        </div>
      )}

      {mode !== 'pip' && (
        <div className="mtile-label">
          {type === 'screen' && <ScreenShare size={14} />}
          {type === 'person' && !p.micOn && <MicOff size={14} className="muted-icon" />}
          <span>
            {type === 'screen' ? `صفحه ${p.isLocal ? 'شما' : p.name}` : p.name}
            {type === 'person' && p.isLocal && ' (شما)'}
          </span>
          {p.quality === 'poor' && <span className="tag danger">اتصال ضعیف</span>}
        </div>
      )}

      {mode === 'main' && hasVideo && !p.isLocal && (
        <select
          className="mtile-quality"
          value={level}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            setLevel(e.target.value);
            setStreamQuality(pub, e.target.value);
          }}
          aria-label="کیفیت دریافت"
        >
          <option value="high">کیفیت بالا</option>
          <option value="medium">متوسط</option>
          <option value="low">کم‌مصرف</option>
        </select>
      )}
      {type === 'screen' && p.watching && mode === 'main' && (
        <button
          className="mtile-stop"
          onClick={(e) => {
            e.stopPropagation();
            watchStream(p.identity, false);
          }}
        >
          توقف تماشا
        </button>
      )}

      {showMenu && (
        <button
          className="tile-more"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
          aria-label="مدیریت"
        >
          <EllipsisVertical size={18} />
        </button>
      )}
      {menu && (
        <div className="tile-menu" onClick={(e) => e.stopPropagation()}>
          <VolumeSlider userId={p.userId} label={`صدای ${p.name}`} />
          {p.screen && <VolumeSlider userId={p.userId} kind="stream" label="صدای استریم" />}
          {stageAdmin && (
            <button onClick={() => mod('revoke')}>
              <MicOff size={16} /> پس گرفتن اجازه صحبت
            </button>
          )}
          {canMute && (
            <button onClick={() => mod('mute')}>
              <MicOff size={16} /> بستن میکروفون
            </button>
          )}
          {canMute && (
            <button onClick={() => mod('stop_stream')}>
              <VideoOff size={16} /> توقف استریم/دوربین
            </button>
          )}
          {canKick && (
            <button className="danger" onClick={() => mod('kick')}>
              <LogOut size={16} /> بیرون کردن
            </button>
          )}
          {stageAdmin && (
            <button className="danger" onClick={() => confirm(`${p.name} بیرون شود و تا پایان این ویس‌چت نتواند برگردد؟`) && mod('kick', { ban: true })}>
              <Ban size={16} /> بیرون کردن و منع ورود
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Incoming call ----------
export function IncomingCall() {
  const call = useStore((s) => s.call);
  if (!call || call.role !== 'callee' || call.state !== 'ringing') return null;
  return (
    <div className="incoming-call" role="alertdialog" aria-label="تماس ورودی">
      <div className="ic-avatar">
        <Avatar id={call.peer.id} name={call.peer.displayName} file={call.peer.avatar} size={112} />
      </div>
      <h2>{call.peer.displayName}</h2>
      <p className="with-icon">
        {call.video ? <Video size={18} /> : <Phone size={18} />} {call.video ? 'تماس تصویری' : 'تماس صوتی'}
      </p>
      <div className="call-actions">
        <button className="call-btn decline" onClick={() => run(declineCall)} aria-label="رد تماس">
          <PhoneOff size={30} />
        </button>
        <button className="call-btn accept" onClick={() => run(acceptCall)} aria-label="پاسخ">
          {call.video ? <Video size={30} /> : <Phone size={30} />}
        </button>
      </div>
    </div>
  );
}

// Shows the expanded view automatically when a call starts.
export function useAutoExpandCalls() {
  const callId = useStore((s) => s.rtc?.callId);
  useEffect(() => {
    if (callId) useStore.setState((s) => ({ rtc: s.rtc && { ...s.rtc, expanded: true } }));
  }, [callId]);
}

