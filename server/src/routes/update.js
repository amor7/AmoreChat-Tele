/**
 * Updating the server from the admin panel (owner only), for servers without GitHub: the owner
 * uploads the release files; this says which ones this server still needs (from the release's
 * manifest and the images the server already has), checks the release signature and every file,
 * and then asks the server to install them.
 *
 * The app cannot run Docker itself: deploy/panel-update.sh does, as root on the server, started
 * by a systemd path unit (deploy/install-command.sh) when the app writes data/update/request.
 * It installs with deploy/update.sh, so the same checks apply as by hand (the signature is checked
 * again with the key of the version installed now).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from '../db.js';
import { fail, audit } from '../chats.js';

const U = path.join(DATA_DIR, 'update');
const IN = path.join(U, 'incoming');
const CHUNK = 8 * 1024 * 1024;
const BASE = ['amorechat-source.tar.gz', 'manifest.json', 'amorechat-app.tar.gz', 'SHA256SUMS', 'SHA256SUMS.sig'];
const NAME = /^(amorechat-source\.tar\.gz|amorechat-app\.tar\.gz|manifest\.json|SHA256SUMS|SHA256SUMS\.sig|amorechat-offline-amd64\.tar\.gz|amorechat-(runtime|deps)-[0-9a-f]{12}-amd64\.tar\.gz)$/;
const MAX_FILE = 1536 * 1024 * 1024;
const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(read(f));
  } catch {
    return null;
  }
};
const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// sha256 of uploaded files, kept while the file does not change.
const sums = new Map();
async function sha256(file) {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  if (sums.get(file)?.key === key) return sums.get(file).hash;
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  const hash = h.digest('hex');
  sums.set(file, { key, hash });
  return hash;
}

/** Asks the server-side helper for something; `inspect` writes host.json (the images on the server). */
function request(what) {
  fs.mkdirSync(U, { recursive: true });
  fs.writeFileSync(path.join(U, 'request'), `${what}\n`);
}
async function freshHost() {
  const f = path.join(U, 'host.json');
  const before = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
  if (Date.now() - before < 20000) return readJson(f);
  request('inspect');
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (fs.existsSync(f) && fs.statSync(f).mtimeMs > before) return readJson(f);
  }
  // No answer: the helper is not installed (yet), or the server is not a Linux with systemd.
  return before ? { ...readJson(f), stale: true } : null;
}

function uploaded() {
  fs.mkdirSync(IN, { recursive: true });
  return fs
    .readdirSync(IN)
    .filter((n) => NAME.test(n))
    .map((name) => ({ name, size: fs.statSync(path.join(IN, name)).size }));
}

