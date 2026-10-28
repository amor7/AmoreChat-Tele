import fs from 'node:fs';
import os from 'node:os';
import { get, all, run, now, DATA_DIR } from './db.js';
import { online, toUser } from './realtime.js';
import { LIVEKIT_URL, rtcEnabled } from './livekit.js';
import { activeRooms } from './voice.js';
import { listCalls } from './calls.js';
import { pushTo } from './push.js';
import { hasSitePerm } from './perms.js';

// Server health: one sample a minute (kept 30 days in SQLite), plus alerts to the admins.
// Everything is measured locally; nothing leaves the server.
const KEEP_DAYS = 30;
const INTERVAL = Number(process.env.HEALTH_INTERVAL_MS) || 60_000;

// ---------- Measurements ----------
let lastCpu = null;
function cpuPercent() {
  const t = os.cpus().reduce(
    (a, c) => {
      const total = Object.values(c.times).reduce((x, y) => x + y, 0);
      return { idle: a.idle + c.times.idle, total: a.total + total };
    },
    { idle: 0, total: 0 },
  );
  const prev = lastCpu;
  lastCpu = t;
  if (!prev || t.total === prev.total) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (t.idle - prev.idle) / (t.total - prev.total))));
}

// Real "available" memory (free + reclaimable cache), not just free pages.
function memory() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] || 0) * 1024;
    const total = kb('MemTotal');
    if (total) return { total, used: total - kb('MemAvailable') };
  } catch {
    /* not Linux */
  }
  return { total: os.totalmem(), used: os.totalmem() - os.freemem() };
}

function disk() {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize };
  } catch {
    return { total: 0, used: 0 };
  }
}

// Whole-server traffic: the host's counters when docker-compose mounts them (/host/proc),
// else this container's own (calls go through the media server, so that would miss them).
const NET_SOURCES = ['/host/proc/1/net/dev', '/proc/1/net/dev', '/proc/net/dev'];
let netSource = null;
function netBytes() {
  for (const f of netSource ? [netSource] : NET_SOURCES) {
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').slice(2);
      let rx = 0;
      let tx = 0;
      for (const l of lines) {
        const [name, rest] = l.split(':');
        if (!rest || /^\s*(lo|docker\d*|br-\w+|veth\w+)\s*$/.test(name)) continue;
        const v = rest.trim().split(/\s+/).map(Number);
        rx += v[0];
        tx += v[8];
      }
      netSource = f;
      return { rx, tx, host: f.startsWith('/host') };
    } catch {
      /* try the next one */
    }
  }
  return null;
}
let lastNet = null;
function netRate() {
  const n = netBytes();
  const t = Date.now();
  if (!n) return { rx: null, tx: null };
  const prev = lastNet;
  lastNet = { ...n, t };
  if (!prev || n.rx < prev.rx) return { rx: null, tx: null };
  const s = (t - prev.t) / 1000;
  return { rx: (n.rx - prev.rx) / s, tx: (n.tx - prev.tx) / s };
}

