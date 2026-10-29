/**
 * Tele egress: run sing-box so only Telegram traffic leaves via a chosen proxy.
 * Exposes a local SOCKS5 inbound that TDLib/clients must use. No direct fallback.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DATA_DIR } from '../db.js';
import { getProxy, selectActiveProxy, getRoutePolicy, recordHealth, listProxies } from './proxies.js';
import { outboundFromConfig } from './uri.js';

const EGRESS_DIR = path.join(DATA_DIR, 'tele-egress');
const CONFIG_PATH = path.join(EGRESS_DIR, 'sing-box.json');
const LOCAL_SOCKS_HOST = '127.0.0.1';
const LOCAL_SOCKS_PORT = Number(process.env.TELE_SOCKS_PORT || 17890);

let child = null;
let currentProxyId = null;
let lastError = '';

// sing-box colors its log lines; keep the text only.
// eslint-disable-next-line no-control-regex
const plain = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
// The last error lines, without repeating the same message (the same timeout often fills the log).
function summarize(text) {
  const lines = plain(text)
    .split(/(?=(?:ERROR|FATAL|WARN)\b)/)
    .map((l) => l.replace(/^(ERROR|FATAL|WARN)\s*\[\d+\]\s*(\[[^\]]*\]\s*)?/, '$1 ').trim())
    .filter(Boolean);
  return [...new Set(lines)].slice(-2).join(' · ').slice(0, 400);
}

function ensureDir() {
  fs.mkdirSync(EGRESS_DIR, { recursive: true, mode: 0o700 });
}
// The config holds proxy credentials and private keys: readable by this user only.
const writePrivate = (file, data) => fs.writeFileSync(file, data, { mode: 0o600 });

function findSingBox() {
  const candidates = [process.env.SING_BOX_PATH, path.join(DATA_DIR, 'bin', 'sing-box'), '/usr/local/bin/sing-box', '/usr/bin/sing-box'].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

// sing-box version (cached per binary): WireGuard is an endpoint from 1.11, and 1.12 wants a DNS server for domain proxies.
const versions = new Map();
function singBoxVersion(bin) {
  if (!bin) return null;
  if (!versions.has(bin)) {
    let v = null;
    try {
      const out = execFileSync(bin, ['version'], { timeout: 5000 }).toString();
      v = (out.match(/version\s+v?(\d+\.\d+\.\d+)/i) || [])[1] || null;
    } catch {
      /* unknown */
    }
    versions.set(bin, v);
  }
  return versions.get(bin);
}
const atLeast = (v, want) => {
  if (!v) return true; // unknown: assume the bundled (new) one
  const [a, b] = v.split('.').map(Number);
  const [x, y] = want.split('.').map(Number);
  return a > x || (a === x && b >= y);
};

/** sing-box config: one local SOCKS inbound → the proxy. Nothing else, and no direct route. */
function buildConfig(row, port, bin) {
  const version = singBoxVersion(bin);
  let out;
  try {
    out = outboundFromConfig(String(row.config || ''), row.protocol, `proxy-${row.id}`);
  } catch (e) {
    throw Object.assign(new Error(e.message || 'کانفیگ پروکسی نامعتبر است'), { statusCode: 400 });
  }
  const config = {
    log: { level: 'warn' },
    // Only loopback: never reachable from outside the container.
    inbounds: [{ type: 'socks', tag: 'tele-in', listen: LOCAL_SOCKS_HOST, listen_port: port }],
    outbounds: [{ type: 'block', tag: 'block' }],
    route: { final: out.tag, rules: [] },
  };
  if (out.type === 'wireguard' && atLeast(version, '1.11.0')) {
    config.endpoints = [out];
  } else if (out.type === 'wireguard') {
    // Older sing-box: the WireGuard outbound form.
    const p = out.peers[0];
    config.outbounds.unshift({
      type: 'wireguard', tag: out.tag, server: p.address, server_port: p.port, local_address: out.address, private_key: out.private_key,
      peer_public_key: p.public_key, ...(p.pre_shared_key ? { pre_shared_key: p.pre_shared_key } : {}), mtu: out.mtu,
    });
  } else {
    config.outbounds.unshift(out);
  }
  // How a proxy given by domain is found: the admin's DNS server if set (the server's own DNS is
  // often foreign and unreachable during a shutdown), else the system resolver. Only the proxy's
  // own address is looked up this way; Telegram traffic itself goes through the proxy.
  const dns = String(getRoutePolicy().dns || '').split(',').filter(Boolean)[0];
  const [, dnsHost, dnsPort] = dns?.match(/^\[?([^\]]+?)\]?:(\d+)$/) || [];
  if (atLeast(version, '1.12.0')) {
    config.dns = { servers: [dnsHost ? { type: 'udp', tag: 'proxy-dns', server: dnsHost, server_port: Number(dnsPort) } : { type: 'local', tag: 'proxy-dns' }] };
    config.route.default_domain_resolver = 'proxy-dns';
  } else if (dnsHost) {
    config.dns = { servers: [{ tag: 'proxy-dns', address: `udp://${dnsHost.includes(':') ? `[${dnsHost}]` : dnsHost}:${dnsPort}` }] };
  }
  return config;
}

