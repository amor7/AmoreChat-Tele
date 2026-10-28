// Locked out (e.g. the owner forgot the password, or lost the two-step login phone)?
// On the server:  sudo docker compose exec app node server/src/reset-password-cli.js <username> [--no-2fa]
// Prints a new random password; all of that account's devices are signed out. --no-2fa also
// turns off two-step login for it. Only someone with root on the server can run this.
import crypto from 'node:crypto';
import { get, run } from './db.js';
import { hashPassword } from './auth.js';

const username = process.argv[2];
const no2fa = process.argv.includes('--no-2fa');
if (!username || username.startsWith('-')) {
  console.log('usage: node server/src/reset-password-cli.js <username> [--no-2fa]');
  const owner = get("SELECT username FROM users WHERE role = 'owner' LIMIT 1");
  if (owner) console.log(`(the owner's username is: ${owner.username})`);
  process.exit(1);
}
const u = get('SELECT id, username, role FROM users WHERE lower(username) = lower(?)', username);
if (!u) {
  console.log(`no user "${username}"`);
  process.exit(1);
}
const password = crypto.randomBytes(9).toString('base64url') + '-7a';
run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', await hashPassword(password), u.id);
if (no2fa) run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]' WHERE id = ?", u.id);
run('DELETE FROM sessions WHERE user_id = ?', u.id);
console.log(`new password for ${u.username} (${u.role}): ${password}`);
if (no2fa) console.log('two-step login turned off');
console.log('Sign in with it and change it in Profile > Change password.');
process.exit(0);