async function mediaServerOk() {
  if (!rtcEnabled) return null;
  try {
    const r = await fetch(LIVEKIT_URL, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function sample() {
  const mem = memory();
  const d = disk();
  const net = netRate();
  const rooms = activeRooms().filter((r) => r.room.startsWith('chat-'));
  return {
    ts: now(),
    cpu: cpuPercent(),
    load: os.loadavg()[0],
    memUsed: mem.used,
    memTotal: mem.total,
    diskUsed: d.used,
    diskTotal: d.total,
    netRx: net.rx,
    netTx: net.tx,
    online: [...online.values()].filter((n) => n > 0).length,
    calls: listCalls().filter((c) => c.state === 'active').length,
    voice: rooms.reduce((n, r) => n + r.participants.length, 0),
    media: await mediaServerOk(),
    appMem: process.memoryUsage().rss,
  };
}

// ---------- Alerts ----------
// Each rule must hold for `for` consecutive samples before it fires, and fires once until resolved.
const RULES = [
  { key: 'disk', for: 1, test: (s) => s.diskTotal && s.diskUsed / s.diskTotal > 0.9, text: (s) => `دیسک سرور ${pct(s.diskUsed / s.diskTotal)} پر است` },
  { key: 'mem', for: 5, test: (s) => s.memTotal && s.memUsed / s.memTotal > 0.92, text: (s) => `رم سرور ${pct(s.memUsed / s.memTotal)} پر است (بیش از ۵ دقیقه)` },
  { key: 'cpu', for: 5, test: (s) => s.cpu != null && s.cpu > 90, text: (s) => `پردازنده سرور ${pct(s.cpu / 100)} مشغول است (بیش از ۵ دقیقه)` },
  { key: 'media', for: 2, test: (s) => s.media === false, text: () => 'سرور صدا و تصویر (LiveKit) جواب نمی‌دهد؛ تماس و ویس‌چت کار نمی‌کند' },
];
const pct = (x) => `${Math.round(x * 100).toLocaleString('fa-IR')}٪`;
const streak = new Map();

function recipients() {
  return all("SELECT * FROM users WHERE banned = 0 AND role IN ('owner', 'admin')")
    .filter((u) => u.role === 'owner' || hasSitePerm(u, 'view_audit'))
    .map((u) => u.id);
}

async function notifyAdmins(text, level) {
  const { ensureSavedChat, systemMessage } = await import('./chats.js');
  for (const uid of recipients()) {
    systemMessage(ensureSavedChat(uid), text);
    toUser(uid, 'server:alert', { text, level });
    pushTo([uid], { type: 'message', chatId: ensureSavedChat(uid), title: level === 'ok' ? '✅ سرور' : '⚠️ هشدار سرور', body: text, mentioned: true });
  }
}

export async function raiseAlert(key, text) {
  if (get('SELECT 1 FROM alerts WHERE key = ? AND resolved_at IS NULL', key)) return;
  run('INSERT INTO alerts (key, text, started_at) VALUES (?, ?, ?)', key, text, now());
  await notifyAdmins(`⚠️ ${text}`, 'warn');
}

export async function resolveAlert(key) {
  const a = get('SELECT * FROM alerts WHERE key = ? AND resolved_at IS NULL', key);
  if (!a) return;
  run('UPDATE alerts SET resolved_at = ? WHERE id = ?', now(), a.id);
  await notifyAdmins(`✅ برطرف شد: ${a.text}`, 'ok');
}

async function checkRules(s) {
  for (const r of RULES) {
    if (r.test(s)) {
      const n = (streak.get(r.key) || 0) + 1;
      streak.set(r.key, n);
      if (n >= r.for) await raiseAlert(r.key, r.text(s));
    } else {
      streak.set(r.key, 0);
      await resolveAlert(r.key);
    }
  }
}

// ---------- Loop & queries ----------
export async function collect(log) {
  try {
    const s = await sample();
    run(
      `INSERT OR REPLACE INTO metrics (ts, cpu, load, mem_used, mem_total, disk_used, disk_total, net_rx, net_tx, online, calls, voice, media, app_mem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.ts,
      s.cpu,
      s.load,
      s.memUsed,
      s.memTotal,
      s.diskUsed,
      s.diskTotal,
      s.netRx,
      s.netTx,
      s.online,
      s.calls,
      s.voice,
      s.media == null ? null : s.media ? 1 : 0,
      s.appMem,
    );
    run('DELETE FROM metrics WHERE ts < ?', now() - KEEP_DAYS * 86400e3);
    await checkRules(s);
    return s;
  } catch (e) {
    log?.warn(`health sample failed: ${e.message}`);
  }
}

export function startHealth(log) {
  cpuPercent();
  netRate();
  setTimeout(() => collect(log), 5000).unref();
  setInterval(() => collect(log), INTERVAL).unref();
}

const RANGES = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

// Averages per bucket so every range returns ~120 points.
export function series(range) {
  const span = RANGES[range] || RANGES['24h'];
  const bucket = Math.max(60e3, Math.floor(span / 120));
  return all(
    `SELECT (ts / ?) * ? AS t, AVG(cpu) AS cpu, AVG(mem_used) AS memUsed, MAX(mem_total) AS memTotal,
       AVG(disk_used) AS diskUsed, MAX(disk_total) AS diskTotal, AVG(net_rx) AS netRx, AVG(net_tx) AS netTx,
       MAX(online) AS online, MAX(calls) AS calls, MAX(voice) AS voice, MIN(media) AS media
     FROM metrics WHERE ts > ? GROUP BY ts / ? ORDER BY t`,
    bucket,
    bucket,
    now() - span,
    bucket,
  );
}

export const recentAlerts = () => all('SELECT * FROM alerts ORDER BY id DESC LIMIT 50');
export const netIsHostWide = () => !!netSource?.startsWith('/host');
