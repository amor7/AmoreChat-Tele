export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Every request gives up after a while: with the server unreachable (e.g. its domain can't be
// resolved during an internet shutdown) the app must fall back to offline mode, not wait forever.
export async function api(method, url, body, { timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      signal: AbortSignal.timeout(timeout),
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'amorechat', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد', 0);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(data.error || 'خطا در ارتباط با سرور', res.status);
  return data;
}

export const fileUrl = (id, download = false) => `/api/files/${id}${download ? '?download=1' : ''}`;

export const CANCELLED = -1;

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
export async function upload(blob, { name, meta = {}, onProgress, onStatus, signal } = {}) {
  const cleanMeta = Object.fromEntries(Object.entries(meta).filter(([, v]) => v != null));
  const session = await api('POST', '/uploads', { name: name || blob.name || 'file', size: blob.size, mime: blob.type || 'application/octet-stream', meta: cleanMeta });
  const { id, chunkSize } = session;
  let offset = session.offset;
  let wait = 1000;
  for (;;) {
    if (signal?.aborted) {
      api('DELETE', `/uploads/${id}`).catch(() => {});
      throw new ApiError('ارسال لغو شد', CANCELLED);
    }
    try {
      const r = await putChunk(id, blob.slice(offset, offset + chunkSize), offset, (loaded) => onProgress?.(blob.size ? Math.min(1, (offset + loaded) / blob.size) : 1), signal);
      onStatus?.(null);
      wait = 1000;
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
