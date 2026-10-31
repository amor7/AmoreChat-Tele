/**
 * Proxy configs (share links, WireGuard .conf, sing-box JSON) → sing-box outbound / endpoint.
 * Written for sing-box 1.12+ (bundled in the image): WireGuard is an endpoint there, not an outbound.
 */

// Outbound types an admin may paste as JSON. Anything that could reach Telegram without the proxy
// (direct, selector/urltest groups that might pick direct, dns, block) is refused: Tele is fail-closed.
const ALLOWED_TYPES = new Set(['socks', 'http', 'shadowsocks', 'vless', 'vmess', 'trojan', 'wireguard', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'shadowtls', 'ssh']);

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
// OpenVPN: a SOCKS port of the ovpn service (see ovpn.js); the tag is "proxy-<id>".
let ovpnOutboundFn = null;
export const setOvpnOutbound = (fn) => (ovpnOutboundFn = fn);

// "host:port@user:pass" in parts [, host, port, user, pass], or null. Plain string search: the links
// are pasted text of any length.
function addressFirst(s) {
  const at = s.indexOf('@');
  const colon = s.lastIndexOf(':', at);
  if (at < 0 || colon < 1) return null;
  const host = s.slice(0, colon);
  const port = s.slice(colon + 1, at);
  if (/\s/.test(host) || !/^\d+$/.test(port)) return null;
  const rest = s.slice(at + 1);
  const end = rest.search(/[:@\s]/);
  const user = end < 0 ? rest : rest.slice(0, end);
  const pass = end < 0 ? '' : rest.slice(rest[end] === ':' ? end + 1 : end);
  return /[\r\n]/.test(pass) ? null : [s, host, port, user, pass];
}

/**
 * SOCKS/HTTP links as sellers often write them, rewritten to the standard user:pass@host:port:
 *   socks5://203.0.113.1:1080@user:pass      (address first)
 *   socks5://203.0.113.1:1080:user:pass      (all colon-separated)
 *   203.0.113.1:1080:user:pass               (no scheme: SOCKS5)
 */
export function normalizeProxyLink(raw) {
  let s = String(raw || '').trim();
  const hashAt = s.indexOf('#');
  const remark = hashAt >= 0 ? s.slice(hashAt) : '';
  if (hashAt >= 0) s = s.slice(0, hashAt);
  let scheme = 'socks5';
  const m = s.match(/^([a-z0-9]+):\/\/(.*)$/i);
  if (m) [, scheme, s] = m;
  const enc = encodeURIComponent;
  const isHost = (h) => /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i.test(h);
  const portOk = (p) => /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
  // host:port@user:pass — the part after @ has no valid port, the part before it is host:port.
  let r = addressFirst(s);
  if (r && isHost(r[1]) && !portOk((s.split('@')[1] || '').split(':').pop())) {
    if (!portOk(r[2])) throw bad(`پورت «${r[2]}» نامعتبر است (باید بین ۱ و ۶۵۵۳۵ باشد)`);
    return `${scheme}://${enc(decodeURIComponent(r[3]))}${r[4] ? ':' + enc(decodeURIComponent(r[4])) : ''}@${r[1]}:${r[2]}${remark}`;
  }
  // host:port:user:pass
  r = !s.includes('@') && s.match(/^([^:\s]+):(\d+):([^:\s]+):(.+)$/);
  if (r && isHost(r[1])) {
    if (!portOk(r[2])) throw bad(`پورت «${r[2]}» نامعتبر است (باید بین ۱ و ۶۵۵۳۵ باشد)`);
    return `${scheme}://${enc(r[3])}:${enc(r[4])}@${r[1]}:${r[2]}${remark}`;
  }
  return `${scheme}://${s}${remark}`;
}

