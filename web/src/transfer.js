// Timers for one-shot transfers to and from the Telegram bridge (api.js wraps these).
// No imports on purpose: the unit tests in server/test load this file directly in Node.
//
// Why two clocks for an upload: on a slow link the file itself may take minutes to go up, so a
// fixed total timeout would cut working uploads; instead the upload fails only when it stops
// moving (stall). Once the last byte is out the server still has to pass the file through the
// VPN tunnel to Telegram, which can be slow too, so the wait for its answer gets its own, longer
// limit. A failure in that second phase is ambiguous: the message may already be in Telegram.

/**
 * Sends `body` on an already opened XMLHttpRequest-like object.
 * Resolves { status, text } once the server answers; rejects with an Error whose `kind` is
 * 'cancel' (signal aborted), 'stall' (upload stopped moving), 'network' (failed while uploading),
 * or 'late' (no answer, or the link broke, after the whole file was sent).
 */
export function watchedUpload(xhr, body, { onProgress, signal, stallMs = 45000, responseMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let sent = false;
    let settled = false;
    const arm = (ms, kind) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(kind), ms);
    };
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (kind) => {
      if (settled) return;
      finish();
      try {
        xhr.abort();
      } catch {}
      reject(Object.assign(new Error(kind), { kind }));
    };
    const onAbort = () => fail('cancel');
    // The upload is over: stop the stall clock and give the server its own time to answer.
    const uploaded = () => {
      if (sent || settled) return;
      sent = true;
      onProgress?.(1);
      arm(responseMs, 'late');
    };

    if (signal?.aborted) return fail('cancel');
    signal?.addEventListener('abort', onAbort);
    // Upload listeners must be set before send(), or some browsers never fire them.
    xhr.upload.onprogress = (e) => {
      if (sent || settled) return;
      if (e.lengthComputable && e.total) onProgress?.(Math.min(1, e.loaded / e.total));
      arm(stallMs, 'stall');
    };
    xhr.upload.onload = uploaded;
    // Headers back means the body is through even if upload events were skipped.
    xhr.onreadystatechange = () => xhr.readyState >= 2 && uploaded();
    xhr.onload = () => {
      if (settled) return;
      finish();
      resolve({ status: xhr.status, text: xhr.responseText || '' });
    };
    xhr.onerror = () => fail(sent ? 'late' : 'network');
    xhr.onabort = () => fail('cancel');
    arm(stallMs, 'stall');
    xhr.send(body);
  });
}

/**
 * fetch() that gives up when the server takes longer than `responseMs` to start answering
 * (it may first fetch the file from Telegram) or the body stops arriving for `stallMs`.
 * Resolves { status, ok, blob } for success and { status, ok, text } for an error answer;
 * rejects with an Error whose `kind` is 'cancel', 'connect' (no answer at all), 'late',
 * 'stall' or 'broken' (the link broke mid-body).
 * `onProgress(received, total)` follows the body as it arrives (total 0 when the server sent no
 * length); it only watches the bytes, the request itself is the same with or without it.
 */
export async function watchedDownload(fetchFn, url, init, { signal, stallMs = 45000, responseMs = 5 * 60 * 1000, onProgress } = {}) {
  const ctl = new AbortController();
  let why = null;
  let timer = null;
  const stop = (kind) => {
    why ??= kind;
    ctl.abort();
  };
  const arm = (ms, kind) => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(kind), ms);
  };
  const error = (fallback) => Object.assign(new Error(why || fallback), { kind: why || fallback });
  const onAbort = () => stop('cancel');
  if (signal?.aborted) throw Object.assign(new Error('cancel'), { kind: 'cancel' });
  signal?.addEventListener('abort', onAbort);
  try {
    arm(responseMs, 'late');
    let res;
    try {
      res = await fetchFn(url, { ...init, signal: ctl.signal });
    } catch {
      throw error('connect');
    }
    arm(stallMs, 'stall');
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {}
      return { status: res.status, ok: false, text };
    }
    const parts = [];
    const total = Number(res.headers?.get?.('content-length')) || 0;
    let received = 0;
    try {
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          arm(stallMs, 'stall');
          received += value?.length || 0;
          onProgress?.(received, total);
        }
      } else {
        // Old WebViews without streams: one step, at the end.
        const blob = await res.blob();
        parts.push(blob);
        onProgress?.(blob.size, total || blob.size);
      }
    } catch {
      throw error('broken');
    }
    return { status: res.status, ok: true, blob: new Blob(parts, { type: res.headers?.get?.('content-type') || '' }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** The plain-http address of a path on this server (http://host/path), for things a phone must
 * open before it trusts the server's own certificate authority (the bundled Caddy serves /app*
 * and /ca on port 80 for every address). A page already on http keeps its own origin and port. */
export function plainHttpUrl(loc, path) {
  if (loc.protocol === 'http:') return `${loc.origin}${path}`;
  return `http://${loc.hostname}${path}`;
}
