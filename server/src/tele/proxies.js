/**
 * Tele egress proxy inventory.
 * Stores admin-managed outbound routes used only by Telegram clients.
 * Never falls back to a direct (non-proxied) connection.
 */
import { get, all, run, now, parseJSON } from '../db.js';
import { detectProtocol, outboundFromConfig, nameOfConfig } from './uri.js';

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
    Math.max(0, Math.min(9999, Number(priority) || 100)),
    String(groupName || '').slice(0, 60),
    t,
    t,
  );
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
    patch.priority != null ? Math.max(0, Math.min(9999, Number(patch.priority) || 100)) : row.priority;
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
  return publicProxy(getProxy(row.id));
}

export function deleteProxy(id) {
  const row = getProxy(id);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });
  run('DELETE FROM tele_proxies WHERE id = ?', row.id);
  // Clear active selection if it pointed at this proxy.
  const active = getTeleSetting('tele_active_proxy_id');
  if (active && Number(active) === row.id) setTeleSetting('tele_active_proxy_id', '');
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
  };
}

export function setRoutePolicy(patch) {
  if (patch.enabled != null) setTeleSetting('tele_enabled', patch.enabled ? '1' : '0');
  if (patch.mode != null) {
    if (!ROUTE_MODES.includes(patch.mode)) throw Object.assign(new Error('حالت مسیریابی نامعتبر'), { statusCode: 400 });
    setTeleSetting('tele_route_mode', patch.mode);
  }
  if (patch.activeProxyId !== undefined) {
    if (patch.activeProxyId == null || patch.activeProxyId === '') {
      setTeleSetting('tele_active_proxy_id', '');
    } else {
      const p = getProxy(patch.activeProxyId);
      if (!p) throw Object.assign(new Error('پروکسی انتخاب‌شده پیدا نشد'), { statusCode: 400 });
      setTeleSetting('tele_active_proxy_id', String(p.id));
    }
  }
  if (patch.autoHealth != null) setTeleSetting('tele_health_auto', patch.autoHealth ? '1' : '0');
  if (patch.healthIntervalSec != null) {
    const sec = Math.max(60, Math.min(86400, Math.floor(Number(patch.healthIntervalSec)) || 600));
    setTeleSetting('tele_health_interval_sec', String(sec));
  }
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
export function recordHealth(id, { ok, latencyMs = null, error = '' }) {
  const row = getProxy(id);
  if (!row) return null;
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

