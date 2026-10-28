import crypto from 'node:crypto';

// ---------- TOTP (RFC 6238): works with Google Authenticator, Aegis, 2FAS, Microsoft Authenticator ----------
// Needs no internet: the phone app and the server only share a secret and the clock.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
const STEP = 30;
export const currentStep = () => Math.floor(Date.now() / 1000 / STEP);

export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Accepts the previous, current and next 30s window (clock drift); never the same step twice.
export function checkTotp(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentStep();
  for (const step of [now - 1, now, now + 1]) {
    if (step > lastStep && crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

export const otpauthUri = (account, secret, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- Recovery codes (one-time, stored hashed) ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalize = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(6)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map((c) => sha256(normalize(c))) };
}

// Returns the remaining hashes if `code` matched one, else null.
export function useRecoveryCode(hashes, code) {
  const h = sha256(normalize(code));
  if (!normalize(code) || !hashes.includes(h)) return null;
  return hashes.filter((x) => x !== h);
}

// ---------- Password policy ----------
const COMMON = new Set(
  `12345678 123456789 1234567890 12341234 11111111 00000000 87654321 password password1 password123 qwertyui
   qwerty123 qwertyuiop 1q2w3e4r 1q2w3e4r5t zaq12wsx abcd1234 abc12345 iloveyou sunshine princess football
   admin123 administrator welcome1 letmein1 passw0rd p@ssw0rd 123123123 112233445566 147258369 123qweasd
   asdfghjkl 1qaz2wsx 5201314520 66666666 88888888 99999999 12121212 123654789 987654321 iran1234 tehran123
   mohammad ali12345 09123456789 0912345678 changeme amorechat`.split(/\s+/),
);

export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 8) return 'رمز عبور باید حداقل ۸ کاراکتر باشد';
  if (password.length > 200) return 'رمز عبور خیلی طولانی است';
  const p = password.toLowerCase();
  if (COMMON.has(p)) return 'این رمز خیلی رایج است و به‌راحتی حدس زده می‌شود';
  if (username && p.includes(String(username).toLowerCase())) return 'رمز عبور نباید شامل نام کاربری باشد';
  if (/^(.)\1+$/.test(p)) return 'رمز عبور نباید فقط یک حرف تکراری باشد';
  return null;
}

// ---------- Readable device names for the session list ----------
export function deviceName(ua = '') {
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : '';
  return [browser, os].filter(Boolean).join(' · ') || 'دستگاه ناشناس';
}
