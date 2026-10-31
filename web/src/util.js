const timeFmt = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long' });
const fullDayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long' });
const dateTimeFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'medium', timeStyle: 'short' });

export const formatTime = (t) => timeFmt.format(t);
export const formatDateTime = (t) => dateTimeFmt.format(t);

const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function formatDay(t) {
  const diff = (startOfDay(Date.now()) - startOfDay(t)) / 86400000;
  if (diff === 0) return 'امروز';
  if (diff === 1) return 'دیروز';
  return new Date(t).getFullYear() === new Date().getFullYear() ? dayFmt.format(t) : fullDayFmt.format(t);
}

// Short timestamp for the chat list.
export function formatListTime(t) {
  const diff = (startOfDay(Date.now()) - startOfDay(t)) / 86400000;
  if (diff === 0) return formatTime(t);
  if (diff < 7) return weekdayFmt.format(t);
  return dayFmt.format(t);
}

export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

export function formatLastSeen(t) {
  if (!t) return 'آخرین بازدید: خیلی وقت پیش';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'لحظاتی پیش آنلاین بود';
  if (mins < 60) return `${toFa(mins)} دقیقه پیش آنلاین بود`;
  return `آخرین بازدید ${formatDay(t)} ${formatTime(t)}`;
}

export const toFa = (n) => Number(n).toLocaleString('fa-IR');
// Persian digits in any text, e.g. a version "0.8.6" (toFa would turn it into "ناعدد").
export const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

export function formatSize(bytes) {
  if (bytes == null) return '';
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fa-IR', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

export function messagePreview(m) {
  if (!m) return '';
  if (m.file?.purged) return 'فایل منقضی شده';
  if (m.pendingPhoto) return m.text || 'عکس';
  if (m.pendingFile) return m.text || m.pendingFile.name || (m.pendingFile.kind === 'video' ? 'ویدیو' : 'فایل');
  switch (m.type) {
    case 'deleted':
      return 'پیام حذف شد';
    case 'image':
      return m.text || 'عکس';
    case 'video':
      return m.text || 'ویدیو';
    case 'voice':
      return 'پیام صوتی';
    case 'call':
      return callSummary(m).label;
    case 'file':
      return m.text || m.file?.name || 'فایل';
    default:
      return m.text;
  }
}

export const SITE_PERM_LABELS = {
  manage_users: 'مدیریت کاربران (مسدود کردن، بازنشانی رمز)',
  manage_invites: 'ساخت و حذف کد دعوت',
  manage_settings: 'تغییر تنظیمات سرور',
  manage_chats: 'نظارت بر همه گروه‌ها و کانال‌ها',
  view_audit: 'مشاهده گزارش فعالیت و آمار',
  broadcast: 'ارسال در کانال اطلاع‌رسانی',
  handle_reports: 'رسیدگی به پیام‌های گزارش‌شده',
};

// Per-device preferences (not critical, so storage failures are ignored).
const PREFS_KEY = 'ac_prefs';
export function getPrefs() {
  try {
    return { dataSaver: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { dataSaver: false };
  }
}
export function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
  return next;
}

export function formatClock(sec) {
  if (!Number.isFinite(sec)) return '۰:۰۰';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${toFa(m)}:${toFa(s % 60).padStart(2, '۰')}`;
}

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👎'];

export const AUTO_DELETE_OPTIONS = [
  [0, 'خاموش'],
  [3600, '۱ ساعت'],
  [86400, '۱ روز'],
  [7 * 86400, '۱ هفته'],
  [30 * 86400, '۱ ماه'],
];

// Downsample recorded audio to `bars` peaks encoded as base-32 digits (what the server stores).
export async function computeWaveform(blob, bars = 48) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / bars));
    const peaks = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) max = Math.max(max, Math.abs(data[j]));
      peaks.push(max);
    }
    const top = Math.max(...peaks, 0.01);
    return { waveform: peaks.map((p) => Math.round((p / top) * 31).toString(32)).join(''), duration: audio.duration };
  } catch {
    return { waveform: null, duration: null };
  }
}

export const decodeWaveform = (s) => (s ? [...s].map((c) => parseInt(c, 32) / 31) : null);

export const CHAT_PERM_LABELS = {
  edit_info: 'ویرایش اطلاعات',
  delete_messages: 'حذف پیام دیگران',
  ban_members: 'حذف و مسدود کردن اعضا',
  mute_members: 'بی‌صدا کردن اعضا',
  add_members: 'افزودن عضو',
  pin_messages: 'سنجاق کردن پیام',
  invite_links: 'ساخت لینک دعوت',
  post_messages: 'ارسال پیام در کانال',
};

// Call log entries carry JSON: { video, status, duration }.
export function callSummary(m) {
  let d = {};
  try {
    d = JSON.parse(m.text || '{}');
  } catch {
    /* old/invalid */
  }
  const kind = d.video ? 'تماس تصویری' : 'تماس صوتی';
  const status = { missed: 'بی‌پاسخ', declined: 'رد شد', cancelled: 'لغو شد', busy: 'مشغول' }[d.status];
  const label = status ? `${kind} · ${status}` : `${kind} · ${formatClock(d.duration || 0)}`;
  return { ...d, label, failed: !!status };
}

export const ROLE_LABELS = { owner: 'مالک', admin: 'ادمین', member: 'عضو', user: 'کاربر' };

export function hasSitePerm(me, perm) {
  if (!me) return false;
  if (me.role === 'owner') return true;
  return me.role === 'admin' && me.adminPerms?.includes(perm);
}

export function hasChatPerm(me, chat, perm) {
  if (hasSitePerm(me, 'manage_chats')) return true;
  if (!chat) return false;
  if (chat.myRole === 'owner') return true;
  return chat.myRole === 'admin' && chat.myPerms?.includes(perm);
}

// Posting in a channel: its owner, or admins given the right (not site admins; like Telegram).
export const canPostInChannel = (chat) => chat?.myRole === 'owner' || (chat?.myRole === 'admin' && !!chat.myPerms?.includes('post_messages'));

// Mirrors the server's posting rules so the composer can explain why it is disabled.
export function postBlockReason(me, chat) {
  if (!chat) return null;
  if (chat.isEmergency) return chat.myRole === 'owner' || hasSitePerm(me, 'broadcast') ? null : 'فقط مدیران در این کانال پیام می‌گذارند';
  if (chat.type === 'channel') return canPostInChannel(chat) ? null : 'فقط مدیران کانال پیام می‌گذارند';
  if (chat.type !== 'group' && chat.type !== 'voice') return null;
  if (chat.myRole === 'owner' || chat.myRole === 'admin' || hasSitePerm(me, 'manage_chats')) return null;
  if (chat.mutedUntil && chat.mutedUntil > Date.now()) return 'شما در این گروه بی‌صدا هستید';
  if (chat.locked) return 'گروه قفل است';
  return null;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard API on plain http: the old way still works there.
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Downscale an image in the browser. Returns the original for GIFs (keeps animation).
export async function compressImage(file, maxDim = 1600, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  if (file.type === 'image/gif') return { blob: file, width, height };
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality));
  return { blob, width: w, height: h };
}

export async function imageSize(file) {
  try {
    const b = await createImageBitmap(file);
    const r = { width: b.width, height: b.height };
    b.close();
    return r;
  } catch {
    return {};
  }
}

const COLORS = ['#e57373', '#f06292', '#ba68c8', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f'];
export const colorFor = (id) => COLORS[Math.abs(Number(id) || 0) % COLORS.length];
