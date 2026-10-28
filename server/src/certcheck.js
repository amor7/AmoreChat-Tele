import tls from 'node:tls';
import net from 'node:net';
import { raiseAlert, resolveAlert } from './health.js';

// HTTPS certificate watch: asks Caddy (inside the compose network) which certificate it serves
// and warns the admins well before it expires. Let's Encrypt certificates last 90 days and are
// renewed ~30 days before the end; renewal needs the international internet, so during a long
// shutdown the remaining days run out. Nothing leaves the server.
const HOST = process.env.CERT_CHECK_HOST || 'caddy';
const PORT = Number(process.env.CERT_CHECK_PORT) || 443;
const DOMAIN = (process.env.DOMAIN || '').trim();
const MODE = process.env.TLS_MODE || 'auto';
const EVERY = 6 * 3600e3;
const WARN_DAYS = 20;
const DAY = 86400e3;

let info = null; // { mode, domain, issuer, notAfter, daysLeft, checkedAt } or { error }
export const certInfo = () => info;

function peerCert() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT, servername: DOMAIN && !net.isIP(DOMAIN) ? DOMAIN : undefined, rejectUnauthorized: false, timeout: 10000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      c?.valid_to ? resolve(c) : reject(new Error('no certificate'));
    });
    sock.on('timeout', () => sock.destroy(new Error('timeout')));
    sock.on('error', reject);
  });
}

export async function checkCert() {
  if (MODE === 'off') {
    // Plain HTTP on purpose: no certificate to watch.
    info = { mode: MODE, domain: DOMAIN, checkedAt: Date.now() };
    await resolveAlert('cert-expiry');
    return info;
  }
  let c;
  try {
    c = await peerCert();
  } catch (e) {
    info = { mode: MODE, domain: DOMAIN, error: e.message, checkedAt: Date.now() };
    return info;
  }
  const notAfter = Date.parse(c.valid_to);
  const daysLeft = Math.floor((notAfter - Date.now()) / DAY);
  info = { mode: MODE, domain: DOMAIN, issuer: c.issuer?.O || c.issuer?.CN || '', notAfter, daysLeft, checkedAt: Date.now() };

  // The server's own CA (internal) renews its short-lived certificates locally all the time:
  // only an already expired one is a problem there.
  const limit = MODE === 'internal' ? 0 : WARN_DAYS;
  if (daysLeft < limit) {
    const why =
      MODE === 'auto'
        ? 'تمدید خودکار Let\'s Encrypt انجام نشده (معمولاً یعنی سرور به اینترنت بین‌الملل دسترسی ندارد). اگر قطعی طولانی است، به حالت گواهی داخلی (TLS_MODE=internal) بروید.'
        : MODE === 'custom'
          ? 'فایل‌های گواهی خودتان (certs/cert.pem) را با گواهی جدید عوض کنید.'
          : 'گواهی داخلی سرور منقضی شده؛ سرویس caddy را ری‌استارت کنید.';
    const when = daysLeft < 0 ? 'منقضی شده است' : `${daysLeft} روز دیگر منقضی می‌شود`;
    await raiseAlert('cert-expiry', `گواهی HTTPS (${DOMAIN || 'سرور'}) ${when}. ${why}`);
  } else {
    await resolveAlert('cert-expiry');
  }
  return info;
}

// ---------- Domain DNS: will the name still resolve during an international shutdown? ----------
// Iranian resolvers can't reach name servers abroad then, so a domain whose DNS is hosted abroad
// (Cloudflare, ...) or that isn't under .ir stops resolving, although the server itself is fine.
const FOREIGN_DNS = /cloudflare\.com|awsdns|azure-dns|googledomains\.com|google\.com|domaincontrol\.com|registrar-servers\.com|hetzner|digitalocean\.com|linode\.com|ovh\.net|name\.com|dnsimple|nsone\.net|ultradns|gandi\.net|he\.net|cloudns\.net|dynect|vercel-dns|netlify/i;
let dnsInfo = null;
export const domainDnsInfo = () => dnsInfo;

export async function checkDomainDns() {
  if (!DOMAIN || net.isIP(DOMAIN)) return (dnsInfo = null);
  const { promises: dns } = await import('node:dns');
  // The system resolver first; some don't answer NS queries, then public ones (normal times only).
  const fallback = new dns.Resolver({ timeout: 4000, tries: 1 });
  fallback.setServers(['1.1.1.1', '8.8.8.8']);
  const lookup = async (zone) => {
    const a = await dns.resolveNs(zone).catch(() => []);
    return a.length ? a : fallback.resolveNs(zone).catch(() => []);
  };
  const parts = DOMAIN.split('.');
  let ns = [];
  let zone = '';
  for (let i = 0; i < parts.length - 1 && !ns.length; i++) {
    zone = parts.slice(i).join('.');
    ns = await lookup(zone);
  }
  const foreign = ns.filter((h) => FOREIGN_DNS.test(h));
  const notIr = !DOMAIN.toLowerCase().endsWith('.ir');
  dnsInfo = { zone, ns, foreign: foreign.length > 0, notIr, checkedAt: Date.now() };
  if (dnsInfo.foreign || notIr) {
    const why = notIr
      ? `دامنه ${DOMAIN} زیر .ir نیست؛ سرورهای آن خارج از ایران‌اند`
      : `DNS دامنه ${zone} روی سرورهای خارجی است (${foreign.join('، ')})`;
    await raiseAlert('dns-foreign', `${why}. در قطعی اینترنت بین‌الملل، گوشی‌ها آدرس سرور را پیدا نمی‌کنند و برنامه باز نمی‌شود، با اینکه سرور سالم است. DNS را به یک سرویس داخلی منتقل کنید (مثلاً DNS ابر آروان یا DNS شرکت هاستینگ ایرانی) یا از دامنه .ir با DNS داخلی استفاده کنید.`);
  } else if (ns.length) {
    await resolveAlert('dns-foreign');
  }
  return dnsInfo;
}

export function startCertCheck(log) {
  if (!DOMAIN && !process.env.CERT_CHECK_HOST) return; // not behind the bundled Caddy (dev)
  const run = () => {
    checkCert().catch((e) => log?.warn(`certificate check failed: ${e.message}`));
    checkDomainDns().catch((e) => log?.warn(`DNS check failed: ${e.message}`));
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, EVERY).unref();
}
