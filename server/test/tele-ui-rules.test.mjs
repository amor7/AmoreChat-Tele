// Pure rules of the Telegram screens (web/src/tele-rules.js) and the photo size the server
// announces (server/src/tele/photo-size.js). Usage: node --test server/test/tele-ui-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  teleEntry,
  badgeText,
  avatarNum,
  mergeLatest,
  mergeOlder,
  historyView,
  messageActions,
  mediaKind,
  captionOf,
  MEDIA_IDLE,
  mediaReducer,
  mediaPercent,
  percentText,
  progressStep,
  clockText,
  faDigits,
  unreadSum,
  sameMessage,
  progressPhase,
  safeFileName,
} from '../../web/src/tele-rules.js';
import { pickPhotoSize } from '../src/tele/photo-size.js';

const connected = (dialogs) => ({ access: true, account: { status: 'connected' }, dialogs });

test('sidebar entry: unread is the sum over the chats the user added', () => {
  const s = connected([
    { selected: true, unread: 3 },
    { selected: true, unread: 0 },
    { selected: false, unread: 50 }, // not added: not followed, not counted
    { selected: true, unread: 2 },
    { selected: true, unread: -1 },
    { selected: true, unread: 'x' },
    { selected: true },
  ]);
  assert.deepEqual(teleEntry(s), { show: true, unread: 5 });
  assert.deepEqual(teleEntry(connected([])), { show: true, unread: 0 });
});

test('sidebar entry: hidden without access or account; no number while locked', () => {
  assert.deepEqual(teleEntry(null), { show: false, unread: 0 });
  assert.deepEqual(teleEntry({ access: false, dialogs: [{ selected: true, unread: 4 }] }), { show: false, unread: 0 });
  assert.deepEqual(teleEntry({ access: true, account: null, dialogs: [] }), { show: false, unread: 0 });
  assert.deepEqual(teleEntry({ access: true, account: { status: 'awaiting_code' }, dialogs: [] }), { show: false, unread: 0 });
  // Locked: the server says nothing else, and nothing from Telegram may show.
  assert.deepEqual(teleEntry({ access: true, locked: true, dialogs: [{ selected: true, unread: 9 }] }), { show: true, unread: 0 });
  assert.deepEqual(teleEntry({ access: true, locked: true, quarantined: true }), { show: true, unread: 0 });
});

test('badge text: Persian digits, capped at 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(7), '۷');
  assert.equal(badgeText(99), '۹۹');
  assert.equal(badgeText(120), '۹۹+');
});

test('avatar number from Telegram ids', () => {
  assert.equal(avatarNum('u123'), 123);
  assert.equal(avatarNum('c-100200'), 100200);
  assert.equal(avatarNum(-55), 55);
  assert.equal(avatarNum(''), 0);
  assert.equal(avatarNum('abc'), 0);
});

test('history: the latest page replaces what it covers, older pages add without doubles', () => {
  const cur = [
    { id: 1, tgMsgId: 10 },
    { id: 2, tgMsgId: 11 },
    { id: 9, tgMsgId: null }, // sent from here, temporary id
  ];
  // The sent message now has its final id (id 9 → tg 12): it must not show twice.
  const page = [
    { id: 2, tgMsgId: 11 },
    { id: 9, tgMsgId: 12 },
  ];
  assert.deepEqual(
    mergeLatest(cur, page).map((m) => m.id),
    [1, 2, 9],
  );
  assert.deepEqual(mergeLatest(cur, []), cur);
  assert.deepEqual(mergeLatest(null, []), []);
  const older = [
    { id: 0, tgMsgId: 5 },
    { id: 1, tgMsgId: 10 },
  ];
  assert.deepEqual(
    mergeOlder(cur, older).map((m) => m.id),
    [0, 1, 2, 9],
  );
});

test('history view: skeleton only before the first answer, error instead of an endless wait', () => {
  assert.equal(historyView(null, ''), 'loading');
  assert.equal(historyView(null, 'ارتباط با سرور برقرار نشد'), 'error');
  assert.equal(historyView([], ''), 'empty');
  assert.equal(historyView([{ id: 1 }], ''), 'list');
  // A failed poll after a successful load keeps the list (the notice line tells about it).
  assert.equal(historyView([{ id: 1 }], 'x'), 'list');
});

