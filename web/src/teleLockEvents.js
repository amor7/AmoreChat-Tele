// The Telegram passcode lock as events, for any screen that shows something from Telegram
// (TeleView, the sidebar's Telegram button, the lock screens themselves). A hook module, not a
// component file, so non-UI code (useTeleEntry.js) need not import the passcode screens.
import { useEffect, useRef } from 'react';
import { TELE_LOCK_EVENT } from './api';

// Fired when any lock screen opens the lock, so the others on the page (the Telegram page behind
// a forward dialog) follow without a second passcode.
export const UNLOCK_EVENT = 'amore-tele-unlocked';
export const announceUnlock = () => {
  try {
    window.dispatchEvent(new CustomEvent(UNLOCK_EVENT));
  } catch {
    /* no window */
  }
};

/** Listens for any 423 heard by api.js (onLocked) and for an unlock done elsewhere (onUnlocked). */
export function useTeleLockEvent(onLocked, onUnlocked) {
  const ref = useRef({ onLocked, onUnlocked });
  ref.current = { onLocked, onUnlocked };
  useEffect(() => {
    const lock = () => ref.current.onLocked?.();
    const unlock = () => ref.current.onUnlocked?.();
    window.addEventListener(TELE_LOCK_EVENT, lock);
    window.addEventListener(UNLOCK_EVENT, unlock);
    return () => {
      window.removeEventListener(TELE_LOCK_EVENT, lock);
      window.removeEventListener(UNLOCK_EVENT, unlock);
    };
  }, []);
}
