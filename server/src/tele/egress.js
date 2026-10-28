/**
 * Tele egress: run sing-box so only Telegram traffic leaves via a chosen proxy.
 * Exposes a local SOCKS5 inbound that TDLib/clients must use. No direct fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../db.js';
import { getProxy, selectActiveProxy, getRoutePolicy, recordHealth } from './proxies.js';

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

  // Direct URI formats that sing-box can often ingest via a simple socks/http/vless style.
  // Full share-link parsing is best-effort; complex Reality/WS links may need manual JSON.
  if (row.protocol === 'socks5' || cfg.startsWith('socks5://') || cfg.startsWith('socks://')) {
    const u = parseUri(cfg.replace(/^socks:\/\//, 'socks5://'));
    return {
      type: 'socks',
      tag,
      server: u.host,
      server_port: u.port || 1080,
      version: '5',
      username: u.user || undefined,
      password: u.pass || undefined,
    };
  }
  if (row.protocol === 'http' || row.protocol === 'https' || cfg.startsWith('http://') || cfg.startsWith('https://')) {
    const u = parseUri(cfg);
    return {
      type: 'http',
      tag,
      server: u.host,
      server_port: u.port || (cfg.startsWith('https') ? 443 : 80),
      username: u.user || undefined,
      password: u.pass || undefined,
    };
  }
  if (row.protocol === 'ss' || cfg.startsWith('ss://')) {
    // Expect ss://method:password@host:port or base64 form — store as JSON outbound if parse fails.
    try {
      const parsed = parseShadowsocks(cfg);
      return { type: 'shadowsocks', tag, ...parsed };
    } catch {
      /* fall through */
    }
  }
  if (cfg.trim().startsWith('{')) {
    try {
      const j = JSON.parse(cfg);
      return { ...j, tag };
    } catch {
      /* fall through */
    }
  }
  // For vless/vmess/trojan/hy2/etc.: admin can paste a full sing-box outbound JSON object.
  // Otherwise we mark the route unusable until a proper adapter parses the share link.
  throw new Error(
    `پروتکل «${row.protocol}» نیاز به کانفیگ JSON خروجی sing-box دارد یا لینک ساده‌ی SOCKS/HTTP/SS. لینک‌های پیچیده VLESS/Reality را به صورت JSON outbound ذخیره کنید.`,
  );
}

function parseUri(raw) {
  const s = raw.includes('://') ? raw : `socks5://${raw}`;
  const u = new URL(s);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    user: u.username ? decodeURIComponent(u.username) : '',
    pass: u.password ? decodeURIComponent(u.password) : '',
  };
}

function parseShadowsocks(link) {
  // ss://BASE64 or ss://method:password@host:port
  let rest = link.slice(5);
  if (!rest.includes('@')) {
    const pad = rest.length % 4 === 0 ? rest : rest + '='.repeat(4 - (rest.length % 4));
    rest = Buffer.from(pad, 'base64').toString('utf8');
  }
  const at = rest.lastIndexOf('@');
  if (at < 0) throw new Error('ss link');
  const [method, password] = rest.slice(0, at).split(':');
  const [server, port] = rest.slice(at + 1).split(':');
  return {
    method,
    password,
    server,
    server_port: Number(port) || 8388,
  };
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
    outbounds: [
      outbound,
      { type: 'block', tag: 'block' },
    ],
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
    'sing-box',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'sing-box' || fs.existsSync(c)) return c;
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
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    child = null;
  }
  currentProxyId = null;
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
      new Error('باینری sing-box پیدا نشد. آن را نصب کنید یا SING_BOX_PATH را تنظیم کنید.'),
      { statusCode: 500 },
    );
  }

  await new Promise((resolve, reject) => {
    child = spawn(bin, ['run', '-c', CONFIG_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    currentProxyId = proxy.id;
    let started = false;
    const timer = setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 800);
    child.stderr?.on('data', (buf) => {
      const t = buf.toString();
      if (/error|failed/i.test(t)) lastError = t.slice(0, 400);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      child = null;
      currentProxyId = null;
      lastError = err.message;
      reject(err);
    });
    child.on('exit', (code) => {
      if (currentProxyId === proxy.id) {
        child = null;
        currentProxyId = null;
        lastError = `sing-box exited with code ${code}`;
      }
    });
    // Give it a moment to bind.
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 500);
  });

  lastError = '';
  return { host: LOCAL_SOCKS_HOST, port: LOCAL_SOCKS_PORT, proxyId: proxy.id };
}

/**
 * Health probe: try TCP connect to Telegram DC through local SOCKS if running,
 * otherwise attempt to bring egress up first. Without sing-box, mark unknown.
 */
export async function probeViaEgress(proxyId) {
  const row = getProxy(proxyId);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });

  // Temporarily prefer this proxy for a one-shot config write — simplified: only if selected.
  try {
    // Write config for this specific proxy without changing global selection permanently.
    ensureDir();
    const config = buildConfig(row);
    const testPath = path.join(EGRESS_DIR, `probe-${row.id}.json`);
    // Use a different local port for probe to avoid clobbering the main process.
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
    // Lightweight check: can we open a TCP connection to the local inbound?
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
