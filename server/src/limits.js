import { parseJSON } from './db.js';
import { getSetting, settingNumber } from './settings.js';

export const STREAM_QUALITIES = [480, 720, 1080];
export const STREAM_FPS = [30, 60];

// Keys an admin can override per user. null/undefined = use the site default.
export const LIMIT_KEYS = {
  upload_mb: (v) => Math.max(1, Math.min(100000, Math.floor(Number(v)))),
  quota_mb: (v) => Math.max(0, Math.min(10000000, Math.floor(Number(v)))),
  can_call: (v) => !!v,
  can_stream: (v) => !!v,
  stream_quality: (v) => (STREAM_QUALITIES.includes(Number(v)) ? Number(v) : 720),
  stream_fps: (v) => (STREAM_FPS.includes(Number(v)) ? Number(v) : 30),
};

export function cleanLimits(input) {
  const out = {};
  for (const [k, fix] of Object.entries(LIMIT_KEYS)) {
    if (input?.[k] !== undefined && input[k] !== null && input[k] !== '') out[k] = fix(input[k]);
  }
  return out;
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
    canCall: o.can_call ?? getSetting('default_can_call') === '1',
    canStream: o.can_stream ?? getSetting('default_can_stream') === '1',
    streamQuality: o.stream_quality ?? settingNumber('max_stream_quality'),
    streamFps: o.stream_fps ?? (settingNumber('max_stream_fps') || 30),
  };
}
