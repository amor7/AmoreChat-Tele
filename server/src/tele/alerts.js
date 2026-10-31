/**
 * Tele alerts for admins: a system message in their Saved Messages (with the app's usual
 * notification) when Telegram stops working for users, when it works again, when a proxy breaks,
 * and when a user reaches the monthly traffic cap. Each kind can be turned off.
 */
import { all, get } from '../db.js';
import { hasSitePerm } from '../perms.js';
import { ensureSavedChat, systemMessage } from '../chats.js';
import { getTeleSetting, setTeleSetting, getRoutePolicy, onHealthChange } from './proxies.js';
import { egressStatus } from './egress.js';

export const ALERT_KINDS = ['down', 'up', 'proxy', 'quota80', 'quota'];

export function getAlertSettings() {
  const kinds = String(getTeleSetting('tele_alert_events')).split(',').filter((k) => ALERT_KINDS.includes(k));
  return {
    enabled: getTeleSetting('tele_alert_enabled') === '1',
    events: kinds,
    // owner: only the owner; admins: everyone who manages settings.
    to: getTeleSetting('tele_alert_to') === 'owner' ? 'owner' : 'admins',
    // Telegram must be down this long before the alert (a proxy switch takes a few seconds).
    delayMin: Math.max(0, Math.min(1440, Number(getTeleSetting('tele_alert_delay_min')) || 0)),
    // While it stays down, remind every this many minutes (0 = once).
    repeatMin: Math.max(0, Math.min(10080, Number(getTeleSetting('tele_alert_repeat_min')) || 0)),
  };
}

export function setAlertSettings(p = {}) {
  const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });
  if (p.enabled != null) setTeleSetting('tele_alert_enabled', p.enabled ? '1' : '0');
  if (p.events != null) {
    if (!Array.isArray(p.events) || p.events.some((k) => !ALERT_KINDS.includes(k))) throw bad('نوع هشدار نامعتبر است');
    setTeleSetting('tele_alert_events', [...new Set(p.events)].join(','));
  }
  if (p.to != null) {
    if (!['owner', 'admins'].includes(p.to)) throw bad('گیرنده هشدار نامعتبر است');
    setTeleSetting('tele_alert_to', p.to);
  }
  for (const [key, field, max] of [['tele_alert_delay_min', 'delayMin', 1440], ['tele_alert_repeat_min', 'repeatMin', 10080]]) {
    if (p[field] == null) continue;
    const n = Number(p[field]);
    if (!Number.isInteger(n) || n < 0 || n > max) throw bad(`عدد بین ۰ و ${max} دقیقه`);
    setTeleSetting(key, String(n));
  }
  return getAlertSettings();
}

function recipients(to) {
  return all("SELECT * FROM users WHERE role IN ('owner', 'admin') AND IFNULL(banned, 0) = 0").filter((u) => (to === 'owner' ? u.role === 'owner' : hasSitePerm(u, 'manage_settings')));
}

/** Sends an alert of this kind, if alerts and the kind are on. `force`: the admin's test button. */
export function teleAlert(kind, text, { force = false } = {}) {
  const s = getAlertSettings();
  if (!force && (!s.enabled || !s.events.includes(kind))) return 0;
  const users = recipients(s.to);
  for (const u of users) {
    try {
      systemMessage(ensureSavedChat(u.id), `⚠️ تلگرام · ${text}`);
    } catch (e) {
      console.warn('[tele] alert:', e?.message || e);
    }
  }
  return users.length;
}

// ---------- Watching the tunnel ----------
// "Down" = Tele is turned on but the tunnel is not running (no healthy proxy, sing-box stopped…).
const state = { downSince: null, alerted: false, alertedAt: 0 };

function check() {
  const policy = getRoutePolicy();
  const eg = egressStatus();
  if (!policy.enabled) {
    // Turned off by an admin: not an outage.
    state.downSince = null;
    state.alerted = false;
    return;
  }
  if (eg.running) {
    if (state.alerted) {
      const p = eg.proxyId ? get('SELECT name FROM tele_proxies WHERE id = ?', eg.proxyId) : null;
      teleAlert('up', `✅ دوباره وصل شد${p ? ` (پروکسی «${p.name}»)` : ''}؛ کاربران به تلگرام دسترسی دارند.`);
    }
    state.downSince = null;
    state.alerted = false;
    return;
  }
  state.downSince ??= Date.now();
  const s = getAlertSettings();
  const waited = Date.now() - state.downSince >= s.delayMin * 60000;
  const remind = state.alerted && s.repeatMin > 0 && Date.now() - state.alertedAt >= s.repeatMin * 60000;
  if (waited && (!state.alerted || remind)) {
    // Only an outage someone was told about gets a "back" message.
    if (teleAlert('down', `🔴 قطع است${eg.lastError ? `: ${eg.lastError}` : ''}. کاربران الان به تلگرام دسترسی ندارند؛ پروکسی‌ها را در پنل مدیریت ← «VPN» بررسی کنید.`)) {
      state.alerted = true;
      state.alertedAt = Date.now();
    }
  }
}

export function startAlertLoop() {
  // A proxy that was working stopped (others may still carry the traffic).
  onHealthChange((proxy, ok, error) => {
    if (!ok) teleAlert('proxy', `🟠 پروکسی «${proxy.name}» از کار افتاد${error ? `: ${error}` : ''}.`);
  });
  setInterval(check, Number(process.env.TELE_ALERT_CHECK_MS) || 5000).unref();
}
