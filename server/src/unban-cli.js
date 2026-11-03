// Banned your own IP by mistake? On the server:  sudo amorechat-unban [IP | --all]
// (or: sudo docker compose exec app node server/src/unban-cli.js ...)
// With no argument it lists the banned IPs. The running app picks the change up within seconds.
import { all, run, now } from './db.js';
import { normalizeIp } from './secwatch.js';

const arg = process.argv[2];
const active = () => all('SELECT ip, reason, expires_at FROM ip_bans WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC', now());
if (!arg) {
  const bans = active();
  if (!bans.length) console.log('no banned IPs');
  for (const b of bans) {
    const until = b.expires_at ? `until ${new Date(b.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'permanent';
    console.log(`${b.ip}  (${until})${b.reason ? `  ${b.reason}` : ''}`);
  }
  console.log('usage: amorechat-unban <IP>   or   amorechat-unban --all');
  process.exit(0);
}
if (arg === '--all') {
  const n = run('DELETE FROM ip_bans').changes;
  console.log(`unbanned ${n} IP(s)`);
  process.exit(0);
}
const ip = normalizeIp(arg);
if (!ip) {
  console.log(`not an IP address: ${arg}`);
  process.exit(1);
}
const n = run('DELETE FROM ip_bans WHERE ip = ?', ip).changes;
console.log(n ? `unbanned ${ip}` : `${ip} was not banned`);
process.exit(0);