test('message actions: what each kind of message offers', () => {
  const all = { allowMedia: true, allowVoice: true, allowFiles: true };
  assert.deepEqual(messageActions({ kind: 'text', tgMsgId: 5, text: 'hi' }, all), ['reply', 'forward', 'copy', 'select']);
  // Channel: no reply.
  assert.deepEqual(messageActions({ kind: 'text', tgMsgId: 5, text: 'hi' }, { ...all, canReply: false }), ['forward', 'copy', 'select']);
  // Not in Telegram yet: only copy and cancel.
  assert.deepEqual(messageActions({ kind: 'queued', tgMsgId: null, text: 'hi' }, all), ['copy', 'select', 'cancel']);
  // A photo without caption: nothing to copy, something to download.
  assert.deepEqual(messageActions({ kind: 'photo', tgMsgId: 6, text: '📷 عکس', photo: {} }, all), ['reply', 'forward', 'download']);
  // Photos not allowed for this account: the label is the text, no download.
  assert.deepEqual(messageActions({ kind: 'photo', tgMsgId: 6, text: '📷 عکس', photo: {} }, {}), ['reply', 'forward', 'copy', 'select']);
  assert.deepEqual(messageActions({ kind: 'voice', tgMsgId: 7, text: '🎤 پیام صوتی', voice: {} }, all), ['reply', 'forward', 'download']);
  assert.deepEqual(messageActions({ kind: 'file', tgMsgId: 8, text: '📎 a.pdf\nthe notes', file: {} }, all), ['reply', 'forward', 'copy', 'select', 'download']);
});

test('media kind and caption follow what the account may see', () => {
  const m = { text: '📷 عکس\nسلام', photo: {} };
  assert.equal(mediaKind(m, { allowMedia: true }), 'photo');
  assert.equal(mediaKind(m, {}), null);
  assert.equal(captionOf(m, { allowMedia: true }), 'سلام');
  assert.equal(captionOf(m, {}), '📷 عکس\nسلام');
  assert.equal(captionOf({ text: '🎤 پیام صوتی', voice: {} }, { allowVoice: true }), '');
  assert.equal(captionOf({ text: 'GIF\nfun', file: {} }, { allowFiles: true }), 'fun');
  assert.equal(captionOf({ text: '', file: null }, {}), '');
});

test('media download: idle → loading with progress → done', () => {
  let s = mediaReducer(MEDIA_IDLE, { type: 'start', total: 1000 });
  assert.deepEqual(s, { status: 'loading', received: 0, total: 1000, error: '' });
  // Nothing arrived yet (the server is still getting it from Telegram): no percent to show.
  assert.equal(progressPhase(s), 'fetching');
  assert.equal(mediaPercent(s), null);
  // A second tap while it runs changes nothing.
  assert.equal(mediaReducer(s, { type: 'start' }), s);
  s = mediaReducer(s, { type: 'progress', received: 420, total: 0 }); // no length header: keep the known size
  assert.equal(mediaPercent(s), 42);
  assert.equal(percentText(s), '۴۲٪');
  assert.equal(progressPhase(s), 'receiving');
  s = mediaReducer(s, { type: 'progress', received: 999, total: 0 });
  assert.equal(mediaPercent(s), 99); // never «۱۰۰٪» before it is really done
  s = mediaReducer(s, { type: 'progress', received: 5000, total: 0 }); // more than announced: capped
  // Every announced byte is in but it is not done: «finishing», no number.
  assert.equal(progressPhase(s), 'finishing');
  assert.equal(mediaPercent(s), null);
  s = mediaReducer(s, { type: 'done' });
  assert.equal(s.status, 'done');
  assert.equal(mediaPercent(s), null);
  // Progress after the end is ignored.
  assert.equal(mediaReducer(s, { type: 'progress', received: 1, total: 2 }), s);
});

test('media download: unknown size, failure with a reason, cancel back to idle', () => {
  let s = mediaReducer(MEDIA_IDLE, { type: 'start' });
  s = mediaReducer(s, { type: 'progress', received: 300, total: 0 });
  assert.equal(progressPhase(s), 'streaming');
  assert.equal(mediaPercent(s), null);
  assert.equal(progressPhase(MEDIA_IDLE), null);
  assert.equal(percentText(s), '');
  const failed = mediaReducer(s, { type: 'fail', error: 'دانلود متوقف شد؛ اتصال خیلی کند یا قطع است' });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'دانلود متوقف شد؛ اتصال خیلی کند یا قطع است');
  assert.equal(mediaReducer(s, { type: 'fail' }).error, 'دانلود ناموفق بود');
  assert.equal(mediaReducer(s, { type: 'fail', cancelled: true }), MEDIA_IDLE);
  // Retry from the error starts over.
  assert.equal(mediaReducer(failed, { type: 'start', total: 10 }).status, 'loading');
  assert.equal(mediaReducer(failed, { type: 'reset' }), MEDIA_IDLE);
  assert.equal(mediaReducer(failed, { type: 'nope' }), failed);
});

