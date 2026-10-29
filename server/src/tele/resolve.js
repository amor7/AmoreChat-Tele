/**
 * Finds the IP of a proxy given by domain before sing-box starts, so the tunnel does not depend on
 * one DNS server. During a shutdown the server's own DNS (inside Docker often 8.8.8.8) does not
 * answer; the admin's DNS, the system resolver and a few domestic ones are asked at once, and the
 * last answer that worked is kept on disk for when none of them answers.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import dns from 'node:dns';

// Shecan, Shecan 2, 403, Electro, Radar.
export const DOMESTIC_DNS = ['178.22.122.100', '185.51.200.2', '10.202.10.202', '78.157.42.100', '10.202.10.10'];
const TIMEOUT_MS = 3000;

// Domestic resolvers answer a filtered domain with the filter page (10.10.34.34-36): never a proxy.
const bogus = (ip) => /^10\.10\.34\./.test(ip) || ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::' || ip === '::1';

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error('timeout')), ms)))]).finally(() => clearTimeout(t));
}

async function viaServer(host, server) {
  const r = new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
  r.setServers([server]);
  const ips = await r.resolve4(host).catch(() => r.resolve6(host));
  const ip = ips.find((a) => !bogus(a));
  if (!ip) throw new Error('no usable address');
  return ip;
}

async function viaSystem(host) {
  const { address } = await withTimeout(dns.promises.lookup(host), TIMEOUT_MS);
  if (bogus(address)) throw new Error('no usable address');
  return address;
}

let cacheFile = null;
let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}
function remember(host, ip) {
  loadCache();
  if (cache[host]?.ip === ip) return;
  cache[host] = { ip, at: Date.now() };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    /* only a fallback */
  }
}

/** Where the last good answers are kept (the egress data dir). */
export function setResolveCache(dir) {
  cacheFile = path.join(dir, 'dns-cache.json');
  cache = null;
}

/**
 * IP for a proxy host: itself when it already is one, else the first answer from the admin's DNS
 * (dnsServer, "ip:port"), the system and the domestic list; else the last known one; else null.
 */
export async function resolveProxyHost(host, dnsServer = '') {
  host = String(host || '').replace(/^\[|\]$/g, '');
  if (!host || net.isIP(host)) return host || null;
  const servers = [...new Set([dnsServer, ...DOMESTIC_DNS].filter(Boolean))];
  try {
    const ip = await Promise.any([viaSystem(host), ...servers.map((s) => viaServer(host, s))]);
    remember(host, ip);
    return ip;
  } catch {
    return loadCache()[host]?.ip || null;
  }
}

/**
 * Puts the IP in place of the domain in a sing-box outbound / WireGuard endpoint, keeping the domain
 * where the proxy server still needs it (TLS SNI, the ws/http Host header). Returns the domains it
 * could not resolve (those stay as they are, and sing-box tries its own DNS).
 */
export async function pinProxyAddresses(out, dnsServer = '') {
  const failed = [];
  const pin = async (host) => {
    if (!host || net.isIP(String(host).replace(/^\[|\]$/g, ''))) return host;
    const ip = await resolveProxyHost(host, dnsServer);
    if (!ip) failed.push(host);
    return ip || host;
  };
  if (Array.isArray(out.peers)) {
    for (const p of out.peers) p.address = await pin(p.address);
    if (out.server) out.server = await pin(out.server);
    return failed;
  }
  const domain = out.server;
  const ip = await pin(domain);
  if (ip === domain) return failed;
  out.server = ip;
  if (out.tls?.enabled && !out.tls.server_name) out.tls.server_name = domain;
  const tr = out.transport;
  if (tr?.type === 'ws' && !tr.headers?.Host && !tr.headers?.host) tr.headers = { ...tr.headers, Host: domain };
  if (tr?.type === 'httpupgrade' && !tr.host) tr.host = domain;
  if (tr?.type === 'http' && !tr.host?.length) tr.host = [domain];
  return failed;
}