/** What is uploaded, what is still needed, and whether it can be installed. */
async function analyze() {
  const host = await freshHost();
  const files = uploaded();
  const have = new Set(files.map((f) => f.name));
  const out = { installed: APP_VERSION, agent: !!host && !host.stale, files, needed: [], problems: [], target: null, ready: false };
  const manifest = have.has('manifest.json') ? readJson(path.join(IN, 'manifest.json')) : null;
  out.target = manifest?.version || null;
  const full = have.has('amorechat-offline-amd64.tar.gz');
  const need = new Set(full ? ['amorechat-source.tar.gz', 'SHA256SUMS', 'SHA256SUMS.sig'] : BASE);
  if (manifest && host?.images && !full) {
    // Newer Docker may list "docker.io/library/caddy:…" and other ids than a release built elsewhere.
    const bare = (ref) => String(ref).replace(/^docker\.io\//, '').replace(/^library\//, '');
    const images = host.images.map((s) => String(s).split(' '));
    const hasRef = (ref) => images.some(([r]) => bare(r) === bare(ref));
    const hasId = (id) => !!id && images.some(([, i]) => i === id);
    if (!hasRef(`amorechat-runtime:${manifest.runtime}`)) need.add(`amorechat-runtime-${manifest.runtime}-amd64.tar.gz`);
    // Same rule as deploy/update.sh: their versions are pinned, so the name and version are enough.
    const okImg = (ref, id) => hasRef(ref) || hasId(id);
    if (!okImg(manifest.caddy, manifest.caddyId) || !okImg(manifest.livekit, manifest.livekitId)) need.add(`amorechat-deps-${manifest.deps}-amd64.tar.gz`);
  }
  // Which of the uploaded files are right: SHA256SUMS signed with the release key, and each file in it.
  const list = read(path.join(IN, 'SHA256SUMS'));
  const sig = have.has('SHA256SUMS.sig') ? fs.readFileSync(path.join(IN, 'SHA256SUMS.sig')) : null;
  const pub = read(path.join(U, 'release-signing.pub'));
  let signed = null;
  if (list && sig && pub) {
    try {
      signed = crypto.verify(null, Buffer.from(list), pub, sig);
    } catch {
      signed = false;
    }
    if (!signed) out.problems.push('امضای SHA256SUMS درست نیست: این فایل‌ها از نسخه رسمی نیستند یا در راه عوض شده‌اند');
  }
  out.signed = signed;
  const listed = new Map(
    String(list || '')
      .split('\n')
      .map((l) => l.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/))
      .filter(Boolean)
      .map((m) => [m[2], m[1]]),
  );
  for (const f of files) {
    if (!listed.size || f.name === 'SHA256SUMS' || f.name === 'SHA256SUMS.sig') continue;
    if (!listed.has(f.name)) {
      f.state = 'extra';
      continue;
    }
    f.state = (await sha256(path.join(IN, f.name))) === listed.get(f.name) ? 'ok' : 'bad';
    if (f.state === 'bad') out.problems.push(`${f.name} با فهرست امضاشده یکی نیست (ناقص یا خراب؛ دوباره بفرستید)`);
  }
  if (listed.size) for (const n of need) if (!listed.has(n) && n !== 'SHA256SUMS' && n !== 'SHA256SUMS.sig') out.problems.push(`${n} در این نسخه نیست`);
  out.needed = [...need].map((name) => ({ name, have: have.has(name) }));
  if (manifest && !newer(manifest.version, APP_VERSION)) out.problems.push(`این نسخه (${manifest.version}) از نسخه نصب‌شده (${APP_VERSION}) جدیدتر نیست`);
  if (!host) out.problems.push('ابزار آپدیت روی سرور نصب نیست؛ یک بار با دستور sudo amorechat-update آپدیت کنید (بعد از آن از همین‌جا می‌شود)');
  else if (manifest && !host.images) out.problems.push('فهرست ایمیج‌های سرور خوانده نشد');
  out.ready = !!manifest && !!host && !host.stale && signed === true && !out.problems.length && out.needed.every((n) => n.have) && files.filter((f) => need.has(f.name)).every((f) => f.state === 'ok' || f.name.startsWith('SHA256SUMS'));
  const result = readJson(path.join(U, 'result.json'));
  out.result = result;
  out.log = (read(path.join(U, 'log.txt')) || '').slice(-6000);
  return out;
}

export default async function updateRoutes(app) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK + 1024 }, (_req, body, done) => done(null, body));
  const needOwner = (req) => {
    if (req.user?.role !== 'owner') fail(403, 'فقط مالک');
  };

  app.get('/api/admin/update', async (req) => {
    needOwner(req);
    return analyze();
  });

  // A piece of a file, at `offset` (an interrupted upload continues where it stopped).
  app.put('/api/admin/update/files/:name', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req) => {
    needOwner(req);
    const name = String(req.params.name);
    if (!NAME.test(name)) fail(400, 'این فایل جزو فایل‌های نسخه نیست');
    if (!Buffer.isBuffer(req.body)) fail(400, 'محتوا نامعتبر است');
    fs.mkdirSync(IN, { recursive: true });
    const offset = Number(req.query?.offset ?? 0);
    if (offset + req.body.length > MAX_FILE) fail(400, 'فایل بیش از حد بزرگ است');
    // One open file for the size check and the write, so they are about the same file.
    const file = await fs.promises.open(path.join(IN, name), 'a+', 0o600);
    try {
      const { size } = await file.stat();
      if (offset === 0 && size) await file.truncate(0);
      else if (offset !== size) return { name, size, resend: true };
      await file.appendFile(req.body);
    } finally {
      await file.close();
    }
    return { name, size: offset + req.body.length };
  });

  app.delete('/api/admin/update/files', async (req) => {
    needOwner(req);
    fs.rmSync(IN, { recursive: true, force: true });
    for (const f of ['result.json', 'log.txt']) fs.rmSync(path.join(U, f), { force: true });
    audit(req.user.id, 'update.clear', '');
    return analyze();
  });

  app.post('/api/admin/update/apply', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    needOwner(req);
    const a = await analyze();
    if (a.result?.state === 'running') fail(409, 'آپدیت در حال انجام است');
    if (!a.ready) fail(400, a.problems[0] || 'همه فایل‌های لازم فرستاده نشده‌اند');
    for (const f of ['result.json', 'log.txt']) fs.rmSync(path.join(U, f), { force: true });
    fs.writeFileSync(path.join(U, 'result.json'), JSON.stringify({ state: 'queued', at: Math.floor(Date.now() / 1000) }));
    request('apply');
    audit(req.user.id, 'update.apply', '', { from: APP_VERSION, to: a.target });
    return { ok: true, ...(await analyze()) };
  });
}