export function parseUri(raw) {
  const s = String(raw || '').trim();
  const port = s.match(/^[a-z0-9]+:\/\/(?:[^@/]*@)?(?:\[[^\]]+\]|[^:/?#]+):(\d+)/i)?.[1];
  if (port && !(Number(port) >= 1 && Number(port) <= 65535)) throw bad(`پورت «${port}» نامعتبر است (باید بین ۱ و ۶۵۵۳۵ باشد)`);
  let url;
  try {
    url = new URL(s.includes('://') ? s : `socks5://${s}`);
  } catch {
    throw bad('آدرس پروکسی نامعتبر است؛ قالب درست: socks5://USER:PASS@IP:PORT');
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username || '') || undefined,
    pass: decodeURIComponent(url.password || '') || undefined,
    protocol: url.protocol.replace(':', ''),
    search: url.searchParams,
    path: decodeURIComponent(url.pathname || ''),
  };
}

const truthy = (v) => v === '1' || v === 'true';
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : undefined);

/** TLS / Reality block from share-link parameters. */
function tlsFrom(q, host, { defaultOn = false } = {}) {
  const security = q.get('security');
  if (!(security === 'tls' || security === 'reality' || security === 'xtls' || (defaultOn && security !== 'none'))) return undefined;
  const fp = q.get('fp');
  const tls = {
    enabled: true,
    server_name: q.get('sni') || q.get('peer') || q.get('host') || host,
    insecure: truthy(q.get('allowInsecure')) || truthy(q.get('insecure')) || undefined,
    alpn: list(q.get('alpn')),
    // Reality needs a browser TLS fingerprint (uTLS); keep any fingerprint the link asks for.
    utls: fp || security === 'reality' ? { enabled: true, fingerprint: fp || 'chrome' } : undefined,
  };
  if (security === 'reality') tls.reality = { enabled: true, public_key: q.get('pbk') || '', short_id: q.get('sid') || '' };
  return tls;
}

/** ws / grpc / http / httpupgrade transport from share-link parameters. */
function transportFrom(type, { path, host, serviceName } = {}) {
  switch (type) {
    case 'ws':
      return { type: 'ws', path: path || '/', ...(host ? { headers: { Host: host } } : {}) };
    case 'grpc':
      return { type: 'grpc', service_name: serviceName || path || '' };
    case 'http':
    case 'h2':
      return { type: 'http', ...(host ? { host: list(host) } : {}), path: path || '/' };
    case 'httpupgrade':
      return { type: 'httpupgrade', path: path || '/', ...(host ? { host } : {}) };
    default:
      return undefined; // tcp / none
  }
}

