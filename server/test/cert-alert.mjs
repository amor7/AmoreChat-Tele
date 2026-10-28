// HTTPS certificate expiry warning: a stand-in "Caddy" serves a certificate that expires in
// 10 days; the server must report it on the health dashboard and alert the owner.
// Usage: node test/cert-alert.mjs   (needs openssl; starts its own server on a fresh data dir)
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '10', '-subj', '/CN=chat.test', '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`], { stdio: 'ignore' });
const fake = tls.createServer({ key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) }, (s) => s.end());
await new Promise((ok) => fake.listen(18443, '127.0.0.1', ok));

const PORT = 3321;
const BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(PORT), DOMAIN: 'chat.test', TLS_MODE: 'auto', CERT_CHECK_HOST: '127.0.0.1', CERT_CHECK_PORT: '18443' },
});
let log = '';
srv.stdout.on('data', (d) => (log += d));
srv.stderr.on('data', (d) => (log += d));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let code;
for (let i = 0; i < 80 && !code; i++) {
  await sleep(250);
  code = log.match(/SETUP CODE: (\S+)/)?.[1];
}
assert.ok(code, 'server started');

let cookie = '';
async function call(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'x-requested-with': 'amorechat', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}
try {
  assert.equal((await call('POST', '/api/auth/register', { username: 'owner', password: 'Str0ng-Pass-77', displayName: 'Owner', invite: code })).status, 200);
  const h = await call('GET', '/api/admin/health?cert=1');
  console.log('cert:', h.cert);
  assert.equal(h.cert.domain, 'chat.test');
  assert.ok(h.cert.daysLeft >= 8 && h.cert.daysLeft <= 10, 'about 10 days left');
  const alert = h.alerts.find((a) => a.key === 'cert-expiry' && !a.resolved_at);
  assert.ok(alert, 'expiry alert raised');
  assert.match(alert.text, /روز دیگر منقضی/);
  // The owner also gets it as a message (saved messages).
  const chats = Object.values((await call('GET', '/api/chats')).chats);
  const saved = chats.find((c) => c.type === 'saved');
  const msgs = (await call('GET', `/api/chats/${saved.id}/messages`)).messages;
  assert.ok(msgs.some((m) => m.text.includes('گواهی HTTPS')), 'alert message for the owner');
  console.log('CERT ALERT TEST PASSED');
} finally {
  srv.kill();
  fake.close();
}
process.exit(0);
