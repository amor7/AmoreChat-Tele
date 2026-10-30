import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, getRoutePolicy, setRoutePolicy, publicProxy, PROTOCOL_HINTS, ROUTE_MODES } from '../tele/proxies.js';
import { probeViaEgress, probeAll, egressStatus, ensureEgress, stopEgress, refreshEgress, liveTunnelError } from '../tele/egress.js';
import { splitConfigs, outboundFromForm } from '../tele/uri.js';
import { ovpnConfig, looksLikeOvpn } from '../tele/ovpn.js';
import { beginLogin, submitCode, submitPassword, disconnectAccount, getAccountForUser, publicAccount, listDialogs, setDialogSelected, teleRuntimeInfo, clearStaleLogin, isLive, trafficOf, usageOf, quotaOf, listTeleSessions, endTeleSession, endOtherTeleSessions, resendCode, loginCodeInfo, teleAllowed, assertTeleAllowed, enforceTeleAccess, exploreAllowed, usageHistory } from '../tele/accounts.js';
import { ACCESS_MODES, ACCESS_LISTS, accessMode, accessAllowed } from '../access.js';
import { findTelegram, openTelegramChat, joinTelegramChat, leaveTelegramChat } from '../tele/explore.js';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { get, all, run, now, UPLOAD_DIR } from '../db.js';
import { settingNumber, setSetting } from '../settings.js';
import { syncDialogMessages, sendTeleMessage, sendTelePhoto, sendTeleVoice, sendTeleFile, telePhotoFile, teleVoiceFile, teleFileFile, ownTeleMessage, newUploadFile, fileMaxBytes, cancelQueued, newUploadPath, mediaMaxBytes, refreshDialogsFromTelegram, listStoredMessages, publicMessages, searchDialogMessages } from '../tele/messages.js';
import { getAlertSettings, setAlertSettings, teleAlert, ALERT_KINDS } from '../tele/alerts.js';
import { getMember, postMessage } from '../chats.js';
import { requireChat } from './chats.js';
import { assertCanPost } from './messages.js';
import { registerFile, newRel } from './files.js';
import { ownerAccount, listMirrors, createMirror, runMirrors, telegramChannels, setVisibility, renewInvite, loadMirrorMedia, VISIBILITY } from '../tele/mirror.js';

const loginLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
// Each of these costs the server's VPN traffic (and too many sends get a Telegram account limited).
const limit = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

const needTeleAdmin = (req) => {
  if (!hasSitePerm(req.user, 'manage_settings') && req.user.role !== 'owner') fail(403, 'دسترسی ندارید');
};

