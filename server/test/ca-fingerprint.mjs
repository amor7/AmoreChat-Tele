// Checks the pure-JS SHA-256 on the /ca page against Node's crypto.
// Usage: node test/ca-fingerprint.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import routes from '../src/routes/ca-help.js';

let html = '';
const reply = {
  type() {
    return this;
  },
  header() {
    return this;
  },
  send(x) {
    html = x;
  },
};
await routes({ get: (_path, _opts, handler) => handler(null, reply) });
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('fetch(')[0];
const sha256 = new Function(`${script}; return sha256;`)();
for (const n of [0, 3, 55, 56, 63, 64, 65, 1000, 4321]) {
  const bytes = crypto.randomBytes(n);
  const want = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase().match(/../g).join(':');
  assert.equal(sha256(new Uint8Array(bytes)), want, `length ${n}`);
}
assert.match(html, /\\s\+|\/\\s\+\//, 'PEM whitespace regex survives the template string');
console.log('CA FINGERPRINT TEST PASSED');
