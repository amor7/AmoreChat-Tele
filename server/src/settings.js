import { get, all, run } from './db.js';

export const DEFAULTS = {
  site_name: 'AmoreChat',
  // open | invite | closed
  registration_mode: 'invite',
  // Can regular users create groups and channels?
  allow_user_groups: '1',
  // "Explore" shows the full list of public groups/channels (0 = only by searching a name).
  discover_list: '1',
  max_upload_mb: '100',
  // Tele: largest Telegram photo (MB) users with media permission may load or send
  tele_media_max_mb: '5',
  // Tele: monthly traffic per user (MB, sent + received through the VPN); 0 = no cap. Each user can
  // have their own cap instead.
  tele_quota_mb: '0',
  // Tele: largest file / video (MB) users with file permission may load or send.
  tele_file_max_mb: '20',
  // Tele: minutes between checks of mirrored Telegram channels.
  tele_mirror_minutes: '5',
  // Tele: who may use Telegram: all | none | allow (only the listed users) | deny (all but them).
  // The owner always may.
  tele_access: 'all',
  // Mirrored channels: who may fetch a video or file from Telegram (same modes as tele_access; once
  // fetched, every member of the channel has it). Default: only the listed users (and the owner).
  mirror_files_access: 'allow',
  // Security alerts to the owner (Saved Messages); wrong passwords from one IP in 15 minutes that
  // count as an attack; ban such an IP by itself, and for how many minutes (0 = until unbanned).
  sec_alerts: '1',
  sec_fail_threshold: '10',
  sec_auto_ban: '0',
  sec_auto_ban_minutes: '0',
  // Total upload quota per user in MB; 0 = unlimited.
  user_quota_mb: '0',
  // Delete uploaded media older than this many days; 0 = keep forever.
  media_retention_days: '0',
  // Defaults for live audio/video; each can be overridden per user.
  default_can_call: '1',
  default_can_stream: '1',
  // Highest stream/camera resolution (short side): 480 | 720 | 1080
  max_stream_quality: '720',
  // Highest stream frame rate: 30 | 60 (60 needs about twice the bandwidth)
  max_stream_fps: '30',
  // Max simultaneous screen/camera streams in one voice room; 0 = unlimited.
  max_streams_per_room: '3',
};

let cache = null;

function load() {
  cache = { ...DEFAULTS };
  for (const r of all('SELECT key, value FROM settings')) cache[r.key] = r.value;
}

export function getSetting(key) {
  if (!cache) load();
  return cache[key];
}

export function getAllSettings() {
  if (!cache) load();
  return { ...cache };
}

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error('unknown setting ' + key);
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  load();
}

export const settingNumber = (key) => Number(getSetting(key)) || 0;

// Used for invites and similar: a single row lookup is cheap, so no cache needed.
export const hasAnyUser = () => !!get('SELECT 1 FROM users LIMIT 1');