export default async function teleRoutes(app) {
  // Users the admin closed Telegram for: only the status (which says so) and logging out.
  app.addHook('preHandler', async (req) => {
    if (!req.user || !req.url.startsWith('/api/tele/') || /^\/api\/tele\/(status|disconnect)(\?|$)/.test(req.url)) return;
    assertTeleAllowed(req.user);
  });
  app.get('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    return { policy: getRoutePolicy(), modes: ROUTE_MODES, protocols: PROTOCOL_HINTS, egress: egressStatus(), runtime: teleRuntimeInfo() };
  });
  app.patch('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    const policy = setRoutePolicy(req.body || {});
    // A new DNS server is part of the tunnel's config: start it again with it.
    if (req.body?.dns !== undefined) await stopEgress();
    const egress = await refreshEgress();
    audit(req.user.id, 'tele.policy', '', policy);
    return { policy, egress };
  });
  app.get('/api/admin/tele/proxies', async (req) => {
    needTeleAdmin(req);
    return { proxies: listProxies(), policy: getRoutePolicy(), egress: { ...egressStatus(), tunnelError: liveTunnelError() } };
  });
  app.post('/api/admin/tele/proxies', async (req) => {
    needTeleAdmin(req);
    const b = req.body || {};
    // The manual form: fields → a checked sing-box outbound, stored as JSON.
    if (b.form && typeof b.form === 'object') {
      const out = outboundFromForm(b.form);
      const protocol = { socks5: 'socks5', socks4: 'socks4', socks4a: 'socks4', shadowsocks: 'ss' }[b.form.type] || b.form.type;
      const name = String(b.name || '').trim() || `${b.form.type} ${out.server || out.peers?.[0]?.address}:${out.server_port || out.peers?.[0]?.port}`;
      const proxy = createProxy({ name, config: JSON.stringify(out), protocol, priority: b.priority, enabled: b.enabled !== false });
      audit(req.user.id, 'tele.proxy.create', proxy.id, { form: b.form.type });
      return { proxies: [proxy], proxy, errors: [] };
    }
    // OpenVPN: a .ovpn file (and its login, if it asks for one), run by the ovpn service.
    const ovpn = b.openvpn && typeof b.openvpn === 'object' ? b.openvpn : looksLikeOvpn(b.links) ? { ovpn: b.links } : null;
    if (ovpn) {
      const config = ovpnConfig(ovpn);
      const remote = JSON.parse(config).ovpn.match(/^remote\s+(\S+)/m)?.[1] || '';
      const proxy = createProxy({ name: String(b.name || '').trim() || `OpenVPN ${remote}`.trim(), config, protocol: 'openvpn', priority: b.priority, enabled: b.enabled !== false });
      audit(req.user.id, 'tele.proxy.create', proxy.id, { form: 'openvpn' });
      return { proxies: [proxy], proxy, errors: [] };
    }
    // Several configs at once: share links one per line, WireGuard .conf / JSON kept whole.
    const configs = typeof b.links === 'string' && b.links.trim() ? splitConfigs(b.links) : [b.config || b.link || b.url];
    if (!configs.length || !configs[0]) fail(400, 'کانفیگی پیدا نشد');
    const created = [];
    const errors = [];
    configs.slice(0, 50).forEach((config, i) => {
      try {
        const name = configs.length > 1 && b.name ? `${b.name} ${i + 1}` : b.name;
        created.push(createProxy({ name, config, protocol: b.protocol, priority: b.priority, groupName: b.groupName, enabled: b.enabled !== false }));
      } catch (e) {
        errors.push(`${i + 1}: ${e.message}`);
      }
    });
    audit(req.user.id, 'tele.proxy.create', '', { count: created.length, failed: errors.length });
    if (!created.length) fail(400, errors.join(' · ') || 'کانفیگ نامعتبر است');
    return { proxies: created, proxy: created[0], errors };
  });
  app.patch('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    const proxy = updateProxy(req.params.id, req.body || {});
    audit(req.user.id, 'tele.proxy.update', req.params.id, { enabled: proxy.enabled, priority: proxy.priority, configChanged: req.body?.config != null });
    // The running tunnel uses this proxy's old settings: start it again with the new ones.
    if (egressStatus().proxyId === Number(req.params.id)) await stopEgress();
    return { proxy, egress: await refreshEgress() };
  });
  app.delete('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    if (egressStatus().proxyId === Number(req.params.id)) await stopEgress();
    deleteProxy(req.params.id);
    audit(req.user.id, 'tele.proxy.delete', req.params.id);
    return { ok: true, egress: await refreshEgress() };
  });
  app.post('/api/admin/tele/proxies/:id/probe', async (req) => {
    needTeleAdmin(req);
    const proxy = await probeViaEgress(Number(req.params.id));
    // A proxy that just turned healthy may be the one the policy picks: start the tunnel now.
    return { proxy, egress: await refreshEgress() };
  });
  // Test every enabled proxy now (as the scheduled check does) and switch to the best one.
  app.post('/api/admin/tele/proxies/probe-all', async (req) => {
    needTeleAdmin(req);
    const egress = await probeAll();
    return { proxies: listProxies(), egress };
  });
  app.post('/api/admin/tele/egress/restart', async (req) => {
    needTeleAdmin(req);
    await stopEgress();
    const ep = await ensureEgress();
    return { egress: egressStatus(), endpoint: ep };
  });
  app.get('/api/tele/status', async (req) => {
    if (!teleAllowed(req.user)) return { access: false, account: null, dialogs: [], runtime: { apiConfigured: false, tdlAvailable: false, egress: { running: false } } };
    const account = clearStaleLogin(getAccountForUser(req.user.id));
    // Users see whether the tunnel runs, not its proxy server or errors (those name the VPN server).
    const runtime = teleRuntimeInfo();
    const admin = hasSitePerm(req.user, 'manage_settings') || req.user.role === 'owner';
    if (!admin) runtime.egress = { running: runtime.egress.running, lastError: runtime.egress.running ? null : 'تونل تلگرام در دسترس نیست؛ به مدیر خبر دهید' };
    // live: whether the TDLib connection is open right now (it closes when idle); traffic: what it moved since opening.
    const traffic = account ? await trafficOf(account.id) : null;
    const usage = account ? { used: usageOf(account.id).used, quotaMb: quotaOf(account) } : null;
    const codeInfo = account?.status === 'awaiting_code' ? loginCodeInfo(account.id) : null;
    return { access: true, account: publicAccount(account), codeInfo, mediaMaxMb: settingNumber('tele_media_max_mb') || 5, fileMaxMb: settingNumber('tele_file_max_mb') || 20, runtime, live: account ? isLive(account.id) : false, traffic, usage, dialogs: account ? listDialogs(account.id) : [] };
  });
  // Telegram limits attempts itself; this keeps one user from hammering the login through the VPN.
  app.post('/api/tele/login/phone', loginLimit, async (req) => beginLogin(req.user.id, req.body?.phone));
  // The code did not come (no internet for the Telegram app): ask for it by SMS or a call.
  app.post('/api/tele/login/resend', limit(5), async (req) => resendCode(req.user.id));
  app.post('/api/tele/login/code', loginLimit, async (req) => submitCode(req.user.id, req.body?.code));
  app.post('/api/tele/login/password', loginLimit, async (req) => submitPassword(req.user.id, req.body?.password));
  // The account's other logins (phones, desktops…): see them and end the ones you don't know.
  app.get('/api/tele/sessions', limit(20), async (req) => ({ sessions: await listTeleSessions(req.user.id) }));
  app.delete('/api/tele/sessions/:id', limit(10), async (req) => ({ sessions: await endTeleSession(req.user.id, req.params.id) }));
  app.post('/api/tele/sessions/end-others', limit(5), async (req) => ({ sessions: await endOtherTeleSessions(req.user.id) }));
  app.post('/api/tele/disconnect', async (req) => { await disconnectAccount(req.user.id); return { ok: true }; });
  app.patch('/api/tele/dialogs/:id', async (req) => {
    const account = getAccountForUser(req.user.id);
    if (!account) fail(400, 'حساب وصل نیست');
    return { dialogs: setDialogSelected(account.id, req.params.id, req.body?.selected !== false) };
  });
  app.post('/api/tele/dialogs/refresh', limit(12), async (req) => refreshDialogsFromTelegram(req.user.id, { all: !!req.body?.all }));
  app.get('/api/tele/dialogs/:id/messages', async (req) => {
    const account = getAccountForUser(req.user.id);
    if (!account) fail(400, 'حساب وصل نیست');
    const before = Number(req.query?.before) || null;
    try {
      return await syncDialogMessages(req.user.id, req.params.id, { limit: Number(req.query?.limit) || 40, before, local: req.query?.local === '1' });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 400) throw e;
      // Telegram unreachable (tunnel down, TDLib error): show what is stored, with the reason.
      req.log.warn(e);
      return { messages: publicMessages(listStoredMessages(account.id, Number(req.params.id), { beforeTgId: before })), notice: e.message };
    }
  });
  // ---------- Beyond the user's own chats (only for accounts an admin allowed) ----------
  app.get('/api/tele/find', limit(20), async (req) => findTelegram(req.user.id, req.query?.q));
  app.post('/api/tele/open', limit(20), async (req) => openTelegramChat(req.user.id, req.body?.tgChatId));
  app.post('/api/tele/join', limit(10), async (req) => joinTelegramChat(req.user.id, { tgChatId: req.body?.tgChatId, invite: req.body?.invite }));
  app.post('/api/tele/dialogs/:id/leave', limit(10), async (req) => leaveTelegramChat(req.user.id, req.params.id));
  app.get('/api/tele/dialogs/:id/search', limit(20), async (req) => searchDialogMessages(req.user.id, req.params.id, req.query?.q));
  app.post('/api/tele/dialogs/:id/messages', limit(30), async (req) => {
    return { message: await sendTeleMessage(req.user.id, req.params.id, req.body?.text, Number(req.body?.replyTo) || null) };
  });

  // One uploaded file (photo or voice) into a temporary file, within the size limit.
  async function receiveUpload(req, { kind, ext }) {
    const part = await req.file({ limits: { fileSize: mediaMaxBytes(), files: 1 } });
    if (!part) fail(400, kind === 'image' ? 'عکسی ارسال نشده' : 'صدایی ارسال نشده');
    const okType = kind === 'image' ? /^image\//.test(part.mimetype || '') : /^(audio|video)\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav)/.test(part.mimetype || '');
    if (!okType) {
      part.file.resume();
      fail(400, kind === 'image' ? 'فقط عکس قابل ارسال است' : 'فقط صدا قابل ارسال است');
    }
    const file = newUploadPath(ext);
    try {
      await pipeline(part.file, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(file, { force: true });
      fail(413, `حداکثر حجم فایل ${settingNumber('tele_media_max_mb') || 5} مگابایت است`);
    }
    return file;
  }

  // ---------- Photos (only for accounts an admin allowed) ----------
  app.post('/api/tele/dialogs/:id/photo', limit(10), async (req, reply) => {
    const account = getAccountForUser(req.user.id);
    if (!account?.allow_media) fail(403, 'دسترسی به عکس‌های تلگرام برای شما فعال نیست');
    const file = await receiveUpload(req, { kind: 'image', ext: '.jpg' });
    reply.code(201);
    return { message: await sendTelePhoto(req.user.id, req.params.id, file, { caption: req.query?.caption, replyTo: Number(req.query?.replyTo) || null }) };
  });
  app.get('/api/tele/messages/:id/photo', limit(60), async (req, reply) => {
    const file = await telePhotoFile(req.user.id, req.params.id);
    reply.header('cache-control', 'private, max-age=86400');
    reply.type(/\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(file));
  });

  // ---------- Voice messages (only for accounts an admin allowed) ----------
  app.get('/api/tele/messages/:id/voice', limit(60), async (req, reply) => {
    const { file, type } = await teleVoiceFile(req.user.id, req.params.id);
    reply.header('cache-control', 'private, max-age=86400');
    reply.type(type);
    return reply.send(fs.createReadStream(file));
  });
  app.post('/api/tele/dialogs/:id/voice', limit(10), async (req, reply) => {
    const account = getAccountForUser(req.user.id);
    if (!account?.allow_voice) fail(403, 'دسترسی به پیام صوتی تلگرام برای شما فعال نیست');
    const file = await receiveUpload(req, { kind: 'audio', ext: '.rec' });
    reply.code(201);
    return { message: await sendTeleVoice(req.user.id, req.params.id, file, { duration: req.query?.duration, caption: req.query?.caption, replyTo: Number(req.query?.replyTo) || null }) };
  });

  // ---------- Files and videos (only for accounts an admin allowed) ----------
  app.get('/api/tele/messages/:id/file', limit(30), async (req, reply) => {
    const f = await teleFileFile(req.user.id, req.params.id);
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('x-content-type-options', 'nosniff');
    // Only a video is shown in the page (to play it); anything else is a download, never run here.
    if (req.query?.inline === '1' && f.video && /^video\/(mp4|webm)$/.test(f.mime)) {
      reply.type(f.mime);
    } else {
      reply.type('application/octet-stream');
      reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
    }
    return reply.send(fs.createReadStream(f.file));
  });
  app.post('/api/tele/dialogs/:id/file', limit(10), async (req, reply) => {
    const account = getAccountForUser(req.user.id);
    if (!account?.allow_files) fail(403, 'دسترسی به فایل‌های تلگرام برای شما فعال نیست');
    const part = await req.file({ limits: { fileSize: fileMaxBytes(), files: 1 } });
    if (!part) fail(400, 'فایلی ارسال نشده');
    const file = newUploadFile(part.filename);
    try {
      await pipeline(part.file, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
      fail(413, `حداکثر حجم فایل ${settingNumber('tele_file_max_mb') || 20} مگابایت است`);
    }
    reply.code(201);
    return { message: await sendTeleFile(req.user.id, req.params.id, file, { mime: part.mimetype, caption: req.query?.caption, replyTo: Number(req.query?.replyTo) || null }) };
  });
  // A message still waiting for the tunnel can be taken back.
  app.delete('/api/tele/messages/:id', limit(30), async (req) => cancelQueued(req.user.id, req.params.id));

  // ---------- Forwarding between Telegram and the app's own chats ----------
  // Telegram → app chats: the text, and the photo / voice when this user may load them.
  app.post('/api/tele/messages/:id/forward', limit(20), async (req) => {
    const { account, row, dialog, media } = ownTeleMessage(req.user.id, req.params.id);
    const ids = Array.isArray(req.body?.chatIds) ? [...new Set(req.body.chatIds.map(Number))].slice(0, 20) : [];
    if (!ids.length) fail(400, 'گفتگویی انتخاب نشده');
    const targets = [];
    for (const chatId of ids) {
      const member = getMember(chatId, req.user.id);
      const chat = get('SELECT * FROM chats WHERE id = ?', chatId);
      if (!chat || !member) continue;
      try {
        assertCanPost(req.user, chat, member);
      } catch {
        continue;
      }
      targets.push(chat);
    }
    if (!targets.length) fail(400, 'به هیچ‌کدام از گفتگوهای انتخاب‌شده نمی‌توانید پیام بفرستید');
    let type = 'text';
    let fileId = null;
    let text = row.text;
    const attach = async (src, { mime, name, kind, q }) => {
      const rel = newRel() + path.extname(src);
      fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, rel)), { recursive: true });
      fs.copyFileSync(src, path.join(UPLOAD_DIR, rel));
      fileId = (await registerFile(req.user, { rel, mime, name, q })).id;
      type = kind;
    };
    if (media?.type === 'photo' && account.allow_media) {
      const src = await telePhotoFile(req.user.id, row.id);
      await attach(src, { mime: /\.png$/i.test(src) ? 'image/png' : /\.webp$/i.test(src) ? 'image/webp' : 'image/jpeg', name: 'telegram-photo.jpg', kind: 'image', q: { w: media.w, h: media.h } });
      text = text.replace(/^📷 عکس\n?/, '');
    } else if (media?.type === 'voice' && account.allow_voice) {
      const v = await teleVoiceFile(req.user.id, row.id);
      await attach(v.file, { mime: v.type, name: 'telegram-voice.m4a', kind: 'voice', q: { dur: media.duration } });
      text = text.replace(/^🎤 پیام صوتی\n?/, '');
    } else if (media?.type === 'file' && account.allow_files) {
      const v = await teleFileFile(req.user.id, row.id);
      const mime = v.mime || 'application/octet-stream';
      await attach(v.file, { mime, name: v.name, kind: mime.startsWith('video/') ? 'video' : 'file', q: { w: media.w, h: media.h, dur: media.duration } });
      // Only the caption: the file itself shows what it is.
      text = text.replace(/^(📎|🎬|🎵|GIF)[^\n]*\n?/, '');
    }
    const who = row.direction === 'out' ? '' : row.sender_name && row.sender_name !== dialog.title ? ` · ${row.sender_name}` : '';
    const from = `تلگرام · ${dialog.title || 'گفتگو'}${who}`.slice(0, 120);
    const sent = [];
    for (const chat of targets) {
      postMessage({ chatId: chat.id, senderId: req.user.id, type, text: String(text || '').slice(0, 4000), fileId, forwardedFrom: from });
      sent.push(chat.id);
    }
    return { sent };
  });

  // App chat → Telegram: the text, and an image / voice message when this user may send them.
  app.post('/api/tele/forward', limit(20), async (req) => {
    const m = get('SELECT * FROM messages WHERE id = ?', Number(req.body?.messageId));
    if (!m || m.deleted) fail(404, 'پیام پیدا نشد');
    requireChat(req, m.chat_id);
    if (m.type === 'system' || m.type === 'call') fail(400, 'این پیام قابل ارسال به تلگرام نیست');
    const account = getAccountForUser(req.user.id);
    if (!account || account.status !== 'connected') fail(400, 'حساب تلگرام شما وصل نیست');
    const ids = Array.isArray(req.body?.dialogIds) ? [...new Set(req.body.dialogIds.map(Number))].slice(0, 10) : [];
    const dialogs = ids.map((id) => get('SELECT * FROM tele_dialogs WHERE id = ? AND account_id = ?', id, account.id)).filter(Boolean);
    if (!dialogs.length) fail(400, 'گفتگوی تلگرامی انتخاب نشده');
    const f = m.file_id ? get('SELECT * FROM files WHERE id = ?', m.file_id) : null;
    const src = f ? path.join(UPLOAD_DIR, f.path) : null;
    const fits = f && f.size <= mediaMaxBytes() && fs.existsSync(src);
    const asPhoto = fits && f.kind === 'image' && account.allow_media;
    const asVoice = fits && f.kind === 'audio' && m.type === 'voice' && account.allow_voice;
    const asFile = !asPhoto && !asVoice && f && account.allow_files && f.size <= fileMaxBytes() && fs.existsSync(src);
    // Anything else that can't go as media is named in the text instead.
    let text = String(m.text || '').trim();
    if (f && !asPhoto && !asVoice && !asFile) text = [text, `📎 ${f.name}`].filter(Boolean).join('\n');
    if (!text && !asPhoto && !asVoice && !asFile) fail(400, 'این پیام چیزی برای ارسال ندارد');
    const sent = [];
    for (const d of dialogs) {
      if (asFile) {
        const tmp = newUploadFile(f.name);
        fs.copyFileSync(src, tmp);
        await sendTeleFile(req.user.id, d.id, tmp, { mime: f.mime, caption: text });
      } else if (asPhoto || asVoice) {
        const tmp = newUploadPath(asPhoto ? '.jpg' : path.extname(src) || '.rec');
        fs.copyFileSync(src, tmp);
        if (asPhoto) await sendTelePhoto(req.user.id, d.id, tmp, { caption: text });
        else await sendTeleVoice(req.user.id, d.id, tmp, { duration: f.duration, caption: text });
      } else {
        await sendTeleMessage(req.user.id, d.id, text);
      }
      sent.push(d.id);
    }
    return { sent };
  });

  // ---------- Admin: users, their permissions, traffic and caps ----------
  app.get('/api/admin/tele/accounts', async (req) => {
    needTeleAdmin(req);
    const month = new Date().toISOString().slice(0, 7);
    // Highest traffic first: who uses the VPN the most this month.
    const accounts = all(
      `SELECT a.*, a.display_name AS tg_name, u.display_name AS name, u.username, u.role, IFNULL(t.sent, 0) + IFNULL(t.received, 0) AS used
       FROM tele_accounts a JOIN users u ON u.id = a.user_id LEFT JOIN tele_usage t ON t.account_id = a.id AND t.month = ?
       ORDER BY used DESC, u.display_name`,
      month,
    ).map((a) => ({
      id: a.id, userId: a.user_id, name: a.name, username: a.username, tgName: a.tg_name, status: a.status, live: isLive(a.id),
      allowMedia: !!a.allow_media, allowVoice: !!a.allow_voice, allowFiles: !!a.allow_files, allowExplore: exploreAllowed(a), owner: a.role === 'owner', used: a.used, quotaMb: a.quota_mb, effectiveQuotaMb: quotaOf(a),
    }));
    return { accounts, month, mediaMaxMb: settingNumber('tele_media_max_mb') || 5, fileMaxMb: settingNumber('tele_file_max_mb') || 20, defaultQuotaMb: settingNumber('tele_quota_mb') };
  });
  app.patch('/api/admin/tele/accounts/:id', async (req) => {
    needTeleAdmin(req);
    const id = Number(req.params.id);
    if (!get('SELECT id FROM tele_accounts WHERE id = ?', id)) fail(404, 'حساب پیدا نشد');
    const b = req.body || {};
    if (b.allowMedia != null) run('UPDATE tele_accounts SET allow_media = ?, updated_at = ? WHERE id = ?', b.allowMedia ? 1 : 0, now(), id);
    if (b.allowVoice != null) run('UPDATE tele_accounts SET allow_voice = ?, updated_at = ? WHERE id = ?', b.allowVoice ? 1 : 0, now(), id);
    if (b.allowFiles != null) run('UPDATE tele_accounts SET allow_files = ?, updated_at = ? WHERE id = ?', b.allowFiles ? 1 : 0, now(), id);
    if (b.allowExplore != null) run('UPDATE tele_accounts SET allow_explore = ?, updated_at = ? WHERE id = ?', b.allowExplore ? 1 : 0, now(), id);
    if (b.quotaMb !== undefined) {
      // null / '' = the default cap; 0 = no cap for this user; otherwise MB per month.
      const q = b.quotaMb === null || b.quotaMb === '' ? null : Number(b.quotaMb);
      if (q !== null && !(Number.isInteger(q) && q >= 0 && q <= 1000000)) fail(400, 'سقف مصرف باید عدد صحیح مگابایت باشد');
      // A new cap also allows a new alert this month.
      run("UPDATE tele_accounts SET quota_mb = ?, quota_alerted = '', updated_at = ? WHERE id = ?", q, now(), id);
    }
    audit(req.user.id, 'tele.account', id, { allowMedia: b.allowMedia, allowVoice: b.allowVoice, allowFiles: b.allowFiles, allowExplore: b.allowExplore, quotaMb: b.quotaMb });
    return { ok: true };
  });
  // Traffic of one account per day (30 days) and per month (6 months).
  app.get('/api/admin/tele/accounts/:id/usage', async (req) => {
    needTeleAdmin(req);
    const a = get('SELECT * FROM tele_accounts WHERE id = ?', Number(req.params.id));
    if (!a) fail(404, 'حساب پیدا نشد');
    return { ...usageHistory(a.id), quotaMb: quotaOf(a), used: usageOf(a.id).used };
  });
  // Per-user features: everyone, nobody, only the listed users, or everyone but them.
  // tele: the Telegram part; mirror_files: fetching videos / files of mirrored channels.
  const accessView = (list) => {
    const { table } = ACCESS_LISTS[list];
    return {
      mode: accessMode(list),
      modes: ACCESS_MODES,
      users: all(
        `SELECT u.id, u.display_name AS name, u.username, u.role, (x.user_id IS NOT NULL) AS listed, a.status AS teleStatus
         FROM users u LEFT JOIN ${table} x ON x.user_id = u.id LEFT JOIN tele_accounts a ON a.user_id = u.id
         WHERE u.banned = 0 ORDER BY listed DESC, u.display_name LIMIT 5000`,
      ).map((u) => ({ id: u.id, name: u.name, username: u.username, teleStatus: u.teleStatus, listed: !!u.listed, owner: u.role === 'owner', allowed: accessAllowed(list, u) })),
    };
  };
  // /api/admin/tele/access is the v1.0.15 address of the Telegram list.
  const accessList = (req) => {
    const name = req.params.list || 'tele';
    const list = name === 'mirror-files' ? 'mirror_files' : name === 'tele' ? 'tele' : null;
    if (!list) fail(404, 'پیدا نشد');
    return list;
  };
  const getAccess = async (req) => {
    needTeleAdmin(req);
    return accessView(accessList(req));
  };
  app.get('/api/admin/access/:list', getAccess);
  app.get('/api/admin/tele/access', getAccess);
  const patchAccess = async (req) => {
    needTeleAdmin(req);
    const list = accessList(req);
    const { setting, table } = ACCESS_LISTS[list];
    const b = req.body || {};
    if (b.mode != null) {
      if (!ACCESS_MODES.includes(b.mode)) fail(400, 'حالت نامعتبر است');
      setSetting(setting, b.mode);
    }
    const ids = (x) => (Array.isArray(x) ? x.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000) : []);
    for (const id of ids(b.add)) run(`INSERT OR IGNORE INTO ${table} (user_id, by, at) SELECT id, ?, ? FROM users WHERE id = ?`, req.user.id, now(), id);
    for (const id of ids(b.remove)) run(`DELETE FROM ${table} WHERE user_id = ?`, id);
    // Telegram closed for someone with it open: it closes now (their session is kept for later).
    if (list === 'tele') await enforceTeleAccess();
    audit(req.user.id, list === 'tele' ? 'tele.access' : 'mirror.files.access', '', { mode: b.mode, add: ids(b.add), remove: ids(b.remove) });
    return accessView(list);
  };
  app.patch('/api/admin/access/:list', patchAccess);
  app.patch('/api/admin/tele/access', patchAccess);
  app.patch('/api/admin/tele/quota', async (req) => {
    needTeleAdmin(req);
    const mb = Number(req.body?.defaultMb);
    if (!(Number.isInteger(mb) && mb >= 0 && mb <= 1000000)) fail(400, 'سقف مصرف باید عدد صحیح مگابایت باشد (۰ = بدون سقف)');
    setSetting('tele_quota_mb', mb);
    run("UPDATE tele_accounts SET quota_alerted = ''");
    audit(req.user.id, 'tele.quota', '', { mb });
    return { defaultQuotaMb: mb };
  });

  // ---------- Owner: Telegram channels mirrored into the app's channels ----------
  const needOwner = (req) => {
    if (req.user.role !== 'owner') fail(403, 'فقط مالک');
  };
  app.get('/api/admin/tele/mirrors', async (req) => {
    needOwner(req);
    const account = get("SELECT * FROM tele_accounts WHERE user_id = ? AND status = 'connected'", req.user.id);
    if (!account) return { connected: false, mirrors: [], appChannels: [], minutes: settingNumber('tele_mirror_minutes') || 5 };
    // The owner's own app channels (the Telegram ones come live from /mirrors/channels).
    const appChannels = all("SELECT c.id, c.title FROM chats c JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ? AND cm.role = 'owner' WHERE c.type = 'channel' ORDER BY c.title", req.user.id);
    return { connected: true, mirrors: listMirrors(account.id), appChannels, minutes: settingNumber('tele_mirror_minutes') || 5 };
  });
  // All the owner's Telegram channels, live from Telegram; `q` filters, "@name" / a t.me link finds a public one.
  app.get('/api/admin/tele/mirrors/channels', limit(20), async (req) => {
    needOwner(req);
    return { channels: await telegramChannels(req.user, req.query?.q) };
  });
  app.post('/api/admin/tele/mirrors', limit(10), async (req) => {
    needOwner(req);
    const b = req.body || {};
    const mirror = await createMirror(req.user, { tgChatId: b.tgChatId, chatId: b.chatId, newTitle: b.newTitle, withPhotos: !!b.withPhotos, withFiles: !!b.withFiles, importLast: b.importLast ?? 3, visibility: b.visibility || 'public' });
    audit(req.user.id, 'tele.mirror.create', mirror.id, { tgChatId: b.tgChatId, chatId: mirror.chatId });
    return { mirror };
  });
  app.patch('/api/admin/tele/mirrors/:id', async (req) => {
    needOwner(req);
    const account = ownerAccount(req.user);
    const m = get('SELECT * FROM tele_mirrors WHERE id = ? AND account_id = ?', Number(req.params.id), account.id);
    if (!m) fail(404, 'پیدا نشد');
    if (req.body?.enabled != null) run('UPDATE tele_mirrors SET enabled = ? WHERE id = ?', req.body.enabled ? 1 : 0, m.id);
    if (req.body?.withPhotos != null) run('UPDATE tele_mirrors SET with_photos = ? WHERE id = ?', req.body.withPhotos ? 1 : 0, m.id);
    if (req.body?.withFiles != null) run('UPDATE tele_mirrors SET with_files = ? WHERE id = ?', req.body.withFiles ? 1 : 0, m.id);
    if (req.body?.visibility != null) {
      if (!VISIBILITY.includes(req.body.visibility)) fail(400, 'حالت نمایش نامعتبر است');
      setVisibility(m.chat_id, req.body.visibility, req.user.id);
      audit(req.user.id, 'tele.mirror.visibility', m.id, { visibility: req.body.visibility });
    }
    return { mirrors: listMirrors(account.id) };
  });
  // A new invite link for a link-only channel; the old links stop working.
  app.post('/api/admin/tele/mirrors/:id/invite', limit(10), async (req) => {
    needOwner(req);
    const account = ownerAccount(req.user);
    const m = get('SELECT * FROM tele_mirrors WHERE id = ? AND account_id = ?', Number(req.params.id), account.id);
    if (!m) fail(404, 'پیدا نشد');
    renewInvite(m.chat_id, req.user.id);
    audit(req.user.id, 'tele.mirror.invite', m.id);
    return { mirrors: listMirrors(account.id) };
  });
  app.delete('/api/admin/tele/mirrors/:id', async (req) => {
    needOwner(req);
    const account = ownerAccount(req.user);
    // The app channel and what was posted stay; only the copying stops.
    run('DELETE FROM tele_mirrors WHERE id = ? AND account_id = ?', Number(req.params.id), account.id);
    audit(req.user.id, 'tele.mirror.delete', req.params.id);
    return { mirrors: listMirrors(account.id) };
  });
  app.post('/api/admin/tele/mirrors/run', limit(6), async (req) => {
    needOwner(req);
    const account = ownerAccount(req.user);
    const r = await runMirrors();
    return { ...r, mirrors: listMirrors(account.id) };
  });
  app.patch('/api/admin/tele/mirrors-settings', async (req) => {
    needOwner(req);
    const n = Number(req.body?.minutes);
    if (!Number.isInteger(n) || n < 1 || n > 1440) fail(400, 'فاصله باید بین ۱ و ۱۴۴۰ دقیقه باشد');
    setSetting('tele_mirror_minutes', n);
    return { minutes: n };
  });

  // A mirrored post's photo, video or file: fetched from Telegram by the first member who opens it
  // (any app user, not only Telegram users, so not under /api/tele/; videos and files only users the
  // admin allowed). /mirror-photos is the v1.0.15 address.
  for (const route of ['/api/mirror-media/:id', '/api/mirror-photos/:id']) {
    app.post(route, limit(30), async (req) => ({ message: await loadMirrorMedia(req.user, req.params.id) }));
  }

  // ---------- Admin: alerts ----------
  app.get('/api/admin/tele/alerts', async (req) => {
    needTeleAdmin(req);
    return { alerts: getAlertSettings(), kinds: ALERT_KINDS };
  });
  app.patch('/api/admin/tele/alerts', async (req) => {
    needTeleAdmin(req);
    const alerts = setAlertSettings(req.body || {});
    audit(req.user.id, 'tele.alerts', '', alerts);
    return { alerts };
  });
  app.post('/api/admin/tele/alerts/test', limit(5), async (req) => {
    needTeleAdmin(req);
    const n = teleAlert('test', '🔔 پیام آزمایشی هشدارها؛ اگر این را می‌بینید، هشدارها به شما می‌رسد.', { force: true });
    return { recipients: n };
  });
  app.patch('/api/admin/tele/media', async (req) => {
    needTeleAdmin(req);
    const b = req.body || {};
    if (b.maxMb != null) {
      const mb = Number(b.maxMb);
      if (!(Number.isInteger(mb) && mb >= 1 && mb <= 50)) fail(400, 'سقف حجم باید بین ۱ تا ۵۰ مگابایت باشد');
      setSetting('tele_media_max_mb', mb);
    }
    if (b.fileMaxMb != null) {
      const mb = Number(b.fileMaxMb);
      if (!(Number.isInteger(mb) && mb >= 1 && mb <= 2000)) fail(400, 'سقف حجم فایل باید بین ۱ تا ۲۰۰۰ مگابایت باشد');
      setSetting('tele_file_max_mb', mb);
    }
    audit(req.user.id, 'tele.media.max', '', b);
    return { mediaMaxMb: settingNumber('tele_media_max_mb') || 5, fileMaxMb: settingNumber('tele_file_max_mb') || 20 };
  });
}
