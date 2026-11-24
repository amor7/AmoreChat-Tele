// Upload/download clocks of the web app's Telegram transfers (web/src/transfer.js).
// Usage: node --test server/test/transfer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { watchedUpload, watchedDownload, plainHttpUrl } from '../../web/src/transfer.js';

// Just enough of XMLHttpRequest: the test drives its events by hand.
function fakeXhr() {
  return {
    upload: {},
    readyState: 1,
    status: 0,
    responseText: '',
    aborted: false,
    sentBody: null,
    send(body) {
      this.sentBody = body;
    },
    abort() {
      this.aborted = true;
      this.onabort?.();
    },
    progress(loaded, total) {
      this.upload.onprogress?.({ lengthComputable: true, loaded, total });
    },
    answer(status, text) {
      this.readyState = 4;
      this.status = status;
      this.responseText = text;
      this.onreadystatechange?.();
      this.onload?.();
    },
  };
}
const kindOf = (p) => p.then(() => 'resolved', (e) => e.kind);

test('upload: a slow but moving upload is never cut, a stopped one is', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const xhr = fakeXhr();
  const p = kindOf(watchedUpload(xhr, 'body', { stallMs: 1000, responseMs: 60000 }));
  for (let i = 1; i <= 10; i++) {
    t.mock.timers.tick(900); // 9 s in total, longer than stallMs, but always moving
    xhr.progress(i, 100);
  }
  assert.equal(xhr.aborted, false);
  t.mock.timers.tick(1000);
  assert.equal(await p, 'stall');
  assert.equal(xhr.aborted, true);
});

test('upload: after the last byte only the long answer clock runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const xhr = fakeXhr();
  const seen = [];
  const p = watchedUpload(xhr, 'body', { stallMs: 1000, responseMs: 60000, onProgress: (v) => seen.push(v) });
  xhr.progress(50, 100);
  xhr.upload.onload();
  t.mock.timers.tick(30000); // way past stallMs: the server is still sending to Telegram
  assert.equal(xhr.aborted, false);
  xhr.answer(200, '{"message":{"id":1}}');
  assert.deepEqual(await p, { status: 200, text: '{"message":{"id":1}}' });
  assert.deepEqual(seen, [0.5, 1]);
});

test('upload: no answer in time after the upload is "late" (may have been sent)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const xhr = fakeXhr();
  const p = kindOf(watchedUpload(xhr, 'body', { stallMs: 1000, responseMs: 5000 }));
  xhr.upload.onload();
  t.mock.timers.tick(5000);
  assert.equal(await p, 'late');
});

test('upload: headers back count as uploaded even without upload events', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const xhr = fakeXhr();
  const p = kindOf(watchedUpload(xhr, 'body', { stallMs: 1000, responseMs: 5000 }));
  xhr.readyState = 2;
  xhr.onreadystatechange();
  t.mock.timers.tick(3000);
  assert.equal(xhr.aborted, false);
  t.mock.timers.tick(2000);
  assert.equal(await p, 'late');
});

test('upload: a network error is "network" before the end and "late" after it', async () => {
  const a = fakeXhr();
  const pa = kindOf(watchedUpload(a, 'x', { stallMs: 60000 }));
  a.onerror();
  assert.equal(await pa, 'network');
  const b = fakeXhr();
  const pb = kindOf(watchedUpload(b, 'x', { stallMs: 60000 }));
  b.upload.onload();
  b.onerror();
  assert.equal(await pb, 'late');
});

test('upload: cancel aborts; an already aborted signal never sends', async () => {
  const xhr = fakeXhr();
  const ctl = new AbortController();
  const p = kindOf(watchedUpload(xhr, 'x', { signal: ctl.signal, stallMs: 60000 }));
  ctl.abort();
  assert.equal(await p, 'cancel');
  assert.equal(xhr.aborted, true);
  const ctl2 = new AbortController();
  ctl2.abort();
  const xhr2 = fakeXhr();
  assert.equal(await kindOf(watchedUpload(xhr2, 'x', { signal: ctl2.signal })), 'cancel');
  assert.equal(xhr2.sentBody, null);
});

test('upload: an error answer is passed on for the caller to read', async () => {
  const xhr = fakeXhr();
  const p = watchedUpload(xhr, 'x', { stallMs: 60000 });
  xhr.answer(413, '{"error":"too big"}');
  assert.deepEqual(await p, { status: 413, text: '{"error":"too big"}' });
});

