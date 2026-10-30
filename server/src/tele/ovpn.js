/**
 * OpenVPN for the Tele VPN. sing-box has no OpenVPN, so the "ovpn" service of docker-compose.yml
 * (the same image, with NET_ADMIN, which the app itself does not get) runs one openvpn per config,
 * each with its own tunnel and a SOCKS port whose connections leave only through that tunnel
 * (server/ovpn/). For the app's sing-box an OpenVPN config is then a SOCKS proxy at ovpn:<port>.
 *
 * The app writes data/ovpn/<proxy id>/: client.ovpn (cleaned, see cleanOvpn), auth.txt (login),
 * socks.auth (the SOCKS password) and gen (changes when any of them changes); the service writes
 * up (the tunnel's address, while connected) and log.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, DATA_DIR } from '../db.js';
import { setOvpnOutbound } from './uri.js';

export const OVPN_DIR = path.join(DATA_DIR, 'ovpn');
export const OVPN_HOST = process.env.TELE_OVPN_HOST || 'ovpn';
export const OVPN_BASE_PORT = 20000;
const MAX_BYTES = 256 * 1024;

const bad = (m) => Object.assign(new Error(m), { statusCode: 400 });

// Directives the service sets itself, or that would run commands / write files in it: dropped.
const DROP = new Set([
  'script-security', 'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'client-connect', 'client-disconnect', 'learn-address',
  'tls-verify', 'auth-user-pass-verify', 'plugin', 'management', 'management-client', 'management-hold', 'management-query-passwords',
  'log', 'log-append', 'status', 'writepid', 'cd', 'chroot', 'daemon', 'user', 'group', 'config', 'dev', 'dev-type', 'dev-node',
  'redirect-gateway', 'route', 'route-ipv6', 'route-nopull', 'route-noexec', 'ifconfig-noexec', 'iproute', 'setenv', 'setenv-safe',
  'tmp-dir', 'syslog', 'mlock', 'up-delay', 'down-pre', 'up-restart', 'persist-tun', 'block-outside-dns', 'register-dns', 'service',
  'auth-user-pass', 'askpass', 'pull-filter', 'echo', 'machine-readable-output', 'verb', 'mute', 'connect-retry', 'connect-retry-max',
  'tls-export-cert', 'dhcp-option', 'ip-win32', 'route-method', 'route-delay', 'route-gateway', 'route-metric', 'allow-pull-fqdn',
]);
// Inline blocks kept as they are (certificates and keys).
const BLOCKS = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'extra-certs', 'dh', 'secret', 'pkcs12', 'crl-verify', 'http-proxy-user-pass', 'peer-fingerprint']);

/** A .ovpn file without what the service sets itself or what could run anything; checks it is usable. */
export function cleanOvpn(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!src.trim()) throw bad('فایل OpenVPN خالی است');
  if (Buffer.byteLength(src) > MAX_BYTES) throw bad('فایل OpenVPN بیش از حد بزرگ است');
  const out = [];
  let block = null;
  let remotes = 0;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (block) {
      out.push(line);
      if (t.toLowerCase() === `</${block}>`) block = null;
      continue;
    }
    const open = t.match(/^<([a-z0-9-]+)>$/i);
    if (open) {
      const name = open[1].toLowerCase();
      if (name === 'connection') {
        out.push(line);
        continue;
      }
      if (!BLOCKS.has(name)) throw bad(`بخش <${name}> در فایل OpenVPN پشتیبانی نمی‌شود`);
      block = name;
      out.push(line);
      continue;
    }
    if (/^<\/connection>$/i.test(t)) {
      out.push(line);
      continue;
    }
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const word = t.replace(/^--/, '').split(/\s+/)[0].toLowerCase();
    if (word === 'dev' && /\btap/i.test(t)) throw bad('فقط OpenVPN با dev tun پشتیبانی می‌شود (tap نه)');
    if (word === 'remote') remotes++;
    if (DROP.has(word)) continue;
    out.push(t);
  }
  if (block) throw bad(`بخش <${block}> در فایل OpenVPN بسته نشده است`);
  if (!remotes) throw bad('در فایل OpenVPN آدرس سرور (remote) نیست');
  return out.join('\n') + '\n';
}

/** Whether a pasted text is a .ovpn file. */
export const looksLikeOvpn = (s) => /^\s*(client|remote\s+\S+)/im.test(String(s || '')) && /<ca>|^\s*ca\s/im.test(String(s || ''));

