/**
 * Proxy configs (share links, WireGuard .conf, sing-box JSON) → sing-box outbound / endpoint.
 * Written for sing-box 1.12+ (bundled in the image): WireGuard is an endpoint there, not an outbound.
 */

// Outbound types an admin may paste as JSON. Anything that could reach Telegram without the proxy
// (direct, selector/urltest groups that might pick direct, dns, block) is refused: Tele is fail-closed.
const ALLOWED_TYPES = new Set(['socks', 'http', 'shadowsocks', 'vless', 'vmess', 'trojan', 'wireguard', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'shadowtls', 'ssh']);

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

export function parseUri(raw) {
  const s = String(raw || '').trim();
  let url;
  try {
    url = new URL(s.includes('://') ? s : `socks5://${s}`);
  } catch {
    throw bad('آدرس پروکسی نامعتبر است');
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
export function parseWireGuard(cfg) {
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
    const line = raw.replace(/\s[#;].*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const head = line.match(/^\[(\w+)\]$/);
    if (head) {
      sections.push({ name: head[1].toLowerCase(), v: {} });
      continue;
    }
    const kv = line.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (kv && sections.length) sections.at(-1).v[kv[1].toLowerCase()] = kv[2].trim();
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
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = clean(v);
  return out;
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
    o = j.type === 'wireguard' ? parseWireGuard(s) : j;
  } else {
    const p = protocol && protocol !== 'other' ? protocol : detectProtocol(s);
    if (p === 'wireguard' || /\[Interface\]/i.test(s)) o = parseWireGuard(s);
    else if (/^socks/i.test(s) || p === 'socks5') {
      const u = parseUri(s.replace(/^socks:\/\//i, 'socks5://'));
      o = { type: 'socks', server: u.host, server_port: u.port || 1080, version: '5', username: u.user, password: u.pass };
    } else if (/^https?:\/\//i.test(s) || p === 'http') {
      const u = parseUri(s);
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
