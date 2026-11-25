/**
 * Tele egress proxy inventory.
 * Stores admin-managed outbound routes used only by Telegram clients.
 * Never falls back to a direct (non-proxied) connection.
 */
import { get, all, run, tx, now } from '../db.js';
import { detectProtocol, outboundFromConfig, nameOfConfig } from './uri.js';
import { syncOvpn } from './ovpn.js';

export const ROUTE_MODES = ['manual', 'best', 'random', 'priority'];

export const PROTOCOL_HINTS = [
  'vless',
  'vmess',
  'trojan',
  'ss',
  'socks5',
  'socks4',
  'http',
  'https',
  'mtproto',
  'wireguard',
  'openvpn',
  'hysteria2',
  'tuic',
  'other',
];


/** Redact secrets for API responses. */
export function publicProxy(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    enabled: !!row.enabled,
    priority: row.priority,
    groupName: row.group_name || '',
    lastStatus: row.last_status,
    lastLatencyMs: row.last_latency_ms,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Never return full config to clients; only a short hint that something is stored.
    hasConfig: !!(row.config && String(row.config).trim()),
  };
}

export function listProxies({ includeDisabled = true } = {}) {
  const rows = includeDisabled
    ? all('SELECT * FROM tele_proxies ORDER BY priority ASC, id ASC')
    : all('SELECT * FROM tele_proxies WHERE enabled = 1 ORDER BY priority ASC, id ASC');
  return rows.map(publicProxy);
}

export function getProxy(id) {
  return get('SELECT * FROM tele_proxies WHERE id = ?', Number(id));
}

// 0 is a real priority (the first one), not "left out"; left out = `fallback`, garbage = 400.
function priorityOf(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw Object.assign(new Error('اولویت باید عدد باشد'), { statusCode: 400 });
  return Math.max(0, Math.min(9999, Math.floor(n)));
}

