import { watchedUpload, watchedDownload } from './transfer';

export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// The Telegram section answers 423 while its passcode lock is on. Any request that hears it
// (a poll, an upload, a forward) tells the screens at once, so they can hide what they show.
export const TELE_LOCK_EVENT = 'amore-tele-locked';
export const TELE_LOCKED = 423;
// The session is gone (401 outside the sign-in requests): open confirm dialogs are dropped.
export const SIGNED_OUT_EVENT = 'amore-signed-out';
function heardSignedOut(status, url) {
  if (status !== 401 || url.startsWith('/auth/')) return;
  try {
    window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
  } catch {
    /* no window */
  }
}
function heardLock(status) {
  if (status !== TELE_LOCKED) return;
  try {
    window.dispatchEvent(new CustomEvent(TELE_LOCK_EVENT));
  } catch {
    /* no window */
  }
}

// Every request gives up after a while: with the server unreachable (e.g. its domain can't be
// resolved during an internet shutdown) the app must fall back to offline mode, not wait forever.
// `headers` adds request headers (e.g. x-amore-poll: 1 marks an automatic check, which must not
// count as the user being active for the Telegram auto-lock).
export async function api(method, url, body, { timeout = 20000, headers } = {}) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      signal: AbortSignal.timeout(timeout),
      credentials: 'same-origin',
      headers: { ...headers, 'x-requested-with': 'amorechat', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد', 0);
  }
  // A weak link can cut the answer short: that is a failed request, not an empty answer.
  const text = await res.text().catch(() => null);
  if (text === null) throw new ApiError('ارتباط با سرور قطع شد', 0);
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError('پاسخ سرور ناقص رسید', 0);
  }
  if (!res.ok) {
    heardLock(res.status);
    heardSignedOut(res.status, url);
    // data goes along: some refusals say more than the message (e.g. how long a lock lasts).
    throw new ApiError(data.error || 'خطا در ارتباط با سرور', res.status, data);
  }
  return data;
}

export const CANCELLED = -1;

// The server's JSON answer, or { error } the way api() reports it.
function parseAnswer(status, text, fallback) {
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (status >= 200 && status < 300) throw new ApiError('پاسخ سرور ناقص رسید', 0);
  }
  if (status < 200 || status >= 300) {
    heardLock(status);
    throw new ApiError(data.error || fallback, status, data);
  }
  return data;
}

export const LATE = 'پاسخ سرور دیر شد؛ ممکن است فرستاده شده باشد — قبل از ارسال دوباره چت را نگاه کنید';
const TRANSFER_ERRORS = {
  cancel: ['ارسال لغو شد', CANCELLED],
  stall: ['ارسال متوقف شد؛ اتصال خیلی کند یا قطع است', 0],
  network: ['ارتباط با سرور قطع شد', 0],
  late: [LATE, 0],
};

// A one-shot form upload to the Telegram bridge (photo, voice, file), with progress. Fails when
// the upload stops moving, not after a fixed total time; see transfer.js for the two clocks.
// `url` is under /api, like api().
export async function teleUpload(url, formData, { onProgress, signal, stallMs = 45000, responseMs = 5 * 60 * 1000, errorText = 'ارسال ناموفق بود' } = {}) {
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api' + url);
  xhr.withCredentials = true;
  xhr.setRequestHeader('x-requested-with', 'amorechat');
  let r;
  try {
    r = await watchedUpload(xhr, formData, { onProgress, signal, stallMs, responseMs });
  } catch (e) {
    const [msg, status] = TRANSFER_ERRORS[e.kind] || TRANSFER_ERRORS.network;
    throw new ApiError(msg, status);
  }
  // Status 0 with no answer: the browser dropped it (offline, blocked); treat like a lost answer.
  if (!r.status) throw new ApiError(LATE, 0);
  return parseAnswer(r.status, r.text, errorText);
}

const DOWNLOAD_ERRORS = {
  cancel: ['دانلود لغو شد', CANCELLED],
  connect: ['ارتباط با سرور برقرار نشد', 0],
  late: ['پاسخ سرور دیر شد؛ دوباره امتحان کنید', 0],
  stall: ['دانلود متوقف شد؛ اتصال خیلی کند یا قطع است', 0],
  broken: ['ارتباط با سرور قطع شد', 0],
};

