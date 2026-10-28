import { registerSW } from 'virtual:pwa-register';

// The installed app runs from its own cache. Without this, a phone keeps showing the
// old version until it is restarted a couple of times after the server is updated.
let registration = null;

// autoUpdate mode: once a new service worker takes control, the page reloads itself.
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    registration = reg;
    if (!reg) return;
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
  },
});

// Called with the server's version: if it differs from this build, fetch the new one now.
export function ensureLatest(serverVersion) {
  if (!serverVersion || serverVersion === __APP_VERSION__) return false;
  const key = `ac_updated_to_${serverVersion}`;
  try {
    if (sessionStorage.getItem(key)) return false; // already tried once this session
    sessionStorage.setItem(key, '1');
  } catch {
    /* private mode */
  }
  (async () => {
    try {
      const reg = registration || (await navigator.serviceWorker?.getRegistration());
      await reg?.update();
    } catch {
      /* offline or no service worker */
    }
    // The new worker normally reloads us when it takes over; this is the fallback.
    setTimeout(() => location.reload(), 6000);
  })();
  return true;
}

export const APP_VERSION = __APP_VERSION__;
