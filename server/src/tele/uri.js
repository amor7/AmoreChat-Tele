/** Best-effort VPN/proxy share links → sing-box outbound. Prefer full JSON for complex Reality / WG. */

export function parseUri(raw) {
  const s = String(raw || '').trim();
  let url;
  try {
    url = new URL(s.includes('://') ? s : `socks5://${s}`);
  } catch {
    throw new Error('آدرس پروکسی نامعتبر است');
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    user: decodeURIComponent(url.username || '') || undefined,
    pass: decodeURIComponent(url.password || '') || undefined,
    protocol: url.protocol.replace(':', ''),
    search: url.searchParams,
  };
}

export function parseShadowsocks(cfg) {
  let s = String(cfg).replace(/^ss:\/\//, '');
  if (!s.includes('@') && !s.includes(':')) {
    try {
      s = Buffer.from(s.split('#')[0], 'base64').toString('utf8');
    } catch {
      /* keep */
    }
  }
  const [userinfo, hostport] = s.split('@');
  if (!hostport) throw new Error('ss نامعتبر');
  const [host, portStr] = hostport.split('#')[0].split(':');
  let method, password;
  if (userinfo.includes(':')) {
    const i = userinfo.indexOf(':');
    method = userinfo.slice(0, i);
    password = userinfo.slice(i + 1);
  } else {
    const decoded = Buffer.from(userinfo, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    method = decoded.slice(0, i);
    password = decoded.slice(i + 1);
  }
  return { server: host, server_port: Number(portStr) || 8388, method, password };
}

export function parseVless(cfg) {
  const u = parseUri(cfg.replace(/^vless:\/\//, 'https://'));
  const q = u.search;
  return {
    type: 'vless',
    server: u.host,
    server_port: u.port || 443,
    uuid: u.user,
    flow: q.get('flow') || undefined,
    tls:
      q.get('security') === 'tls' || q.get('security') === 'reality'
        ? {
            enabled: true,
            server_name: q.get('sni') || q.get('host') || u.host,
            reality:
              q.get('security') === 'reality'
                ? { enabled: true, public_key: q.get('pbk') || '', short_id: q.get('sid') || '' }
                : undefined,
          }
        : undefined,
  };
}

export function parseVmess(cfg) {
  const j = JSON.parse(Buffer.from(String(cfg).replace(/^vmess:\/\//, ''), 'base64').toString('utf8'));
  return {
    type: 'vmess',
    server: j.add,
    server_port: Number(j.port) || 443,
    uuid: j.id,
    security: j.scy || 'auto',
    alter_id: Number(j.aid) || 0,
  };
}

export function parseTrojan(cfg) {
  const u = parseUri(cfg.replace(/^trojan:\/\//, 'https://'));
  const q = u.search;
  return {
    type: 'trojan',
    server: u.host,
    server_port: u.port || 443,
    password: u.user,
    tls: { enabled: true, server_name: q.get('sni') || u.host },
  };
}

/** WireGuard: INI conf, or sing-box wireguard JSON, or wg:// host style. */
export function parseWireGuard(cfg) {
  const s = String(cfg || '').trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    return { type: 'wireguard', ...j };
  }
  // Standard .conf style
  if (/\[Interface\]/i.test(s) && /PrivateKey/i.test(s)) {
    const privateKey = (s.match(/PrivateKey\s*=\s*(\S+)/i) || [])[1];
    const addressLine = (s.match(/Address\s*=\s*([^\n]+)/i) || [])[1] || '';
    const localAddress = addressLine
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const peerSection = s.split(/\[Peer\]/i)[1] || '';
    const publicKey = (peerSection.match(/PublicKey\s*=\s*(\S+)/i) || [])[1];
    const endpoint = (peerSection.match(/Endpoint\s*=\s*(\S+)/i) || [])[1] || '';
    const allowedIps = ((peerSection.match(/AllowedIPs\s*=\s*([^\n]+)/i) || [])[1] || '0.0.0.0/0')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const [server, portStr] = endpoint.split(':');
    if (!privateKey || !publicKey || !server) {
      throw new Error('کانفیگ WireGuard ناقص است (PrivateKey / PublicKey / Endpoint)');
    }
    return {
      type: 'wireguard',
      private_key: privateKey,
      peer_public_key: publicKey,
      local_address: localAddress.length ? localAddress : ['10.0.0.2/32'],
      server,
      server_port: Number(portStr) || 51820,
      allowed_ips: allowedIps,
      mtu: 1280,
    };
  }
  throw new Error('WireGuard: فایل .conf یا JSON outbound sing-box لازم است');
}

export function outboundFromConfig(cfg, protocol, tag) {
  const s = String(cfg || '').trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    return { ...j, tag: j.tag || tag };
  }
  const p = protocol || detectProtocol(s);
  if (p === 'socks5' || s.startsWith('socks')) {
    const u = parseUri(s.replace(/^socks:\/\//, 'socks5://'));
    return {
      type: 'socks',
      tag,
      server: u.host,
      server_port: u.port || 1080,
      version: '5',
      username: u.user,
      password: u.pass,
    };
  }
  if (p === 'http' || s.startsWith('http')) {
    const u = parseUri(s);
    return {
      type: 'http',
      tag,
      server: u.host,
      server_port: u.port || 80,
      username: u.user,
      password: u.pass,
    };
  }
  if (p === 'ss' || s.startsWith('ss://')) return { type: 'shadowsocks', tag, ...parseShadowsocks(s) };
  if (p === 'vless' || s.startsWith('vless://')) return { ...parseVless(s), tag };
  if (p === 'vmess' || s.startsWith('vmess://')) return { ...parseVmess(s), tag };
  if (p === 'trojan' || s.startsWith('trojan://')) return { ...parseTrojan(s), tag };
  if (p === 'wireguard' || /\[Interface\]/i.test(s)) return { ...parseWireGuard(s), tag };
  throw new Error(
    'فرمت پشتیبانی نشده؛ JSON outbound یا socks5/http/ss/vless/vmess/trojan/wireguard',
  );
}

export function detectProtocol(cfg) {
  const s = String(cfg || '').trim().toLowerCase();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(String(cfg).trim());
      if (j.type === 'wireguard') return 'wireguard';
      if (j.type) return j.type;
    } catch {
      /* */
    }
    return 'json';
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
