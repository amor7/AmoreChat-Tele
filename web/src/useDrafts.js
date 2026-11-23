// React glue for drafts.js: the chat lists' "Draft: …" labels and the composers' saving.
import { useEffect, useMemo, useState } from 'react';
import { DRAFT_EVENT, listDrafts, draftSaver } from './drafts';

/** { [id]: text }, refreshed when a draft changes here or in another tab. */
export function useDrafts(uid, kind) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((n) => n + 1);
    window.addEventListener(DRAFT_EVENT, bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener(DRAFT_EVENT, bump);
      window.removeEventListener('storage', bump);
    };
  }, []);
  return useMemo(() => listDrafts(uid, kind), [uid, kind, version]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A debounced saver for one chat's draft. Written out at once when the page is hidden or closed
 * (phones kill background tabs without warning) and when the composer goes away.
 */
export function useDraftSaver(uid, kind, id) {
  const saver = useMemo(() => draftSaver(uid, kind, id), [uid, kind, id]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && saver.flush();
    window.addEventListener('pagehide', saver.flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', saver.flush);
      document.removeEventListener('visibilitychange', onHide);
      saver.flush();
    };
  }, [saver]);
  return saver;
}

/** First line of a draft for a list preview. */
export const draftPreview = (text) => (text || '').trim().split('\n')[0].slice(0, 120);