// A media download from the Telegram bridge as a Blob. Same headers and errors as api(); gives
// up only when the server is silent too long or the data stops arriving, never mid-progress.
export async function teleDownload(url, { signal, stallMs = 45000, responseMs = 5 * 60 * 1000, errorText = 'دانلود ناموفق بود' } = {}) {
  let r;
  try {
    r = await watchedDownload(fetch, '/api' + url, { credentials: 'same-origin', headers: { 'x-requested-with': 'amorechat' } }, { signal, stallMs, responseMs });
  } catch (e) {
    const [msg, status] = DOWNLOAD_ERRORS[e.kind] || DOWNLOAD_ERRORS.broken;
    throw new ApiError(msg, status);
  }
  if (!r.ok) parseAnswer(r.status, r.text, errorText);
  return r.blob;
}

export const fileUrl = (id, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`;


// One chunk over XHR (fetch has no upload progress).
function putChunk(id, chunk, offset, onLoaded, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const done = () => signal?.removeEventListener('abort', onAbort);
    xhr.onabort = () => (done(), reject(new ApiError('ارسال لغو شد', CANCELLED)));
    xhr.open('PUT', `/api/uploads/${id}`);
    xhr.setRequestHeader('x-requested-with', 'amorechat');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('upload-offset', String(offset));
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () => {
      done();
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(data.error || 'آپلود ناموفق بود', xhr.status, data));
    };
    xhr.onerror = xhr.ontimeout = () => (done(), reject(new ApiError('ارتباط با سرور قطع شد', 0)));
    xhr.send(chunk);
  });
}

// Waits, but wakes up early when the browser comes back online; rejects if cancelled.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(t);
      window.removeEventListener('online', finish);
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(t);
      window.removeEventListener('online', finish);
      reject(new ApiError('ارسال لغو شد', CANCELLED));
    };
    const t = setTimeout(finish, ms);
    window.addEventListener('online', finish);
    signal?.addEventListener('abort', cancel);
  });
}

// Resumable upload: the file goes up in 4 MB chunks. If the connection drops (or the server
// restarts) it waits, asks the server how much arrived, and continues from there.
// onStatus('waiting' | null) lets the UI say "waiting for the connection…".
// resumeId continues a session started earlier (e.g. before a reload; onSession(id) reports each
// new one so the caller can keep it). A session the server no longer has starts over.
// maxFailures: give up after that many failed chunks in a row (default: never) with a temporary
// error (status 0, or the server's 5xx / 408); the session stays, so resumeId continues it later.
const UPLOAD_CHUNK = 4 * 1024 * 1024; // the server's chunk size (its body limit allows no more)
export async function upload(blob, { name, meta = {}, onProgress, onStatus, signal, resumeId, onSession, maxFailures = 0 } = {}) {
  let id = null;
  let chunkSize = UPLOAD_CHUNK;
  let offset = 0;
  if (resumeId) {
    try {
      const s = await api('GET', `/uploads/${resumeId}`);
      if (s.size === blob.size && Number.isFinite(s.offset)) {
        id = resumeId;
        offset = s.offset;
      } else {
        api('DELETE', `/uploads/${resumeId}`).catch(() => {});
      }
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  if (!id) {
    const cleanMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null));
    const session = await api('POST', '/uploads', { name: name || blob.name || 'file', size: blob.size, mime: blob.type || 'application/octet-stream', meta: cleanMeta });
    ({ id, chunkSize } = session);
    offset = session.offset;
    onSession?.(id);
  }
  let wait = 1000;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) {
      api('DELETE', `/uploads/${id}`).catch(() => {});
      throw new ApiError('ارسال لغو شد', CANCELLED);
    }
    try {
      const r = await putChunk(id, blob.slice(offset, offset + chunkSize), offset, (loaded) => onProgress?.(blob.size ? Math.min(1, (offset + loaded) / blob.size) : 1), signal);
      onStatus?.(null);
      wait = 1000;
      failures = 0;
      if (r.file) return r.file;
      offset = r.offset;
    } catch (e) {
      if (e.status === CANCELLED) {
        api('DELETE', `/uploads/${id}`).catch(() => {});
        throw e;
      }
      if (e.status === 409 && Number.isFinite(e.data?.offset)) {
        offset = e.data.offset;
        continue;
      }
      // A real refusal (too big, quota, expired…): stop. Network trouble / server down: keep trying.
      if (e.status && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      if (maxFailures && ++failures >= maxFailures) {
        onStatus?.(null);
        throw new ApiError(e.message, e.status >= 500 || e.status === 408 ? e.status : 0);
      }
      onStatus?.('waiting');
      await pause(wait, signal);
      wait = Math.min(wait * 2, 15000);
      try {
        offset = (await api('GET', `/uploads/${id}`)).offset;
      } catch (e2) {
        if (e2.status === 404) throw e2;
      }
    }
  }
}