export function createProxy({ name, config, protocol, priority = 100, groupName = '', enabled = true }) {
  const cfg = String(config || '').trim();
  if (!cfg) throw Object.assign(new Error('کانفیگ پروکسی خالی است'), { statusCode: 400 });
  // Refuse what sing-box could not use (or what would bypass the proxy) right away, not at the next start.
  outboundFromConfig(cfg, protocol && PROTOCOL_HINTS.includes(protocol) ? protocol : null, 'check');
  const n = String(name || '').trim().slice(0, 80) || nameOfConfig(cfg) || 'بدون نام';
  const proto = protocol && PROTOCOL_HINTS.includes(protocol) ? protocol : detectProtocol(cfg);
  const t = now();
  const r = run(
    `INSERT INTO tele_proxies (name, protocol, config, enabled, priority, group_name, last_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
    n,
    proto,
    cfg,
    enabled ? 1 : 0,
    priorityOf(priority, 100),
    String(groupName || '').slice(0, 60),
    t,
    t,
  );
  if (proto === 'openvpn') syncOvpn();
  return publicProxy(getProxy(Number(r.lastInsertRowid)));
}

export function updateProxy(id, patch) {
  const row = getProxy(id);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });
  const name = patch.name != null ? String(patch.name).trim().slice(0, 80) || row.name : row.name;
  const config = patch.config != null ? String(patch.config).trim() : row.config;
  if (patch.config != null && config) outboundFromConfig(config, null, 'check');
  if (!config) throw Object.assign(new Error('کانفیگ پروکسی خالی است'), { statusCode: 400 });
  const protocol =
    patch.protocol && PROTOCOL_HINTS.includes(patch.protocol)
      ? patch.protocol
      : patch.config != null
        ? detectProtocol(config)
        : row.protocol;
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : row.enabled;
  const priority =
    patch.priority != null && patch.priority !== '' ? priorityOf(patch.priority, row.priority) : row.priority;
  const groupName = patch.groupName != null ? String(patch.groupName).slice(0, 60) : row.group_name;
  const t = now();
  run(
    `UPDATE tele_proxies SET name = ?, protocol = ?, config = ?, enabled = ?, priority = ?, group_name = ?, updated_at = ?
     WHERE id = ?`,
    name,
    protocol,
    config,
    enabled,
    priority,
    groupName,
    t,
    row.id,
  );
  if (protocol === 'openvpn' || row.protocol === 'openvpn') syncOvpn();
  return publicProxy(getProxy(row.id));
}

export function deleteProxy(id) {
  const row = getProxy(id);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });
  run('DELETE FROM tele_proxies WHERE id = ?', row.id);
  // Clear active selection if it pointed at this proxy.
  const active = getTeleSetting('tele_active_proxy_id');
  if (active && Number(active) === row.id) setTeleSetting('tele_active_proxy_id', '');
  if (row.protocol === 'openvpn') syncOvpn();
  return true;
}

// --- Tele settings (subset of settings table, keys tele_*) ---

const TELE_DEFAULTS = {
  tele_enabled: '0',
  tele_route_mode: 'priority',
  tele_active_proxy_id: '',
  tele_health_interval_sec: '600',
  // Scheduled check of all proxies (then the policy picks the best), off unless the admin turns it on.
  tele_health_auto: '0',
  // DNS server sing-box asks for proxy addresses (empty: the server's own). During a shutdown the
  // server's foreign DNS (8.8.8.8 …) does not answer, so a domestic one is needed for domain proxies.
  tele_dns: '',
  // Alerts to admins (see alerts.js): on, which kinds, to whom, after how long, and reminders.
  tele_alert_enabled: '1',
  tele_alert_events: 'down,up,quota',
  tele_alert_to: 'admins',
  tele_alert_delay_min: '2',
  tele_alert_repeat_min: '60',
};

export function getTeleSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (row) return row.value;
  return TELE_DEFAULTS[key] ?? '';
}

export function setTeleSetting(key, value) {
  if (!(key in TELE_DEFAULTS)) throw Object.assign(new Error('تنظیم نامعتبر'), { statusCode: 400 });
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}

export function getRoutePolicy() {
  const mode = getTeleSetting('tele_route_mode');
  const activeId = getTeleSetting('tele_active_proxy_id');
  return {
    enabled: getTeleSetting('tele_enabled') === '1',
    mode: ROUTE_MODES.includes(mode) ? mode : 'priority',
    activeProxyId: activeId ? Number(activeId) : null,
    healthIntervalSec: Math.max(60, Math.min(86400, Number(getTeleSetting('tele_health_interval_sec')) || 600)),
    autoHealth: getTeleSetting('tele_health_auto') === '1',
    dns: getTeleSetting('tele_dns'),
  };
}

export function setRoutePolicy(patch) {
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  // Every field is checked first, then all are written together: a bad one saves nothing.
  const w = {};
  for (const [field, key] of [['enabled', 'tele_enabled'], ['autoHealth', 'tele_health_auto']]) {
    if (patch[field] == null) continue;
    if (typeof patch[field] !== 'boolean') throw bad('مقدار باید true یا false باشد');
    w[key] = patch[field] ? '1' : '0';
  }
  if (patch.mode != null) {
    if (!ROUTE_MODES.includes(patch.mode)) throw bad('حالت مسیریابی نامعتبر');
    w.tele_route_mode = patch.mode;
  }
  if (patch.activeProxyId !== undefined) {
    if (patch.activeProxyId == null || patch.activeProxyId === '') {
      w.tele_active_proxy_id = '';
    } else {
      const p = getProxy(patch.activeProxyId);
      if (!p) throw bad('پروکسی انتخاب‌شده پیدا نشد');
      w.tele_active_proxy_id = String(p.id);
    }
  }
  if (patch.dns !== undefined) w.tele_dns = parseDns(patch.dns).join(',');
  if (patch.healthIntervalSec != null) {
    const n = typeof patch.healthIntervalSec === 'number' || typeof patch.healthIntervalSec === 'string' ? Number(patch.healthIntervalSec) : NaN;
    if (!Number.isFinite(n) || String(patch.healthIntervalSec).trim() === '') throw bad('فاصله بررسی باید عدد ثانیه باشد');
    w.tele_health_interval_sec = String(Math.max(60, Math.min(86400, Math.floor(n))));
  }
  tx(() => {
    for (const [k, v] of Object.entries(w)) setTeleSetting(k, v);
  });
  return getRoutePolicy();
}

/**
 * Choose which proxy should be used right now, according to policy.
 * Returns the DB row or null. Never implies direct egress.
 */
export function selectActiveProxy({ currentId = null } = {}) {
  const policy = getRoutePolicy();
  if (!policy.enabled) return null;

  if (policy.mode === 'manual') {
    if (!policy.activeProxyId) return null;
    const p = getProxy(policy.activeProxyId);
    return p && p.enabled ? p : null;
  }

  // Fail closed: only proxies whose last real check through Telegram passed.
  const healthy = all("SELECT * FROM tele_proxies WHERE enabled = 1 AND last_status = 'healthy' ORDER BY priority ASC, id ASC");
  if (!healthy.length) return null;
  const current = healthy.find((p) => p.id === currentId) || null;

  if (policy.mode === 'best') {
    // Lowest measured latency. Stay on the running proxy unless another is clearly faster
    // (switching restarts the tunnel and Telegram reconnects).
    const best = [...healthy].sort((a, b) => (a.last_latency_ms ?? 1e9) - (b.last_latency_ms ?? 1e9))[0];
    if (current && current.id !== best.id) {
      const cur = current.last_latency_ms ?? 1e9;
      const gain = cur - (best.last_latency_ms ?? 1e9);
      if (gain < 50 || gain < cur * 0.2) return current;
    }
    return best;
  }

  if (policy.mode === 'random') {
    // A new random pick only when the running one is no longer healthy (not on every request).
    return current || healthy[Math.floor(Math.random() * healthy.length)];
  }

  // priority: the first healthy one in priority order.
  return healthy[0];
}

/**
 * Record a health-check result. Real probe logic lives elsewhere (sing-box / curl via proxy).
 */
const healthHandlers = [];
/** Called when a proxy that was working fails a check: (proxy row, ok, error). */
export const onHealthChange = (fn) => healthHandlers.push(fn);

export function recordHealth(id, { ok, latencyMs = null, error = '' }) {
  const row = getProxy(id);
  if (!row) return null;
  if (row.last_status === 'healthy' && !ok) {
    for (const fn of healthHandlers) {
      try {
        fn(row, ok, error);
      } catch {
        /* an alert must never break the health check */
      }
    }
  }
  run(
    `UPDATE tele_proxies SET last_status = ?, last_latency_ms = ?, last_checked_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
    ok ? 'healthy' : 'unhealthy',
    ok && latencyMs != null ? Math.max(0, Math.floor(latencyMs)) : null,
    now(),
    String(error || '').slice(0, 500),
    now(),
    row.id,
  );
  return publicProxy(getProxy(row.id));
}


/**
 * "178.22.122.100", "178.22.122.100:53" or "[2001:db8::1]:53" → "host:port" (one server: sing-box has no
 * fallback between DNS servers, so a second one would never be asked).
 * Plain IPs only: a DNS server given by name would itself need DNS.
 */
export function parseDns(value) {
  const out = [];
  for (const raw of String(value || '').split(/[\s,]+/).filter(Boolean).slice(0, 1)) {
    const m = raw.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i) || raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/) || raw.match(/^([0-9a-f]*:[0-9a-f:]+)$/i);
    const ip = m?.[1];
    const port = Number(m?.[2] || 53);
    const v4ok = ip && (ip.includes(':') || ip.split('.').every((n) => Number(n) <= 255));
    if (!ip || !v4ok || !(port >= 1 && port <= 65535)) throw Object.assign(new Error(`DNS «${raw}» نامعتبر است؛ فقط IP (مثلاً 178.22.122.100)`), { statusCode: 400 });
    out.push(ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`);
  }
  return out;
}
