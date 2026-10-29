import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { db, get, all, run, now, UPLOAD_DIR } from './db.js';
import { startSweeper } from './sweeper.js';
import { mediaReady, onMediaUpdate, resumePendingMedia } from './media.js';
import { toChat } from './realtime.js';
import { loadMessage } from './chats.js';
import { hasAnyUser } from './settings.js';
import { userFromToken, SESSION_COOKIE, randomCode } from './auth.js';
import { ensureEmergencyChannel } from './chats.js';
import { setupSocket } from './socket.js';
import { scheduleBackups } from './backup.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';
import fileRoutes from './routes/files.js';
import adminRoutes from './routes/admin.js';
import rtcRoutes from './routes/rtc.js';
import caHelpRoutes from './routes/ca-help.js';
import accountRoutes from './routes/account.js';
import backupRoutes from './routes/backup.js';
import appRoutes from './routes/app.js';
import folderRoutes from './routes/folders.js';
import teleRoutes from './routes/tele.js';
import { refreshEgress } from './tele/egress.js';
import { startVoiceSync } from './voice.js';
import { startHealth } from './health.js';
import { startCertCheck } from './certcheck.js';
import { setupRtcProxy } from './rtc-proxy.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(import.meta.dirname, '../../web/dist'));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  // Only Caddy (docker network) or a local proxy may set X-Forwarded-For; clients can't fake their IP.
  trustProxy: 'loopback, linklocal, uniquelocal',
  bodyLimit: 1024 * 1024,
});

await app.register(cookie);
await app.register(rateLimit, {
  global: false,
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    message: `تعداد درخواست‌ها زیاد است؛ ${Math.ceil(ctx.ttl / 1000)} ثانیه دیگر تلاش کنید`,
  }),
});
await app.register(multipart);
// Provides reply.sendFile() for uploads; nothing is served automatically.
await app.register(fastifyStatic, { root: UPLOAD_DIR, serve: false });

app.decorateRequest('user', null);

app.addHook('onRequest', async (req, reply) => {
  if (!req.url.startsWith('/api/')) return;
  // Custom header => browsers must preflight cross-site requests, which we never allow (CSRF guard).
  const csrfExempt = req.routeOptions.config?.noCsrf;
  if (!csrfExempt && req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'amorechat') {
    return reply.code(403).send({ error: 'درخواست نامعتبر' });
  }
  const user = userFromToken(req.cookies[SESSION_COOKIE]);
  if (user) {
    req.user = user;
    if (!user.last_seen || now() - user.last_seen > 60_000) run('UPDATE users SET last_seen = ? WHERE id = ?', now(), user.id);
    // Per-device activity for the "logged-in devices" list.
    if (user.session_id && (!user.session_last_seen || now() - user.session_last_seen > 60_000)) {
      run('UPDATE sessions SET last_seen = ?, ip = ? WHERE id = ?', now(), String(req.ip || '').slice(0, 64), user.session_id);
    }
  } else if (!req.routeOptions.config?.public) {
    return reply.code(401).send({ error: 'ابتدا وارد شوید' });
  }
});

app.addHook('onSend', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  // Browsers that saw the site over HTTPS refuse a downgraded plain-HTTP copy later.
  if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
  // A route may set its own (stricter or page-specific) policy.
  if (reply.getHeader('Content-Security-Policy')) return;
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss: https://amore-share.invalid; " +
      "style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'",
  );
});

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode || 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: code >= 500 ? 'خطای داخلی سرور' : err.message });
});

await app.register(authRoutes);
await app.register(accountRoutes);
await app.register(chatRoutes);
await app.register(messageRoutes);
await app.register(fileRoutes);
await app.register(adminRoutes);
await app.register(teleRoutes);
// Bring the Telegram tunnel back after a restart or update (not only on the next login).
refreshEgress();
await app.register(backupRoutes);
await app.register(appRoutes);
await app.register(folderRoutes);
// LiveKit posts webhooks as application/webhook+json; keep the raw text to verify its signature.
app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
await app.register(rtcRoutes);
await app.register(caHelpRoutes);
setupRtcProxy(app);

app.get('/healthz', async () => ({ ok: true }));

const hasWeb = fs.existsSync(path.join(WEB_DIR, 'index.html'));
if (hasWeb) {
  await app.register(fastifyStatic, {
    root: WEB_DIR,
    decorateReply: false,
    setHeaders: (reply, filePath) => {
      // Hashed build assets never change; the shell and service worker must always revalidate.
      const immutable = /[\\/]assets[\\/]/.test(filePath);
      reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

app.setNotFoundHandler((req, reply) => {
  if (req.method === 'GET' && hasWeb && !req.url.startsWith('/api/') && !req.url.startsWith('/socket.io') && !req.url.startsWith('/rtc')) {
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html', WEB_DIR);
  }
  reply.code(404).send({ error: 'پیدا نشد' });
});

// --- First boot ---
ensureEmergencyChannel();
if (!hasAnyUser()) {
  let inv = get("SELECT code FROM invites WHERE note = 'setup' AND uses = 0");
  if (!inv) {
    inv = { code: randomCode(9) };
    run("INSERT INTO invites (code, max_uses, note, created_at) VALUES (?, 1, 'setup', ?)", inv.code, now());
  }
  const line = '='.repeat(60);
  console.log(`\n${line}\n  SETUP CODE: ${inv.code}\n  Register the first account with this code; it becomes the owner.\n${line}\n`);
}

setupSocket(app);
await app.listen({ port: PORT, host: HOST });
scheduleBackups(app.log);
startSweeper(app.log);
startVoiceSync(app.log);
startHealth(app.log);
startCertCheck(app.log);
// When a video finishes processing, refresh every message that shows it.
onMediaUpdate((fileId) => {
  for (const m of all('SELECT id, chat_id FROM messages WHERE file_id = ? AND deleted = 0', fileId)) {
    toChat(m.chat_id, 'message:edit', loadMessage(m.id));
  }
});
resumePendingMedia();
mediaReady.then((ok) => !ok && app.log.warn('ffmpeg not found: voice/video conversion disabled'));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