/** The JSON stored for an OpenVPN proxy. */
export function ovpnConfig({ ovpn, username = '', password = '' }) {
  return JSON.stringify({ type: 'openvpn', ovpn: cleanOvpn(ovpn), username: String(username || '').slice(0, 200), password: String(password || '').slice(0, 200) });
}

const portOf = (id) => OVPN_BASE_PORT + Number(id);
const socksPass = (dir) => {
  const f = path.join(dir, 'socks.auth');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
};

/** The sing-box outbound of an OpenVPN proxy: the service's SOCKS port of that config. */
export function ovpnOutbound(id, tag) {
  return { type: 'socks', tag, server: OVPN_HOST, server_port: portOf(id), version: '5', username: 'tele', password: socksPass(path.join(OVPN_DIR, String(id))) };
}

setOvpnOutbound(ovpnOutbound);

/** Is the tunnel of this config up, and the last lines of its log. */
export function ovpnState(id) {
  const dir = path.join(OVPN_DIR, String(id));
  let up = '';
  let log = '';
  try {
    up = fs.readFileSync(path.join(dir, 'up'), 'utf8').trim();
  } catch {
    /* not connected */
  }
  try {
    const s = fs.readFileSync(path.join(dir, 'log'), 'utf8');
    log = s.slice(-4000);
  } catch {
    /* not started yet */
  }
  return { up: !!up, address: up, log };
}

/** Why a tunnel is not up, from its log, in a few words. */
export function ovpnError(id) {
  const { up, log } = ovpnState(id);
  if (up) return '';
  if (!log) return 'سرویس OpenVPN هنوز این کانفیگ را اجرا نکرده (سرویس ovpn روشن است؟ sudo docker compose ps)';
  const lines = log.trim().split('\n').reverse();
  const hit = lines.find((l) => /AUTH_FAILED|TLS Error|Cannot resolve|Connection refused|Network is unreachable|Options error|VERIFY ERROR|failed|error/i.test(l));
  const plain = (l) => l.replace(/^\S+ \S+ /, '').replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, '').slice(0, 200);
  if (hit && /AUTH_FAILED/.test(hit)) return 'OpenVPN: نام کاربری یا رمز اشتباه است (AUTH_FAILED)';
  return `OpenVPN وصل نشد: ${plain(hit || lines[0] || '')}`;
}

const writeIfChanged = (file, data) => {
  try {
    if (fs.readFileSync(file, 'utf8') === data) return false;
  } catch {
    /* new */
  }
  fs.writeFileSync(file, data, { mode: 0o600 });
  return true;
};

/**
 * Makes data/ovpn match the enabled OpenVPN proxies: a folder per config (the service starts it,
 * and restarts it when gen changes); folders of removed / turned-off ones go (the service stops them).
 */
export function syncOvpn() {
  const rows = all("SELECT id, config, enabled FROM tele_proxies WHERE protocol = 'openvpn'");
  const keep = new Set();
  fs.mkdirSync(OVPN_DIR, { recursive: true, mode: 0o700 });
  for (const r of rows) {
    if (!r.enabled) continue;
    let j;
    try {
      j = JSON.parse(r.config);
    } catch {
      continue;
    }
    if (j.type !== 'openvpn') continue;
    const dir = path.join(OVPN_DIR, String(r.id));
    keep.add(String(r.id));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let changed = writeIfChanged(path.join(dir, 'client.ovpn'), j.ovpn);
    const auth = j.username ? `${j.username}\n${j.password}\n` : '';
    if (auth) changed = writeIfChanged(path.join(dir, 'auth.txt'), auth) || changed;
    else if (fs.existsSync(path.join(dir, 'auth.txt'))) {
      fs.rmSync(path.join(dir, 'auth.txt'));
      changed = true;
    }
    if (!socksPass(dir)) {
      fs.writeFileSync(path.join(dir, 'socks.auth'), crypto.randomBytes(18).toString('hex'), { mode: 0o600 });
      changed = true;
    }
    if (changed || !fs.existsSync(path.join(dir, 'gen'))) fs.writeFileSync(path.join(dir, 'gen'), String(Date.now()));
  }
  for (const name of fs.readdirSync(OVPN_DIR)) {
    if (/^\d+$/.test(name) && !keep.has(name)) fs.rmSync(path.join(OVPN_DIR, name), { recursive: true, force: true });
  }
}
