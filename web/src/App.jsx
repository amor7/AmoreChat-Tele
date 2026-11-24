import { useEffect, useState } from 'react';
import { api } from './api';
import { useStore } from './store';
import { connectSocket } from './socket';
import { ensureLatest } from './update';
import { Megaphone, X } from 'lucide-react';
import { loadEmoji } from './components/Emoji';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import ChatView from './components/ChatView';
import TeleView from './components/TeleView';
import Modals from './components/Modals';
import ConfirmHost from './components/ConfirmDialog';
import { EmptyState } from './components/States';
import { VoiceBar, RoomView, IncomingCall, useAutoExpandCalls } from './components/Voice';
import { MusicBar } from './components/Music';
import { initNative } from './native';
import { saveBoot, loadBoot, startOutbox, flushOutbox } from './offline';
import { useAppUpdateCheck } from './components/AndroidApp';

function parseHash() {
  // A shared link: /@name, or #/@name from inside the app.
  const at = location.pathname.match(/^\/@(\w+)\/?$/) || location.hash.match(/^#\/@(\w+)$/);
  if (at) return { kind: 'handle', value: at[1] };
  const [, kind, value] = location.hash.match(/^#\/(\w+)\/(.+)$/) || [];
  return { kind, value };
}

// The shared confirm / prompt dialogs work on every screen (sign-in and server list included).
export default function App() {
  return (
    <>
      <Screens />
      <ConfirmHost />
    </>
  );
}

function Screens() {
  const me = useStore((s) => s.me);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const config = await api('GET', '/config', null, { timeout: 8000 });
        document.title = config.siteName;
        useStore.setState({ config });
        // Server was updated but this device still runs the cached old app: update first.
        if (ensureLatest(config.version)) {
          setError('');
          setUpdating(true);
          return;
        }
        try {
          const { user } = await api('GET', '/auth/me', null, { timeout: 8000 });
          useStore.setState({ me: user });
          saveBoot(config, user);
        } catch (e) {
          if (e.status !== 401) throw e;
        }
      } catch (e) {
        // No connection: open with what this device saved last time (offline mode).
        const boot = !e.status && (await loadBoot().catch(() => null));
        if (boot?.me) {
          document.title = boot.config.siteName;
          useStore.setState({ config: boot.config, me: boot.me, offlineBoot: true });
        } else {
          setError(e.message);
        }
      }
      setLoading(false);
    })();
  }, []);

  if (updating) return <div className="splash">در حال به‌روزرسانی برنامه به نسخه جدید…</div>;
  if (loading) return <div className="splash">در حال بارگذاری…</div>;
  if (error)
    return (
      <div className="splash">
        <p>{error}</p>
        <button className="btn" onClick={() => location.reload()}>
          تلاش دوباره
        </button>
      </div>
    );
  if (!me) return <Auth invite={parseHash().kind === 'invite' ? parseHash().value : ''} />;
  return <Main />;
}

function Main() {
  const activeChatId = useStore((s) => s.activeChatId);
  const tele = useStore((s) => s.tele);
  const connected = useStore((s) => s.connected);
  const [ready, setReady] = useState(false);
  useAutoExpandCalls();
  useAppUpdateCheck();

  useEffect(() => {
    useStore
      .getState()
      .loadChats()
      .finally(() => setReady(true));
    connectSocket();
    startOutbox();
    loadEmoji();
    useStore.getState().loadFolders().catch(() => {});
    initNative();

    const onHash = () => {
      const { kind, value } = parseHash();
      const st = useStore.getState();
      // Telegram (#/tele, #/tele/<dialogId>) takes the place of the app's own chat list and chat.
      const tele = location.hash.match(/^#\/tele(?:\/(\d+))?\/?$/);
      useStore.setState({ tele: tele ? { dialogId: Number(tele[1]) || null } : null });
      if (tele) {
        useStore.setState({ activeChatId: null });
      } else if (kind === 'chat') {
        useStore.setState({ activeChatId: Number(value), replyTo: null, editing: null });
      } else {
        useStore.setState({ activeChatId: null });
        if (kind === 'join') st.openModal('join', { code: value });
        if (kind === 'handle') st.openModal('handle', { name: value });
      }
    };
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!ready) return <div className="splash">در حال بارگذاری…</div>;

  return (
    <div className={`layout ${activeChatId || tele?.dialogId ? 'has-chat' : ''}`}>
      {connected ? <QueueBar /> : <OfflineBar />}
      <EmergencyBanner />
      <div className="voice-area">
        <VoiceBar />
        <MusicBar />
      </div>
      {tele ? (
        <TeleView dialogId={tele.dialogId} />
      ) : (
        <>
          <Sidebar />
          <main className="chat-pane">{activeChatId ? <ChatView key={activeChatId} chatId={activeChatId} /> : <Empty />}</main>
        </>
      )}
      <Modals />
      <RoomView />
      <IncomingCall />
      <Toast />
    </div>
  );
}

function OfflineBar() {
  const queued = useStore((s) => s.outbox.filter((o) => !o.error).length);
  return (
    <div className="offline-bar" role="status" aria-live="polite">
      آفلاین — پیام‌های ذخیره‌شده نمایش داده می‌شوند؛ در حال تلاش برای اتصال…
      {queued > 0 && ` (${queued.toLocaleString('fa-IR')} پیام در صف ارسال)`}
    </div>
  );
}

// Online, but messages are still waiting (a voice uploading on a slow link, a server hiccup): the
// same bar, only after a few seconds so a normal send doesn't flash it, with a way to push now.
function QueueBar() {
  const queued = useStore((s) => s.outbox.filter((o) => !o.error).length);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!queued) return setShow(false);
    const t = setTimeout(() => setShow(true), 8000);
    return () => clearTimeout(t);
  }, [queued > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!queued || !show) return null;
  return (
    <div className="offline-bar queue-bar" role="status" aria-live="polite">
      {queued.toLocaleString('fa-IR')} پیام در صف ارسال
      <button className="queue-flush" onClick={() => flushOutbox()}>
        حالا بفرست
      </button>
    </div>
  );
}

function Empty() {
  const siteName = useStore((s) => s.config?.siteName);
  return <EmptyState icon={<img src="/icon.svg" alt="" width="72" height="72" />} title={siteName} hint="یک گفتگو را انتخاب کنید یا گفتگوی جدیدی شروع کنید." />;
}

function EmergencyBanner() {
  const m = useStore((s) => s.emergency);
  if (!m) return null;
  return (
    <div className="emergency-banner" role="alert">
      <button
        className="emergency-text"
        onClick={() => {
          location.hash = `#/chat/${m.chatId}`;
          useStore.setState({ emergency: null });
        }}
      >
        <Megaphone size={18} /> {m.text || 'اطلاعیه جدید'}
      </button>
      <button className="icon-btn" aria-label="بستن" onClick={() => useStore.setState({ emergency: null })}>
        <X size={18} />
      </button>
    </div>
  );
}

// The live region stays in the page and only its content changes: screen readers announce
// changes inside an existing region, not a region that appears together with its text.
function Toast() {
  const toast = useStore((s) => s.toast);
  return (
    <div className="toast-live" role="status" aria-live="polite" aria-atomic="true">
      {toast && <div className="toast">{toast.text}</div>}
    </div>
  );
}
