// Share links as sellers write them, WireGuard files, and long pasted text staying fast.
// Usage: node server/test/uri.test.mjs
import assert from 'node:assert/strict';
import { normalizeProxyLink, outboundFromConfig } from '../src/tele/uri.js';

const cases = [
  ['socks5://203.0.113.1:1080@user:pass', 'socks5://user:pass@203.0.113.1:1080'],
  ['203.0.113.1:1080@user:pass#name', 'socks5://user:pass@203.0.113.1:1080#name'],
  ['proxy.example.com:1080@user', 'socks5://user@proxy.example.com:1080'],
  ['203.0.113.1:1080@us%40er:p%3Ass', 'socks5://us%40er:p%3Ass@203.0.113.1:1080'],
  ['socks5://user:pass@203.0.113.1:1080', 'socks5://user:pass@203.0.113.1:1080'],
  ['203.0.113.1:1080:user:pass', 'socks5://user:pass@203.0.113.1:1080'],
  ['http://u:p@proxy.example.com:8080', 'http://u:p@proxy.example.com:8080'],
];
for (const [link, want] of cases) assert.equal(normalizeProxyLink(link), want, link);
assert.throws(() => normalizeProxyLink('203.0.113.1:99999@user:pass'), /پورت/);

const wg = outboundFromConfig(
  `[Interface]
PrivateKey = aaaa # the key
Address = 10.0.0.2/32
MTU = 1300
__proto__ = x
Unknown = 1

[Peer]
PublicKey = bbbb
PresharedKey = cccc
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 30
`,
  'wireguard',
  'proxy-1',
);
assert.equal(wg.private_key, 'aaaa');
assert.equal(wg.mtu, 1300);
assert.deepEqual(wg.address, ['10.0.0.2/32']);
assert.deepEqual(wg.peers[0], { address: 'vpn.example.com', port: 51820, public_key: 'bbbb', pre_shared_key: 'cccc', allowed_ips: ['0.0.0.0/0'], persistent_keepalive_interval: 30 });
assert.equal({}.polluted, undefined);

// A JSON config with __proto__: an ordinary key, nothing changes on any object.
const out = outboundFromConfig('{"type":"socks","server":"203.0.113.1","server_port":1080,"__proto__":{"polluted":1}}', null, 'x');
assert.equal(out.server, '203.0.113.1');
assert.equal({}.polluted, undefined);
assert.equal(out.polluted, undefined);

const long = 'a:'.repeat(200000);
const t = Date.now();
normalizeProxyLink(`${long}@`);
normalizeProxyLink(`${'1'.repeat(400000)}:`);
try {
  outboundFromConfig(`[Interface]\n${' '.repeat(400000)}x\n${'k'.repeat(400000)}${' '.repeat(400000)}\n`, 'wireguard', 'x');
} catch {
  /* incomplete: refused, quickly */
}
assert.ok(Date.now() - t < 1000, `slow on long input: ${Date.now() - t} ms`);
console.log('uri: all checks passed');