// A response whose body arrives in chunks the test releases.
function streamed(chunks, { status = 200, type = 'image/jpeg' } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h === 'content-type' ? type : null) },
    body: {
      getReader: () => ({
        read: async () => {
          const c = chunks[i++];
          if (c === undefined) return { done: true };
          if (typeof c === 'function') return c();
          return { done: false, value: c };
        },
      }),
    },
    text: async () => chunks.join(''),
  };
}

test('download: the body comes back as a Blob with its type', async () => {
  let init;
  const fetchFn = async (url, i) => ((init = i), streamed([new Uint8Array([1, 2]), new Uint8Array([3])]));
  const r = await watchedDownload(fetchFn, '/api/x', { headers: { a: 'b' } }, {});
  assert.equal(r.ok, true);
  assert.equal(r.blob.type, 'image/jpeg');
  assert.deepEqual([...new Uint8Array(await r.blob.arrayBuffer())], [1, 2, 3]);
  assert.equal(init.headers.a, 'b');
  assert.ok(init.signal instanceof AbortSignal);
});

test('download: progress follows the body, with the length the server sent (0 when none)', async () => {
  const withLength = (chunks, length) => {
    const res = streamed(chunks);
    res.headers = { get: (h) => (h === 'content-length' ? length : h === 'content-type' ? 'image/jpeg' : null) };
    return res;
  };
  const seen = [];
  await watchedDownload(async () => withLength([new Uint8Array([1, 2]), new Uint8Array([3])], '3'), '/x', {}, { onProgress: (r, t) => seen.push([r, t]) });
  assert.deepEqual(seen, [
    [2, 3],
    [3, 3],
  ]);
  const unknown = [];
  await watchedDownload(async () => streamed([new Uint8Array([1])]), '/x', {}, { onProgress: (r, t) => unknown.push([r, t]) });
  assert.deepEqual(unknown, [[1, 0]]);
  // No progress callback: the same download, nothing else asked for.
  const r = await watchedDownload(async () => streamed([new Uint8Array([7])]), '/x', {}, {});
  assert.deepEqual([...new Uint8Array(await r.blob.arrayBuffer())], [7]);
});

test('download: without streams (old WebViews) progress comes once, at the end', async () => {
  const seen = [];
  const res = { ok: true, status: 200, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])]) };
  const r = await watchedDownload(async () => res, '/x', {}, { onProgress: (a, b) => seen.push([a, b]) });
  assert.equal(r.blob.size, 4);
  assert.deepEqual(seen, [[4, 4]]);
});

test('download: an error answer is returned as text', async () => {
  const r = await watchedDownload(async () => streamed(['{"error":"no"}'], { status: 403 }), '/x', {}, {});
  assert.deepEqual(r, { status: 403, ok: false, text: '{"error":"no"}' });
});

test('download: no connection, a silent server and a stalled body are told apart', async (t) => {
  assert.equal(
    await kindOf(
      watchedDownload(
        async () => {
          throw new TypeError('Failed to fetch');
        },
        '/x',
        {},
        {},
      ),
    ),
    'connect',
  );

  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Server silent: fetch only rejects when its signal aborts.
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const late = kindOf(watchedDownload(hang, '/x', {}, { responseMs: 5000 }));
  t.mock.timers.tick(5000);
  assert.equal(await late, 'late');

  // Body stops arriving after one chunk.
  let signal;
  const stuck = () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const stalled = kindOf(watchedDownload(async (url, init) => ((signal = init.signal), streamed([new Uint8Array([1]), stuck])), '/x', {}, { stallMs: 1000 }));
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1000);
  assert.equal(await stalled, 'stall');
});

test('download: cancel', async () => {
  const ctl = new AbortController();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const p = kindOf(watchedDownload(hang, '/x', {}, { signal: ctl.signal }));
  ctl.abort();
  assert.equal(await p, 'cancel');
});

test('plainHttpUrl: https pages point at plain http on the same host; http pages keep their origin', () => {
  assert.equal(plainHttpUrl(new URL('https://chat.example.ir/#/x'), '/app'), 'http://chat.example.ir/app');
  assert.equal(plainHttpUrl(new URL('https://chat.example.ir:8443/'), '/ca'), 'http://chat.example.ir/ca');
  assert.equal(plainHttpUrl(new URL('https://10.0.0.5/'), '/app'), 'http://10.0.0.5/app');
  assert.equal(plainHttpUrl(new URL('https://[fd00::5]/'), '/app'), 'http://[fd00::5]/app');
  assert.equal(plainHttpUrl(new URL('http://10.0.0.5:8080/'), '/app'), 'http://10.0.0.5:8080/app');
  assert.equal(plainHttpUrl(new URL('http://chat.example.ir/'), '/ca'), 'http://chat.example.ir/ca');
});
