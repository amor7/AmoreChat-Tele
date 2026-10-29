/**
 * Tele egress: run sing-box so only Telegram traffic leaves via a chosen proxy.
 * Exposes a local SOCKS5 inbound that TDLib/clients must use. No direct fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../db.js';
import { getProxy, selectActiveProxy, getRoutePolicy, recordHealth } from './proxies.js';
import { outboundFromConfig } from './uri.js';

const EGRESS_DIR = path.join(DATA_DIR, 'tele-egress');
const CONFIG_PATH = path.join(EGRESS_DIR, 'sing-box.json');
const LOCAL_SOCKS_HOST = '127.0.0.1';
const LOCAL_SOCKS_PORT = Number(process.env.TELE_SOCKS_PORT || 17890);

let child = null;
let currentProxyId = null;
let lastError = '';

function ensureDir() {
  fs.mkdirSync(EGRESS_DIR, { recursive: true });
}

/** Map stored proxy row → sing-box outbound fragment. */
function outboundFromProxy(row) {
  const cfg = String(row.config || '').trim();
  const tag = `proxy-${row.id}`;
  try {
    return outboundFromConfig(cfg, row.protocol, tag);
  } catch (e) {
    throw new Error(
      e.message ||
        `پروتکل «${row.protocol}» نیاز به کانفیگ JSON خروجی sing-box دارد یا لینک socks5/http/ss/vless/vmess/trojan.`,
    );
  }
}

function buildConfig(proxyRow) {
  const outbound = outboundFromProxy(proxyRow);
  return {
    log: { level: 'warn' },
    inbounds: [
      {
        type: 'socks',
        tag: 'tele-in',
        listen: LOCAL_SOCKS_HOST,
        listen_port: LOCAL_SOCKS_PORT,
        // Only loopback — never expose this to the LAN.
      },
    ],
    outbounds: [outbound, { type: 'block', tag: 'block' }],
    route: {
      // Everything that enters the local SOCKS goes out via the selected proxy. No direct.
      final: outbound.tag,
      rules: [],
    },
  };
}

function findSingBox() {
  const candidates = [
    process.env.SING_BOX_PATH,
    path.join(DATA_DIR, 'bin', 'sing-box'),
    '/usr/local/bin/sing-box',
    '/usr/bin/sing-box',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

export function egressStatus() {
  const policy = getRoutePolicy();
  return {
    running: !!(child && !child.killed),
    proxyId: currentProxyId,
    localSocks: `socks5://${LOCAL_SOCKS_HOST}:${LOCAL_SOCKS_PORT}`,
    lastError: lastError || null,
    singBoxPath: findSingBox(),
    policy,
  };
}

export async function stopEgress() {
  const proc = child;
  child = null;
  currentProxyId = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  // Wait until it is really gone, so a restart can bind the same local port again.
  await new Promise((resolve) => {
    const force = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 2000);
    const done = setTimeout(resolve, 3000);
    proc.once('exit', () => {
      clearTimeout(force);
      clearTimeout(done);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  });
}

/**
 * Start or restart egress for the currently selected healthy proxy.
 * Returns local SOCKS endpoint or throws if none available (fail-closed).
 */
export async function ensureEgress() {
  const policy = getRoutePolicy();
  if (!policy.enabled) {
    await stopEgress();
    lastError = 'Tele egress is disabled';
    throw Object.assign(new Error('خروج تلگرام غیرفعال است'), { statusCode: 503 });
  }

  const proxy = selectActiveProxy();
  if (!proxy) {
    await stopEgress();
    lastError = 'no healthy proxy';
    throw Object.assign(new Error('هیچ پروکسی سالمی برای تلگرام در دسترس نیست'), { statusCode: 503 });
  }

  if (child && !child.killed && currentProxyId === proxy.id) {
    return { host: LOCAL_SOCKS_HOST, port: LOCAL_SOCKS_PORT, proxyId: proxy.id };
  }

  await stopEgress();
  ensureDir();

  let config;
  try {
    config = buildConfig(proxy);
  } catch (e) {
    lastError = e.message;
    recordHealth(proxy.id, { ok: false, error: e.message });
    throw Object.assign(new Error(e.message), { statusCode: 400 });
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  const bin = findSingBox();
  if (!bin) {
    lastError = 'sing-box binary not found';
    throw Object.assign(
      new Error(
        'باینری sing-box پیدا نشد. روی هاست نصب کنید و با volume به کانتینر بدهید، یا در data/bin/sing-box بگذارید.',
      ),
      { statusCode: 500 },
    );
  }

  await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['run', '-c', CONFIG_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child = proc;
    currentProxyId = proxy.id;
    let settled = false;
    let stderr = '';
    // Still alive after a moment = started. Exiting before that is a failed start.
    const timer = setTimeout(() => {
      settled = true;
      resolve();
    }, 800);
    proc.stdout?.resume();
    proc.stderr?.on('data', (buf) => {
      const t = buf.toString();
      stderr = (stderr + t).slice(-400);
      if (/error|failed|fatal/i.test(t)) lastError = t.slice(0, 400);
    });
    // Only touch the state if this is still the current process: after a restart the old
    // process exits later and must not mark the new one as stopped.
    const gone = (msg) => {
      if (child === proc) {
        child = null;
        currentProxyId = null;
      }
      lastError = msg;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(Object.assign(new Error(msg), { statusCode: 502 }));
      }
    };
    proc.on('error', (err) => gone(err.message));
    proc.on('exit', (code, signal) => {
      if (child !== proc) return;
      gone(`sing-box exited (${signal || code})${stderr ? ': ' + stderr.trim() : ''}`);
    });
  });

  lastError = '';
  return { host: LOCAL_SOCKS_HOST, port: LOCAL_SOCKS_PORT, proxyId: proxy.id };
}

/**
 * Bring the tunnel in line with the current policy and proxies: start it (or switch proxy)
 * when enabled, stop it when disabled. Never throws; the reason ends up in lastError.
 */
export async function refreshEgress() {
  try {
    if (getRoutePolicy().enabled) await ensureEgress();
    else await stopEgress();
  } catch {
    /* fail-closed: status shows lastError */
  }
  return egressStatus();
}

/**
 * Health probe: try TCP connect to local SOCKS inbound for this proxy config.
 */
export async function probeViaEgress(proxyId) {
  const row = getProxy(proxyId);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });

  try {
    ensureDir();
    const config = buildConfig(row);
    const testPath = path.join(EGRESS_DIR, `probe-${row.id}.json`);
    const probePort = LOCAL_SOCKS_PORT + 1 + (row.id % 50);
    config.inbounds[0].listen_port = probePort;
    fs.writeFileSync(testPath, JSON.stringify(config, null, 2));
    const bin = findSingBox();
    if (!bin) {
      return recordHealth(row.id, {
        ok: false,
        error: 'sing-box not installed — cannot probe',
      });
    }
    const started = Date.now();
    const p = spawn(bin, ['run', '-c', testPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((r) => setTimeout(r, 600));
    const net = await import('node:net');
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: LOCAL_SOCKS_HOST, port: probePort }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 1500);
    });
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(testPath);
    } catch {
      /* ignore */
    }
    const latency = Date.now() - started;
    return recordHealth(row.id, {
      ok,
      latencyMs: ok ? latency : null,
      error: ok ? '' : 'local SOCKS inbound did not accept connections',
    });
  } catch (e) {
    return recordHealth(row.id, { ok: false, error: e.message });
  }
}