export function egressStatus() {
  const policy = getRoutePolicy();
  const bin = findSingBox();
  return {
    running: !!(child && !child.killed),
    proxyId: currentProxyId,
    localSocks: `socks5://${LOCAL_SOCKS_HOST}:${LOCAL_SOCKS_PORT}`,
    lastError: lastError || null,
    singBoxPath: bin,
    singBoxVersion: singBoxVersion(bin),
    policy,
    health: healthState(),
  };
}

// One start/stop at a time: requests arriving together must not start sing-box twice on one port.
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

async function killProc(proc) {
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

async function stopNow() {
  const proc = child;
  child = null;
  currentProxyId = null;
  await killProc(proc);
}
export const stopEgress = () => serial(stopNow);

/** Starts sing-box with a config file; resolves once its SOCKS port accepts connections. */
function startSingBox(bin, file, port, { onExit } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderr = '';
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      reject(Object.assign(new Error(msg), { statusCode: 502, proc }));
    };
    proc.stdout?.resume();
    proc.stderr?.on('data', (buf) => {
      stderr = (stderr + buf.toString()).slice(-4000);
      proc.lastLog = stderr;
    });
    proc.on('error', (err) => fail(err.message));
    proc.on('exit', (code, signal) => {
      const msg = `sing-box متوقف شد (${signal || code})${stderr ? ': ' + summarize(stderr) : ''}`;
      if (!settled) fail(msg);
      else onExit?.(proc, msg);
    });
    const started = Date.now();
    const poll = setInterval(() => {
      const s = net.createConnection({ host: LOCAL_SOCKS_HOST, port }, () => {
        s.destroy();
        if (settled) return;
        settled = true;
        clearInterval(poll);
        resolve(proc);
      });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - started > 5000) fail(`sing-box بالا نیامد${stderr ? ': ' + summarize(stderr) : ''}`);
      });
    }, 150);
  });
}

/**
 * Start or restart egress for the currently selected healthy proxy.
 * Returns local SOCKS endpoint or throws if none available (fail-closed).
 */
export const ensureEgress = () =>
  serial(async () => {
    const policy = getRoutePolicy();
    if (!policy.enabled) {
      await stopNow();
      lastError = 'Tele egress is disabled';
      throw Object.assign(new Error('خروج تلگرام غیرفعال است'), { statusCode: 503 });
    }
    const proxy = selectActiveProxy({ currentId: child ? currentProxyId : null });
    if (!proxy) {
      await stopNow();
      lastError = 'هیچ پروکسی سالمی نیست';
      throw Object.assign(new Error('هیچ پروکسی سالمی برای تلگرام در دسترس نیست'), { statusCode: 503 });
    }
    if (child && !child.killed && currentProxyId === proxy.id) {
      return { host: LOCAL_SOCKS_HOST, port: LOCAL_SOCKS_PORT, proxyId: proxy.id };
    }
    await stopNow();
    ensureDir();
    const bin = findSingBox();
    if (!bin) {
      lastError = 'sing-box پیدا نشد';
      throw Object.assign(new Error('باینری sing-box پیدا نشد (در ایمیج نسخه ۱.۰.۷ به بعد هست؛ یا در data/bin/sing-box بگذارید).'), { statusCode: 500, expose: true });
    }
    let config;
    try {
      config = buildConfig(proxy, LOCAL_SOCKS_PORT, bin);
    } catch (e) {
      lastError = e.message;
      recordHealth(proxy.id, { ok: false, error: e.message });
      throw e;
    }
    writePrivate(CONFIG_PATH, JSON.stringify(config, null, 2));
    try {
      child = await startSingBox(bin, CONFIG_PATH, LOCAL_SOCKS_PORT, {
        // Only for the current process: after a restart the old one exits later.
        onExit: (proc, msg) => {
          if (child !== proc) return;
          child = null;
          currentProxyId = null;
          lastError = msg;
        },
      });
    } catch (e) {
      lastError = e.message;
      await killProc(e.proc);
      throw e;
    }
    currentProxyId = proxy.id;
    lastError = '';
    return { host: LOCAL_SOCKS_HOST, port: LOCAL_SOCKS_PORT, proxyId: proxy.id };
  });

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

