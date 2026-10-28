// Glue to the Android app (window.AmoreAndroid, see android/.../MainActivity.java).
// In a normal browser every function here is a no-op.
import { useStore } from './store';
import { leavingPage } from './backnav';

const bridge = typeof window !== 'undefined' ? window.AmoreAndroid : undefined;
export const isAndroidApp = !!bridge;
export const isAndroidBrowser = !bridge && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

export function appInfo() {
  try {
    return JSON.parse(bridge?.info() || 'null');
  } catch {
    return null;
  }
}

export const setBackgroundConnection = (on) => bridge?.setBackground(!!on);
export const openBatterySettings = () => bridge?.batterySettings();
export const openNotificationSettings = () => bridge?.notificationSettings();
export const openFullScreenSettings = () => bridge?.fullScreenSettings?.();
/** Newer apps install the update themselves; older ones get the APK link (their download handler). */
export function installAppUpdate() {
  if (bridge?.installUpdate) return bridge.installUpdate();
  // Apps before 0.7.2 can't download inside the app: install this one update from the browser.
  const link = location.origin + '/app';
  navigator.clipboard?.writeText(link).catch(() => {});
  useStore.getState().showToast('این نسخه اپ خودش آپدیت نمی‌شود. آدرس ' + link + ' کپی شد؛ آن را یک بار در مرورگر گوشی باز کنید و نصب کنید.');
}
export const changeServer = () => {
  leavingPage();
  bridge?.changeServer();
};

// ---------- Several servers (Android app 0.8+) ----------
export const multiServer = !!bridge?.servers;
export function appServers() {
  try {
    return JSON.parse(bridge?.servers?.() || '[]');
  } catch {
    return [];
  }
}
export const switchServer = (url) => {
  leavingPage();
  bridge?.switchServer?.(url);
};
export const addServer = () => {
  leavingPage();
  bridge?.addServer?.();
};
/** Leave a server completely: signed out there (when reachable) and everything about it removed from this phone. */
export async function removeServer(url) {
  leavingPage();
  if (appServers().find((s) => s.current)?.url === url) {
    const { api } = await import('./api');
    await api('POST', '/auth/logout', null, { timeout: 4000 }).catch(() => {});
  }
  bridge?.removeServer?.(url);
}
export const appLockSupported = !!bridge?.setAppLock;
export const appLockOn = () => !!bridge?.appLock?.();
export const setAppLock = (on) => bridge?.setAppLock?.(!!on);
export const nativeInCall = (on, title = '') => bridge?.inCall(!!on, String(title));

/** Downloads go through the app (saved to the phone's Downloads, with a progress notification). */
export function nativeDownload(url, name, mime = '') {
  if (!bridge) return false;
  bridge.download(url, name || 'file', mime || '');
  return true;
}

// ---------- Events from the app: open a chat, answer a call, files shared into the app ----------
let pendingAnswer = null;

/** Called by the call code when a call rings: was "Answer" already pressed in the notification? */
export function takePendingAnswer(callId) {
  if (pendingAnswer && pendingAnswer === callId) {
    pendingAnswer = null;
    return true;
  }
  return false;
}

async function handle(e) {
  const st = useStore.getState();
  if (e.type === 'open-chat') {
    location.hash = `#/chat/${e.chatId}`;
  } else if (e.type === 'answer') {
    const call = st.call;
    if (call?.id === e.callId && call.state === 'ringing') {
      const { acceptCall } = await import('./rtc');
      acceptCall().catch((err) => st.showToast(err.message));
    } else {
      pendingAnswer = e.callId;
    }
  } else if (e.type === 'servers' || e.type === 'lock') {
    // Another server got a message (badges), or the app lock changed.
    useStore.setState((s) => ({ nativeTick: (s.nativeTick || 0) + 1 }));
  } else if (e.type === 'update') {
    // Download progress of the in-app update (the update bar shows it).
    useStore.setState({ appUpdateState: { state: e.state, percent: e.percent } });
  } else if (e.type === 'share') {
    // Files come from a private URL the app serves; turn them into File objects.
    const files = [];
    for (const f of e.files || []) {
      try {
        const blob = await (await fetch(f.url)).blob();
        files.push(new File([blob], f.name || 'file', { type: f.type || blob.type }));
      } catch {
        /* skip unreadable */
      }
    }
    if (!files.length && !e.text) return;
    st.openModal('shareTarget', { files, text: e.text || '' });
  }
}

function drain() {
  const q = window.__amoreQ || [];
  window.__amoreQ = [];
  q.forEach((e) => handle(e).catch(() => {}));
}

export function initNative() {
  if (!bridge) return;
  document.documentElement.classList.add('android-app');
  window.addEventListener('amore-native', drain);
  drain();
  // Signed in now: the background connection can stop waiting and reconnect.
  bridge.signedIn?.();
}