test('progress redraws only on a real step', () => {
  // The first bytes always redraw (from «getting it from Telegram» to a percent).
  assert.equal(progressStep(0, 5, 1000), true);
  assert.equal(progressStep(5, 9, 1000), false);
  assert.equal(progressStep(5, 10, 1000), true);
  assert.equal(progressStep(10, 19, 1000), false);
  assert.equal(progressStep(1, 100000, 0), false);
  assert.equal(progressStep(100000, 300000, 0), true);
});

test('clock and digits', () => {
  assert.equal(clockText(0), '۰:۰۰');
  assert.equal(clockText(75), '۱:۱۵');
  assert.equal(clockText('x'), '۰:۰۰');
  assert.equal(faDigits('v1.0.44'), 'v۱.۰.۴۴');
});

test('photo size: the biggest one within the limit, the same one the download takes', () => {
  const sizes = [
    { t: 's', size: 2000, remote: 'a' },
    { t: 'y', size: 9_000_000, remote: 'c' },
    { t: 'x', size: 300_000, remote: 'b' },
  ];
  assert.equal(pickPhotoSize(sizes, 5 * 1048576).remote, 'b');
  assert.equal(pickPhotoSize(sizes, 10 * 1048576).remote, 'c');
  assert.equal(pickPhotoSize(sizes, 1000), null);
  // Unknown length counts as fitting (as before).
  assert.equal(pickPhotoSize([{ size: 0, remote: 'z' }], 1).remote, 'z');
  assert.equal(pickPhotoSize(undefined, 1), null);
  // The input is not reordered.
  assert.equal(sizes[0].remote, 'a');
});

test('history polls keep the objects: same list back when nothing changed, same message objects when they did not', () => {
  const a = { id: 1, tgMsgId: 10, kind: 'text', text: 'a', direction: 'in', createdAt: 1, senderId: 'u1', senderName: 'A', replyTo: null, photo: null };
  const b = { id: 2, tgMsgId: 11, kind: 'photo', text: 'b', direction: 'in', createdAt: 2, photo: { w: 1, h: 2, mini: 'xx', size: 3 } };
  const cur = [a, b];
  // The server answers with new objects of the same messages.
  const again = mergeLatest(cur, [{ ...a }, { ...b, photo: { ...b.photo } }]);
  assert.equal(again, cur, 'an unchanged poll must return the same array');
  // One message changed (a queued one got its kind): only that object is new.
  const edited = mergeLatest(cur, [{ ...a }, { ...b, text: 'b2' }]);
  assert.notEqual(edited, cur);
  assert.equal(edited[0], a);
  assert.notEqual(edited[1], b);
  assert.equal(edited[1].text, 'b2');
  // A new message: the old objects stay.
  const grown = mergeLatest(cur, [{ ...a }, { ...b }, { id: 3, tgMsgId: 12, kind: 'text', text: 'c' }]);
  assert.equal(grown.length, 3);
  assert.equal(grown[0], a);
  assert.equal(grown[1], b);
  // Nothing new from an older page: the same array.
  assert.equal(mergeOlder(cur, [{ ...a }]), cur);
  assert.equal(sameMessage(a, { ...a, replyTo: { tgMsgId: 9, text: 'q' } }), false);
  assert.equal(sameMessage(b, { ...b, photo: { ...b.photo, size: 4 } }), false);
});

test('unread: messages (not chats), per kind, only the added chats when asked', () => {
  const ds = [
    { kind: 'private', selected: true, unread: 3 },
    { kind: 'group', selected: true, unread: 4 },
    { kind: 'group', selected: false, unread: 10 },
    { kind: 'channel', selected: true, unread: 0 },
  ];
  assert.equal(unreadSum(ds), 17);
  assert.equal(unreadSum(ds, 'all', true), 7);
  assert.equal(unreadSum(ds, 'group', true), 4);
  assert.equal(unreadSum(ds, 'channel', true), 0);
  assert.equal(unreadSum(null), 0);
});

test('file names from Telegram are safe to save', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..' + String.fromCharCode(92) + 'x' + String.fromCharCode(92) + '.bashrc'), 'bashrc');
  assert.equal(safeFileName('...'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName(null, 'photo.jpg'), 'photo.jpg');
  assert.equal(safeFileName('a<b>.pdf'), 'a_b_.pdf');
  assert.equal(safeFileName('a' + String.fromCharCode(1) + 'b.txt'), 'ab.txt');
  assert.equal(safeFileName('گزارش ماه.pdf'), 'گزارش ماه.pdf');
  const long = safeFileName('x'.repeat(300) + '.mp4');
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.mp4'));
});
