// The sidebar's Telegram button: shown for a connected account (and while the section is
// locked), with the unread count of the chats the user added. One cheap check of the status a
// minute at most (three in data saver), only while the app is visible, marked as a poll so it
// never keeps the Telegram passcode lock awake. TeleView shares its own answers through
// publishTeleStatus, so the sidebar asks nothing while (or right after) the Telegram page was open.
import { useEffect } from 'react';
import { useStore, dataSaverNow } from './store';
import { TELE_LOCKED } from './api';
import { teleStatus } from './teleApi';
import { teleEntry } from './tele-rules';
import { useTeleLockEvent } from './teleLockEvents';

const EVERY_MS = 60000;
let inFlight = false;
let lastAt = 0; // when the store's entry was last set (kept out of the store: no re-render)
let lockVersion = 0; // bumped on every lock: an answer that started before it is stale

/**
 * Puts a /api/tele/status answer on the sidebar button (TeleView calls this with each of its own
 * answers). Only a real change touches the store. `stopped`: no account to follow (no access, or
 * not connected): the sidebar stops asking until a reload or until TeleView publishes again.
 */
export function publishTeleStatus(status) {
  lastAt = Date.now();
  const e = teleEntry(status);
  setEntry({ show: e.show, unread: e.unread, stopped: !e.show });
}

function setEntry(next) {
  const cur = useStore.getState().teleEntry;
  if (cur && cur.show === next.show && cur.unread === next.unread && cur.stopped === next.stopped) return;
  useStore.setState({ teleEntry: next });
}

const LOCKED = { access: true, locked: true };

function check(force = false) {
  const cur = useStore.getState().teleEntry;
  if (inFlight || document.visibilityState === 'hidden') return;
  if (!force) {
    if (cur?.stopped) return;
    // A little under the interval: the timer itself must not skip every other round.
    const every = EVERY_MS * (dataSaverNow() ? 3 : 1);
    if (cur && Date.now() - lastAt < every - 5000) return;
  }
  inFlight = true;
  const version = lockVersion;
  teleStatus(true)
    .then((s) => version === lockVersion && publishTeleStatus(s))
    // Locked (423): the button stays, without a number. Other failures (offline, server down)
    // keep what was shown and try again next round.
    .catch((e) => e.status === TELE_LOCKED && publishTeleStatus(LOCKED))
    .finally(() => {
      inFlight = false;
    });
}

/** { show, unread } for the sidebar; starts and stops its check with the sidebar. */
export function useTeleEntry() {
  const entry = useStore((s) => s.teleEntry);
  useEffect(() => {
    check();
    const t = setInterval(check, EVERY_MS);
    const onVisible = () => check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  // Locked anywhere (a 423 heard by any request): the number goes at once, and an answer still on
  // its way (asked before the lock) is dropped. Unlocked: ask again.
  useTeleLockEvent(
    () => {
      lockVersion++;
      publishTeleStatus(LOCKED);
    },
    () => check(true),
  );
  return entry || { show: false, unread: 0 };
}
