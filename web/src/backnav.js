// Step-by-step "Back" (phone back button / browser back): an open dialog, menu or full-screen
// voice view closes first, before going back from a chat to the chat list.
// Each open layer adds one history entry; Back pops the top layer instead of navigating.
import { useEffect, useRef } from 'react';

const stack = []; // [{ id, close, closedByBack }]
let seq = 0;
// A layer closed by its own button removes its history entry with history.back(), which
// finishes later (popstate). A layer opened meanwhile (a menu item opening a dialog) must wait
// for it, or that late "back" would land on the new layer and close it at once.
let popping = 0;
let queued = [];
let popTimer;
// The app is about to load another page (another server, the add-server page): a late
// history.back() from a menu closing would undo that navigation, so history is left alone.
let leaving = false;
export function leavingPage() {
  leaving = true;
  popping = 0;
  queued = [];
  clearTimeout(popTimer);
  // Still here a while later (the other page never loaded): back to normal.
  setTimeout(() => (leaving = false), 4000);
}

function flush() {
  popping = 0;
  clearTimeout(popTimer);
  const q = queued;
  queued = [];
  for (const entry of q) if (stack.includes(entry)) history.pushState({ layer: entry.id }, '');
}

function push(entry) {
  if (leaving) return;
  if (popping) queued.push(entry);
  else history.pushState({ layer: entry.id }, '');
}

window.addEventListener('popstate', (e) => {
  if (popping) {
    // Our own history.back() arriving: nothing to close.
    if (--popping === 0) flush();
    return;
  }
  const top = stack.at(-1);
  if (top && e.state?.layer !== top.id) {
    stack.pop();
    top.closedByBack = true;
    top.close();
    return;
  }
  // An entry left behind by a layer that was closed another way: skip over it.
  if (!top && e.state?.layer) history.back();
});

// Android app's Back button asks here first: close the top layer directly (also works for
// dialogs opened without a tap, whose history entry the WebView would skip), and from a chat
// opened directly (a notification, a link) go to the chat list. false = use history.
window.__amoreBack = () => {
  const top = stack.at(-1);
  if (top) {
    top.close();
    return true;
  }
  if (location.hash.startsWith('#/chat/') && !history.state?.fromList) {
    history.replaceState(null, '', '#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return true;
  }
  return false;
};

/** Registers a closable layer while `open` is true. */
export function useBackClose(open, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = { id: ++seq, close: () => closeRef.current(), closedByBack: false };
    stack.push(entry);
    push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (entry.closedByBack || leaving) return;
      const q = queued.indexOf(entry);
      if (q >= 0) return void queued.splice(q, 1); // never got its entry
      // Closed by its own button: remove our history entry too, but only if it is still the
      // current one (opening a chat from a dialog already moved forward).
      if (history.state?.layer === entry.id) {
        popping++;
        clearTimeout(popTimer);
        popTimer = setTimeout(flush, 600); // safety: never wait forever
        history.back();
      }
    };
  }, [open]);
}
