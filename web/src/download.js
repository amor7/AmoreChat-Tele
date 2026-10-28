import { useStore } from './store';
import { nativeDownload } from './native';

// In-app downloads with progress and cancel (a plain <a download> gives neither).
const controllers = new Map();

function setEntry(key, value) {
  useStore.setState((s) => {
    const downloads = { ...s.downloads };
    if (value) downloads[key] = value;
    else delete downloads[key];
    return { downloads };
  });
}

export async function startDownload(key, url, filename) {
  if (controllers.has(key)) return;
  // Android app: saved straight into the phone's Downloads folder.
  if (nativeDownload(url, filename)) return;
  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  setEntry(key, { progress: 0, received: 0 });
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'دانلود ناموفق بود');
    }
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let lastPaint = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      // Throttle store updates; a chunk arrives every few milliseconds.
      if (Date.now() - lastPaint > 150) {
        lastPaint = Date.now();
        setEntry(key, { progress: total ? received / total : null, received });
      }
    }
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  } catch (e) {
    useStore.getState().showToast(e.name === 'AbortError' ? 'دانلود لغو شد' : e.message || 'دانلود ناموفق بود');
  } finally {
    controllers.delete(key);
    setEntry(key, null);
  }
}

export const cancelDownload = (key) => controllers.get(key)?.abort();