// Errors from the running tunnel (e.g. the proxy server stopped answering), for the admin panel.
export function liveTunnelError() {
  return child?.lastLog ? summarize(child.lastLog) : '';
}

// ---------- Health check: a real connection through the proxy to Telegram ----------

// Telegram data centers (their HTTP port answers any request): DC2 and DC4, then DC1.
const TELEGRAM_TARGETS = [
  ['149.154.167.51', 80],
  ['149.154.167.91', 80],
  ['149.154.175.53', 80],
];

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, LOCAL_SOCKS_HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

/** SOCKS5 CONNECT through the local inbound, an HTTP request, and the time until Telegram answers. */
function viaSocks(port, host, dport, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: LOCAL_SOCKS_HOST, port });
    let stage = 0;
    let buf = Buffer.alloc(0);
    let t0 = 0;
    const timer = setTimeout(() => done(new Error('پاسخی از تلگرام نیامد (timeout)')), timeoutMs);
    const done = (err, ms) => {
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err);
      else resolve(ms);
    };
    s.on('error', (e) => done(e));
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return done(new Error('SOCKS محلی جواب نامعتبر داد'));
        buf = buf.subarray(2);
        stage = 1;
        t0 = Date.now();
        const ip = host.split('.').map(Number);
        s.write(Buffer.from([5, 1, 0, 1, ...ip, dport >> 8, dport & 255]));
      }
      if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return done(new Error(`پروکسی نتوانست به تلگرام وصل شود (SOCKS ${buf[1]})`));
        buf = buf.subarray(10);
        stage = 2;
        s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      }
      if (stage === 2 && buf.length > 0) done(null, Date.now() - t0);
    });
    s.on('end', () => stage < 2 && done(new Error('اتصال قبل از پاسخ تلگرام بسته شد')));
  });
}

/**
 * Health probe: a separate sing-box with this proxy only, then a real request to a Telegram data
 * center through it. The latency is the time until Telegram answers.
 */
export async function probeViaEgress(proxyId) {
  const row = getProxy(proxyId);
  if (!row) throw Object.assign(new Error('پروکسی پیدا نشد'), { statusCode: 404 });
  const bin = findSingBox();
  if (!bin) return recordHealth(row.id, { ok: false, error: 'sing-box نصب نیست' });
  ensureDir();
  const file = path.join(EGRESS_DIR, `probe-${row.id}-${process.pid}.json`);
  let proc = null;
  try {
    const port = await freePort();
    writePrivate(file, JSON.stringify(buildConfig(row, port, bin)));
    proc = await startSingBox(bin, file, port);
    let lastErr = null;
    for (const [host, dport] of TELEGRAM_TARGETS) {
      try {
        const ms = await viaSocks(port, host, dport);
        return recordHealth(row.id, { ok: true, latencyMs: ms });
      } catch (e) {
        lastErr = e;
        // The proxy server itself did not answer: other Telegram addresses would fail the same way.
        if (/open outbound connection|dial (tcp|udp)|handshake/i.test(plain(proc.lastLog))) break;
      }
    }
    // Why it failed, as sing-box saw it (e.g. "dial tcp …: i/o timeout"), else our own reason.
    const log = proc.lastLog ? summarize(proc.lastLog) : '';
    return recordHealth(row.id, { ok: false, error: log || lastErr?.message || 'به تلگرام نرسید' });
  } catch (e) {
    proc = e.proc || proc;
    return recordHealth(row.id, { ok: false, error: plain(e.message) });
  } finally {
    await killProc(proc);
    fs.rmSync(file, { force: true });
  }
}

// ---------- Scheduled checks: test every enabled proxy and move to the best one ----------
const health = { running: false, lastRunAt: null, nextRunAt: null };
const healthState = () => ({ ...health });

/** Tests all enabled proxies one after another, then lets the policy pick (switching if needed). */
export async function probeAll() {
  if (health.running) return { busy: true, ...egressStatus() };
  health.running = true;
  try {
    for (const p of listProxies({ includeDisabled: false })) await probeViaEgress(p.id);
  } finally {
    health.running = false;
    health.lastRunAt = Date.now();
  }
  return refreshEgress();
}

let lastAuto = 0;
export function startHealthLoop() {
  setInterval(() => {
    const policy = getRoutePolicy();
    if (!policy.enabled || !policy.autoHealth) {
      health.nextRunAt = null;
      return;
    }
    const every = policy.healthIntervalSec * 1000;
    health.nextRunAt = (lastAuto || Date.now()) + every;
    if (Date.now() - lastAuto < every) return;
    lastAuto = Date.now();
    health.nextRunAt = lastAuto + every;
    probeAll().catch((e) => console.warn('[tele] scheduled proxy check:', e?.message || e));
  }, 30000).unref();
}
