// Unsent text per chat, kept on this device (localStorage) so a reload, a crash or a dropped
// connection never throws away what the user was writing.
// No imports on purpose: the unit tests load this file in plain Node.

export const DRAFT_PREFIX = 'amore.draft.';
export const DRAFT_MAX = 20000;
// Fired on window whenever a stored draft changes, so chat lists can show "Draft: …".
export const DRAFT_EVENT = 'amore-drafts';

// Storage can be missing or throw on access (private mode, blocked site data): every use is guarded.
function store(storage) {
  try {
    return storage || globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function changed() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent(DRAFT_EVENT));
  } catch {
    /* no window events here */
  }
}

/** kind: 'chat' (the app's own chats) | 'tele' (Telegram dialogs). */
export const draftKey = (uid, kind, id) => `${DRAFT_PREFIX}u${uid}:${kind}:${id}`;

export function loadDraft(uid, kind, id, storage) {
  try {
    return store(storage)?.getItem(draftKey(uid, kind, id)) || '';
  } catch {
    return '';
  }
}

/** Saves the text, or removes the draft when it is only whitespace. False when storage refused. */
export function saveDraft(uid, kind, id, text, storage) {
  const s = store(storage);
  if (!s) return false;
  const k = draftKey(uid, kind, id);
  const value = String(text ?? '').slice(0, DRAFT_MAX);
  try {
    if (!value.trim()) {
      if (s.getItem(k) == null) return true;
      s.removeItem(k);
    } else {
      if (s.getItem(k) === value) return true;
      s.setItem(k, value);
    }
  } catch {
    // Quota full or storage blocked: the draft only lives in the text box this time.
    return false;
  }
  changed();
  return true;
}

export const clearDraft = (uid, kind, id, storage) => saveDraft(uid, kind, id, '', storage);

function keys(s) {
  const out = [];
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) out.push(k);
    }
  } catch {
    /* unreadable storage: no drafts */
  }
  return out;
}

/** { [id]: text } of one user's drafts of one kind. */
export function listDrafts(uid, kind, storage) {
  const s = store(storage);
  const out = {};
  if (!s) return out;
  const prefix = `${DRAFT_PREFIX}u${uid}:${kind}:`;
  for (const k of keys(s)) {
    if (!k.startsWith(prefix)) continue;
    try {
      const v = s.getItem(k);
      if (v && v.trim()) out[k.slice(prefix.length)] = v;
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Every user's drafts on this device (sign-out: nothing left behind on a shared phone). */
export function clearAllDrafts(storage) {
  const s = store(storage);
  if (!s) return;
  const all = keys(s);
  for (const k of all) {
    try {
      s.removeItem(k);
    } catch {
      /* skip */
    }
  }
  if (all.length) changed();
}

/**
 * Writes the draft a moment after typing stops instead of on every key. flush() writes the
 * pending text now (page hidden or closed, chat switched); cancel() drops it.
 */
export function draftSaver(uid, kind, id, { delay = 500, storage } = {}) {
  let timer = null;
  let pending = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    saveDraft(uid, kind, id, text, storage);
  };
  return {
    set(text) {
      pending = String(text ?? '');
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
