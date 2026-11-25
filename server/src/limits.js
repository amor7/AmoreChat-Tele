import { parseJSON, now } from './db.js';
import { getSetting, settingNumber } from './settings.js';
import { fail } from './chats.js';

export const STREAM_QUALITIES = [480, 720, 1080];
export const STREAM_FPS = [30, 60];

// A number or a numeric string; anything else (true, [5], {}) is NaN.
const numOf = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const wholeIn = (min, max) => (v) => {
  const n = numOf(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : undefined;
};
const oneOf = (list) => (v) => (list.includes(numOf(v)) ? numOf(v) : undefined);
// "0" and "false" are no, not yes.
const bool = (v) => ([true, 1, '1', 'true'].includes(v) ? true : [false, 0, '0', 'false'].includes(v) ? false : undefined);

// Keys an admin can override per user. null/undefined/'' = use the site default. Each check
// returns undefined for a value it does not accept.
export const LIMIT_KEYS = {
  upload_mb: wholeIn(1, 100000),
  quota_mb: wholeIn(0, 10000000),
  can_call: bool,
  can_stream: bool,
  stream_quality: oneOf(STREAM_QUALITIES),
  stream_fps: oneOf(STREAM_FPS),
};

/** The overrides to store; a value that is not valid is a 400 (nothing is guessed or clamped). */
export function cleanLimits(input) {
  const out = {};
  for (const [k, fix] of Object.entries(LIMIT_KEYS)) {
    if (input?.[k] === undefined || input[k] === null || input[k] === '') continue;
    const v = fix(input[k]);
    if (v === undefined) fail(400, `مقدار نامعتبر برای ${k}`);
    out[k] = v;
  }
  return out;
}

// Temporary restrictions an admin sets: they end by themselves.
const RESTRICTED = { send: 'ارسال پیام', media: 'ارسال فایل', call: 'تماس و استریم' };
export const RESTRICT_KINDS = Object.keys(RESTRICTED);
export function restrictionUntil(user, kind) {
  if (user.role === 'owner') return 0;
  const until = parseJSON(user.restrictions, {})[kind];
  return until > now() ? until : 0;
}
export function assertAllowed(user, kind) {
  const until = restrictionUntil(user, kind);
  if (!until) return;
  const when = new Date(until).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tehran' });
  const { reason } = parseJSON(user.restrictions, {});
  fail(403, `${RESTRICTED[kind]} برای شما تا ${when} محدود شده است${reason ? ` (${reason})` : ''}`);
}

// What this user may actually do: owner is unrestricted, everyone else gets
// their overrides on top of the site defaults.
export function effectiveLimits(user) {
  if (user.role === 'owner') {
    return { uploadMb: 100000, quotaMb: 0, canCall: true, canStream: true, streamQuality: 1080, streamFps: 60 };
  }
  const o = parseJSON(user.limits, {});
  return {
    uploadMb: o.upload_mb ?? settingNumber('max_upload_mb'),
    quotaMb: o.quota_mb ?? settingNumber('user_quota_mb'),
    canCall: !restrictionUntil(user, 'call') && (o.can_call ?? getSetting('default_can_call') === '1'),
    canStream: !restrictionUntil(user, 'call') && (o.can_stream ?? getSetting('default_can_stream') === '1'),
    streamQuality: o.stream_quality ?? settingNumber('max_stream_quality'),
    streamFps: o.stream_fps ?? (settingNumber('max_stream_fps') || 30),
  };
}

// ---------- Flood guard ----------
// Per user, in memory: enough for anyone typing (and for a phone sending its offline queue at once),
// not for a script filling a group. Slow mode in a group still applies on top. The page sends
// "typing" once per message it starts (and every 2.5 s after): quick short messages mean several.
export const BURSTS = { send: [60, 30_000], react: [60, 20_000], typing: [20, 10_000] };
const bursts = new Map(); // "kind:user[:key]" -> recent times
export function overBurst(userId, kind, key = '', n = 1) {
  const [max, windowMs] = BURSTS[kind];
  const id = `${kind}:${userId}:${key}`;
  const t = now();
  const recent = (bursts.get(id) || []).filter((x) => x > t - windowMs);
  if (recent.length + n > max) {
    bursts.set(id, recent);
    return true;
  }
  for (let i = 0; i < n; i++) recent.push(t);
  bursts.set(id, recent);
  return false;
}
export function assertBurst(userId, kind, n = 1) {
  if (overBurst(userId, kind, '', n)) fail(429, 'خیلی سریع ارسال می‌کنید؛ چند ثانیه صبر کنید');
}
setInterval(() => {
  const t = now();
  for (const [id, times] of bursts) if (!times.length || times.at(-1) < t - 60_000) bursts.delete(id);
}, 60_000).unref();