export function parseShadowsocks(cfg) {
  let s = String(cfg).trim().replace(/^ss:\/\//, '');
  const hashAt = s.indexOf('#');
  if (hashAt >= 0) s = s.slice(0, hashAt);
  let query = '';
  const qAt = s.indexOf('?');
  if (qAt >= 0) {
    query = s.slice(qAt + 1);
    s = s.slice(0, qAt).replace(/\/$/, '');
  }
  // Legacy form: the whole "method:password@host:port" is base64.
  if (!s.includes('@')) {
    try {
      s = Buffer.from(s, 'base64').toString('utf8');
    } catch {
      /* keep */
    }
  }
  const at = s.lastIndexOf('@');
  if (at < 0) throw bad('لینک ss نامعتبر است');
  let userinfo = decodeURIComponent(s.slice(0, at));
  const hostport = s.slice(at + 1);
  if (!userinfo.includes(':')) userinfo = Buffer.from(userinfo, 'base64').toString('utf8');
  const i = userinfo.indexOf(':');
  const colon = hostport.lastIndexOf(':');
  const host = hostport.slice(0, colon).replace(/^\[|\]$/g, '');
  const out = { type: 'shadowsocks', server: host, server_port: Number(hostport.slice(colon + 1)) || 8388, method: userinfo.slice(0, i), password: userinfo.slice(i + 1) };
  // SIP003 plugin, e.g. plugin=obfs-local;obfs=http;obfs-host=example.com
  const plugin = new URLSearchParams(query).get('plugin');
  if (plugin) {
    const [name, ...opts] = plugin.split(';');
    out.plugin = name === 'simple-obfs' ? 'obfs-local' : name;
    out.plugin_opts = opts.join(';');
  }
  if (!out.server || !out.method) throw bad('لینک ss ناقص است');
  return out;
}

export function parseVless(cfg) {
  const u = parseUri(cfg.replace(/^vless:\/\//, 'https://'));
  const q = u.search;
  if (!u.user || !u.host) throw bad('لینک vless ناقص است');
  return {
    type: 'vless',
    server: u.host,
    server_port: u.port || 443,
    uuid: u.user,
    flow: q.get('flow') || undefined,
    packet_encoding: 'xudp',
    tls: tlsFrom(q, u.host),
    transport: transportFrom(q.get('type'), { path: q.get('path'), host: q.get('host'), serviceName: q.get('serviceName') }),
  };
}

export function parseVmess(cfg) {
  let j;
  try {
    j = JSON.parse(Buffer.from(String(cfg).trim().replace(/^vmess:\/\//, ''), 'base64').toString('utf8'));
  } catch {
    throw bad('لینک vmess نامعتبر است');
  }
  const q = new URLSearchParams();
  if (j.tls === 'tls') q.set('security', 'tls');
  if (j.sni) q.set('sni', j.sni);
  if (j.fp) q.set('fp', j.fp);
  if (j.alpn) q.set('alpn', j.alpn);
  return {
    type: 'vmess',
    server: j.add,
    server_port: Number(j.port) || 443,
    uuid: j.id,
    security: j.scy || 'auto',
    alter_id: Number(j.aid) || 0,
    tls: tlsFrom(q, j.host || j.add),
    transport: transportFrom(j.net, { path: j.path, host: j.host, serviceName: j.path }),
  };
}

export function parseTrojan(cfg) {
  const u = parseUri(cfg.replace(/^trojan:\/\//, 'https://'));
  const q = u.search;
  if (!u.user || !u.host) throw bad('لینک trojan ناقص است');
  return {
    type: 'trojan',
    server: u.host,
    server_port: u.port || 443,
    password: u.user,
    tls: tlsFrom(q, u.host, { defaultOn: true }),
    transport: transportFrom(q.get('type'), { path: q.get('path'), host: q.get('host'), serviceName: q.get('serviceName') }),
  };
}

export function parseHysteria2(cfg) {
  const u = parseUri(String(cfg).trim().replace(/^(hy2|hysteria2):\/\//, 'https://'));
  const q = u.search;
  const password = u.pass ? `${u.user}:${u.pass}` : u.user;
  if (!u.host) throw bad('لینک hysteria2 ناقص است');
  return {
    type: 'hysteria2',
    server: u.host,
    server_port: u.port || 443,
    password,
    ...(q.get('obfs') ? { obfs: { type: q.get('obfs'), password: q.get('obfs-password') || '' } } : {}),
    tls: { enabled: true, server_name: q.get('sni') || u.host, insecure: truthy(q.get('insecure')) || undefined, alpn: list(q.get('alpn')) || ['h3'] },
  };
}

export function parseTuic(cfg) {
  const u = parseUri(String(cfg).trim().replace(/^tuic:\/\//, 'https://'));
  const q = u.search;
  if (!u.user || !u.host) throw bad('لینک tuic ناقص است');
  return {
    type: 'tuic',
    server: u.host,
    server_port: u.port || 443,
    uuid: u.user,
    password: u.pass || '',
    congestion_control: q.get('congestion_control') || 'bbr',
    udp_relay_mode: q.get('udp_relay_mode') || undefined,
    tls: {
      enabled: true,
      server_name: q.get('sni') || u.host,
      insecure: truthy(q.get('allow_insecure')) || truthy(q.get('insecure')) || undefined,
      alpn: list(q.get('alpn')) || ['h3'],
    },
  };
}

// "host:port", "[v6]:port" or a bare host.
function hostPort(s, defPort) {
  const v = String(s || '').trim();
  const m = v.match(/^\[([^\]]+)\](?::(\d+))?$/) || v.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return { host: v, port: defPort };
  return { host: m[1], port: Number(m[2]) || defPort };
}

/**
 * WireGuard as a sing-box endpoint, from a standard .conf (all [Peer] sections, PresharedKey,
 * MTU, PersistentKeepalive) or from sing-box JSON (endpoint form or the older outbound form).
 */
export const WG_KEYS = new Set(['privatekey', 'address', 'mtu', 'publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive']);
function parseWireGuard(cfg) {
  const s = String(cfg || '').trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    if (j.peers) return { ...j, type: 'wireguard' };
    // Older sing-box outbound form → endpoint form.
    return {
      type: 'wireguard',
      address: j.local_address || ['10.0.0.2/32'],
      private_key: j.private_key,
      mtu: j.mtu || 1408,
      peers: [{ address: j.server, port: j.server_port || 51820, public_key: j.peer_public_key, pre_shared_key: j.pre_shared_key, allowed_ips: ['0.0.0.0/0', '::/0'], persistent_keepalive_interval: 25 }],
    };
  }
  // INI: [Interface] then one or more [Peer]. Comments (# or ;) are ignored.
  const sections = [];
  for (const raw of s.split(/\r?\n/)) {
    const comment = raw.search(/\s[#;]/);
    const line = (comment < 0 ? raw : raw.slice(0, comment)).trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = line.match(/^\[(\w+)\]$/);
    if (head) {
      sections.push({ name: head[1].toLowerCase(), v: {} });
      continue;
    }
    const eq = line.indexOf('=');
    const key = line.slice(0, Math.max(eq, 0)).trim().toLowerCase();
    if (sections.length && WG_KEYS.has(key)) sections.at(-1).v[key] = line.slice(eq + 1).trim();
  }
  const iface = sections.find((x) => x.name === 'interface')?.v || {};
  const peers = sections.filter((x) => x.name === 'peer').map((x) => x.v);
  if (!iface.privatekey) throw bad('کانفیگ WireGuard ناقص است: PrivateKey در بخش [Interface] نیست');
  if (!peers.length || !peers.some((p) => p.publickey && p.endpoint)) throw bad('کانفیگ WireGuard ناقص است: بخش [Peer] با PublicKey و Endpoint لازم است');
  return {
    type: 'wireguard',
    address: list(iface.address) || ['10.0.0.2/32'],
    private_key: iface.privatekey,
    mtu: Number(iface.mtu) || 1408,
    peers: peers
      .filter((p) => p.publickey && p.endpoint)
      .map((p) => {
        const ep = hostPort(p.endpoint, 51820);
        return {
          address: ep.host,
          port: ep.port,
          public_key: p.publickey,
          ...(p.presharedkey ? { pre_shared_key: p.presharedkey } : {}),
          allowed_ips: list(p.allowedips) || ['0.0.0.0/0', '::/0'],
          persistent_keepalive_interval: Number(p.persistentkeepalive) || 25,
        };
      }),
  };
}

// Drop empty optional fields (sing-box rejects some nulls).
function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (!o || typeof o !== 'object') return o;
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, clean(v)]));
}

/** One stored config → a sing-box outbound (or, for WireGuard, an endpoint) with the given tag. */
export function outboundFromConfig(cfg, protocol, tag) {
  const s = String(cfg || '').trim();
  let o;
  if (s.startsWith('{')) {
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      throw bad('JSON کانفیگ نامعتبر است');
    }
    if (j.type === 'openvpn') {
      if (!j.ovpn) throw bad('فایل OpenVPN خالی است');
      const id = Number(String(tag).replace(/^proxy-/, '')) || 0;
      return ovpnOutboundFn ? ovpnOutboundFn(id, tag) : { type: 'socks', tag, server: 'ovpn', server_port: 20000 + id, version: '5' };
    }
    o = j.type === 'wireguard' ? parseWireGuard(s) : j;
  } else {
    if (/^\s*(client|remote\s+\S+)/im.test(s) && /<ca>/i.test(s)) throw bad('این فایل OpenVPN است؛ در «افزودن» زبانه OpenVPN را بزنید');
    const p = protocol && protocol !== 'other' ? protocol : detectProtocol(s);
    if (p === 'wireguard' || /\[Interface\]/i.test(s)) o = parseWireGuard(s);
    else if (/^socks/i.test(s) || p === 'socks5' || p === 'socks4' || /^[a-z0-9.-]+:\d+[:@]/i.test(s)) {
      const link = normalizeProxyLink(s);
      const u = parseUri(link.replace(/^socks:\/\//i, 'socks5://'));
      // socks4 / socks4a links talk SOCKS4 (they used to be sent as SOCKS5 and always failed).
      const version = /^socks4a:/i.test(link) ? '4a' : /^socks4:/i.test(link) ? '4' : '5';
      o = { type: 'socks', server: u.host, server_port: u.port || 1080, version, username: u.user, ...(version === '5' ? { password: u.pass } : {}) };
    } else if (/^https?:\/\//i.test(s) || p === 'http') {
      const u = parseUri(normalizeProxyLink(s));
      o = { type: 'http', server: u.host, server_port: u.port || (u.protocol === 'https' ? 443 : 80), username: u.user, password: u.pass, ...(u.protocol === 'https' ? { tls: { enabled: true, server_name: u.host } } : {}) };
    } else if (/^ss:\/\//i.test(s)) o = parseShadowsocks(s);
    else if (/^vless:\/\//i.test(s)) o = parseVless(s);
    else if (/^vmess:\/\//i.test(s)) o = parseVmess(s);
    else if (/^trojan:\/\//i.test(s)) o = parseTrojan(s);
    else if (/^(hy2|hysteria2):\/\//i.test(s)) o = parseHysteria2(s);
    else if (/^tuic:\/\//i.test(s)) o = parseTuic(s);
    else throw bad('فرمت پشتیبانی نمی‌شود؛ لینک socks5 / http / ss / vless / vmess / trojan / hy2 / tuic، فایل WireGuard یا JSON sing-box');
  }
  if (!ALLOWED_TYPES.has(o.type)) throw bad(`نوع «${o.type || '؟'}» برای تلگرام مجاز نیست (مثلاً direct اتصال بدون پروکسی است)`);
  if (o.detour) throw bad('detour در کانفیگ مجاز نیست');
  return clean({ ...o, tag });
}

export function detectProtocol(cfg) {
  const s = String(cfg || '').trim().toLowerCase();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(String(cfg).trim());
      if (j.type === 'shadowsocks') return 'ss';
      if (j.type === 'socks') return 'socks5';
      if (j.type) return j.type;
    } catch {
      /* */
    }
    return 'other';
  }
  if (s.startsWith('vless://')) return 'vless';
  if (s.startsWith('vmess://')) return 'vmess';
  if (s.startsWith('trojan://')) return 'trojan';
  if (s.startsWith('ss://')) return 'ss';
  if (s.startsWith('socks4')) return 'socks4';
  if (/^[a-z0-9.-]+:\d+[:@]/.test(s)) return 'socks5'; // host:port:user:pass without a scheme
  if (s.startsWith('socks')) return 'socks5';
  if (s.startsWith('http')) return 'http';
  if (s.includes('[interface]') && s.includes('privatekey')) return 'wireguard';
  if (s.startsWith('hy2://') || s.startsWith('hysteria2://')) return 'hysteria2';
  if (s.startsWith('tuic://')) return 'tuic';
  return 'other';
}

/** A readable name for a config: the link's #remark, vmess "ps", or the server address. */
export function nameOfConfig(cfg) {
  const s = String(cfg || '').trim();
  const hash = s.match(/#([^\n]+)$/);
  if (hash && /^[a-z0-9]+:\/\//i.test(s)) {
    try {
      return decodeURIComponent(hash[1]).trim().slice(0, 80);
    } catch {
      return hash[1].trim().slice(0, 80);
    }
  }
  if (/^vmess:\/\//i.test(s)) {
    try {
      const j = JSON.parse(Buffer.from(s.slice(8), 'base64').toString('utf8'));
      if (j.ps) return String(j.ps).slice(0, 80);
    } catch {
      /* */
    }
  }
  if (/\[Interface\]/i.test(s)) {
    const ep = s.match(/Endpoint\s*=\s*(\S+)/i);
    return `WireGuard ${ep ? ep[1] : ''}`.trim();
  }
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return String(j.tag || `${j.type || 'JSON'} ${j.server || j.peers?.[0]?.address || ''}`).trim().slice(0, 80);
    } catch {
      /* */
    }
  }
  try {
    const u = parseUri(s);
    return `${u.protocol} ${u.host}${u.port ? ':' + u.port : ''}`;
  } catch {
    return '';
  }
}

/**
 * What an admin pasted → separate configs. A WireGuard .conf (or several) and JSON stay whole —
 * splitting them by line was what broke WireGuard imports. Share links go one per line, and a
 * base64 subscription is decoded first.
 */
export function splitConfigs(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!s) return [];
  if (/\[Interface\]/i.test(s)) {
    return s
      .split(/(?=^\s*\[Interface\])/im)
      .map((x) => x.trim())
      .filter((x) => /\[Interface\]/i.test(x));
  }
  if (s.startsWith('{') || s.startsWith('[')) {
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      throw bad('JSON نامعتبر است');
    }
    // A full sing-box config: take its usable outbounds/endpoints; an array: each item.
    const items = Array.isArray(j) ? j : j.outbounds || j.endpoints ? [...(j.endpoints || []), ...(j.outbounds || [])] : [j];
    return items.filter((o) => o && ALLOWED_TYPES.has(o.type)).map((o) => JSON.stringify(o));
  }
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  if (lines.length === 1 && !lines[0].includes('://') && /^[A-Za-z0-9+/=_-]{16,}$/.test(lines[0])) {
    const decoded = Buffer.from(lines[0], 'base64').toString('utf8');
    if (decoded.includes('://')) return splitConfigs(decoded);
  }
  return lines;
}

// ---------- The manual form in the admin panel (like the outbound form of x-ui panels) ----------
const SS_METHODS = new Set([
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305', 'none',
]);
const FINGERPRINTS = new Set(['chrome', 'firefox', 'safari', 'edge', 'ios', 'android', 'random', 'randomized', '360', 'qq']);

/**
 * Form fields → sing-box outbound/endpoint. Every value is checked here; nothing from the form is
 * passed through as raw JSON.
 */
export function outboundFromForm(f = {}) {
  const str = (k, max = 512) => String(f[k] ?? '').trim().slice(0, max);
  const need = (k, label) => {
    const v = str(k);
    if (!v) throw bad(`«${label}» لازم است`);
    return v;
  };
  const server = need('server', 'آدرس سرور');
  if (!/^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+|[a-z0-9-]+(\.[a-z0-9-]+)+)$/i.test(server)) throw bad('آدرس سرور فقط IP یا دامنه است (بدون http:// و پورت)');
  const port = Number(f.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('پورت باید عددی بین ۱ و ۶۵۵۳۵ باشد');
  const base = { server, server_port: port };
  const tls = () => {
    if (!f.tls && f.security !== 'tls' && f.security !== 'reality') return undefined;
    const fp = str('fingerprint', 20);
    if (fp && !FINGERPRINTS.has(fp)) throw bad('fingerprint نامعتبر است');
    const t = { enabled: true, server_name: str('sni', 253) || server, insecure: !!f.insecure || undefined, alpn: list(str('alpn', 100)) };
    if (fp || f.security === 'reality') t.utls = { enabled: true, fingerprint: fp || 'chrome' };
    if (f.security === 'reality') t.reality = { enabled: true, public_key: need('publicKey', 'Public key (pbk)'), short_id: str('shortId', 32) };
    return t;
  };
  const transport = () => {
    const type = str('transport', 20);
    if (!type || type === 'tcp') return undefined;
    if (!['ws', 'grpc', 'http', 'httpupgrade'].includes(type)) throw bad('transport نامعتبر است');
    return transportFrom(type, { path: str('path', 256), host: str('host', 253), serviceName: str('serviceName', 128) });
  };
  let o;
  switch (f.type) {
    case 'socks5':
    case 'socks4':
    case 'socks4a': {
      const version = f.type === 'socks5' ? '5' : f.type === 'socks4' ? '4' : '4a';
      o = { type: 'socks', ...base, version, username: str('username', 255) || undefined };
      if (version === '5') o.password = str('password', 255) || undefined;
      break;
    }
    case 'http':
      o = { type: 'http', ...base, username: str('username', 255) || undefined, password: str('password', 255) || undefined, tls: f.tls ? tls() : undefined };
      break;
    case 'shadowsocks': {
      const method = need('method', 'روش رمزنگاری');
      if (!SS_METHODS.has(method)) throw bad('روش رمزنگاری Shadowsocks نامعتبر است');
      o = { type: 'shadowsocks', ...base, method, password: need('password', 'رمز'), plugin: str('plugin', 40) || undefined, plugin_opts: str('pluginOpts', 512) || undefined };
      break;
    }
    case 'vless':
      o = { type: 'vless', ...base, uuid: need('uuid', 'UUID'), flow: str('flow', 40) || undefined, packet_encoding: 'xudp', tls: tls(), transport: transport() };
      break;
    case 'vmess':
      o = { type: 'vmess', ...base, uuid: need('uuid', 'UUID'), security: str('cipher', 30) || 'auto', alter_id: Number(f.alterId) || 0, tls: tls(), transport: transport() };
      break;
    case 'trojan':
      o = { type: 'trojan', ...base, password: need('password', 'رمز'), tls: tls() || { enabled: true, server_name: str('sni', 253) || server }, transport: transport() };
      break;
    case 'hysteria2':
      o = {
        type: 'hysteria2', ...base, password: need('password', 'رمز'),
        ...(str('obfsPassword') ? { obfs: { type: 'salamander', password: str('obfsPassword') } } : {}),
        up_mbps: Number(f.upMbps) || undefined, down_mbps: Number(f.downMbps) || undefined,
        tls: { enabled: true, server_name: str('sni', 253) || server, insecure: !!f.insecure || undefined, alpn: ['h3'] },
      };
      break;
    case 'tuic':
      o = {
        type: 'tuic', ...base, uuid: need('uuid', 'UUID'), password: str('password', 255), congestion_control: str('congestion', 20) || 'bbr',
        tls: { enabled: true, server_name: str('sni', 253) || server, insecure: !!f.insecure || undefined, alpn: list(str('alpn', 100)) || ['h3'] },
      };
      break;
    case 'wireguard': {
      const key = (k, label) => {
        const v = need(k, label);
        if (!/^[A-Za-z0-9+/]{42,43}=?$/.test(v)) throw bad(`«${label}» کلید WireGuard معتبر نیست`);
        return v;
      };
      const psk = str('presharedKey', 64);
      if (psk && !/^[A-Za-z0-9+/]{42,43}=?$/.test(psk)) throw bad('«Preshared key» معتبر نیست');
      o = {
        type: 'wireguard', address: list(str('address', 200)) || ['10.0.0.2/32'], private_key: key('privateKey', 'Private key'), mtu: Number(f.mtu) || 1408,
        peers: [{ address: server, port, public_key: key('publicKey', 'Public key سرور'), ...(psk ? { pre_shared_key: psk } : {}), allowed_ips: ['0.0.0.0/0', '::/0'], persistent_keepalive_interval: 25 }],
      };
      break;
    }
    default:
      throw bad('نوع پروکسی را انتخاب کنید');
  }
  return clean(o);
}
