import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, getRoutePolicy, setRoutePolicy, publicProxy, PROTOCOL_HINTS, ROUTE_MODES } from '../tele/proxies.js';
import { probeViaEgress, egressStatus, ensureEgress, stopEgress, refreshEgress } from '../tele/egress.js';
import { beginLogin, submitCode, submitPassword, disconnectAccount, getAccountForUser, publicAccount, listDialogs, setDialogSelected, teleRuntimeInfo, clearStaleLogin, isLive, trafficOf } from '../tele/accounts.js';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { all, run, now } from '../db.js';
import { settingNumber, setSetting } from '../settings.js';
import { syncDialogMessages, sendTeleMessage, sendTelePhoto, telePhotoFile, newUploadPath, mediaMaxBytes, refreshDialogsFromTelegram, listStoredMessages, publicMessages, searchDialogMessages } from '../tele/messages.js';

const needTeleAdmin = (req) => {
  if (!hasSitePerm(req.user, 'manage_settings') && req.user.role !== 'owner') fail(403, 'دسترسی ندارید');
};

export default async function teleRoutes(app) {
  app.get('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    return { policy: getRoutePolicy(), modes: ROUTE_MODES, protocols: PROTOCOL_HINTS, egress: egressStatus(), runtime: teleRuntimeInfo() };
  });
  app.patch('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    const policy = setRoutePolicy(req.body || {});
    const egress = await refreshEgress();
    audit(req.user.id, 'tele.policy', '', policy);
    return { policy, egress };
  });
  app.get('/api/admin/tele/proxies', async (req) => {
    needTeleAdmin(req);
    return { proxies: listProxies(), policy: getRoutePolicy(), egress: egressStatus() };
  });
  app.post('/api/admin/tele/proxies', async (req) => {
    needTeleAdmin(req);
    const b = req.body || {};
    if (typeof b.links === 'string' && b.links.trim()) {
      const created = [];
      for (const line of b.links.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 50)) {
        created.push(createProxy({ name: b.name, config: line, protocol: b.protocol, priority: b.priority, groupName: b.groupName, enabled: b.enabled !== false }));
      }
      audit(req.user.id, 'tele.proxy.bulk_create', '', { count: created.length });
      return { proxies: created };
    }
    const proxy = createProxy({ name: b.name, config: b.config || b.link || b.url, protocol: b.protocol, priority: b.priority, groupName: b.groupName, enabled: b.enabled !== false });
    audit(req.user.id, 'tele.proxy.create', proxy.id);
    return { proxy };
  });
  app.patch('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    const proxy = updateProxy(req.params.id, req.body || {});
    // The running tunnel uses this proxy's old settings: start it again with the new ones.
    if (egressStatus().proxyId === Number(req.params.id)) await stopEgress();
    return { proxy, egress: await refreshEgress() };
  });
  app.delete('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    if (egressStatus().proxyId === Number(req.params.id)) await stopEgress();
    deleteProxy(req.params.id);
    return { ok: true, egress: await refreshEgress() };
  });
  app.post('/api/admin/tele/proxies/:id/probe', async (req) => {
    needTeleAdmin(req);
    const proxy = await probeViaEgress(Number(req.params.id));
    // A proxy that just turned healthy may be the one the policy picks: start the tunnel now.
    return { proxy, egress: await refreshEgress() };
  });
  app.post('/api/admin/tele/egress/restart', async (req) => {
    needTeleAdmin(req);
    await stopEgress();
    const ep = await ensureEgress();
    return { egress: egressStatus(), endpoint: ep };
  });
  app.get('/api/tele/status', async (req) => {
    const account = clearStaleLogin(getAccountForUser(req.user.id));
    // live: whether the TDLib connection is open right now (it closes when idle); traffic: what it moved since opening.
    return { account: publicAccount(account), mediaMaxMb: settingNumber('tele_media_max_mb') || 5, runtime: teleRuntimeInfo(), live: account ? isLive(account.id) : false, traffic: account ? await trafficOf(account.id) : null, dialogs: account ? listDialogs(account.id) : [] };
  });
  app.post('/api/tele/login/phone', async (req) => beginLogin(req.user.id, req.body?.phone));
  app.post('/api/tele/login/code', async (req) => submitCode(req.user.id, req.body?.code));
  app.post('/api/tele/login/password', async (req) => submitPassword(req.user.id, req.body?.password));
  app.post('/api/tele/disconnect', async (req) => { await disconnectAccount(req.user.id); return { ok: true }; });
  app.patch('/api/tele/dialogs/:id', async (req) => {
    const account = getAccountForUser(req.user.id);
    if (!account) fail(400, 'حساب وصل نیست');
    return { dialogs: setDialogSelected(account.id, req.params.id, req.body?.selected !== false) };
  });
  app.post('/api/tele/dialogs/refresh', async (req) => refreshDialogsFromTelegram(req.user.id, { all: !!req.body?.all }));
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
  app.get('/api/tele/dialogs/:id/search', async (req) => searchDialogMessages(req.user.id, req.params.id, req.query?.q));
  app.post('/api/tele/dialogs/:id/messages', async (req) => {
    return { message: await sendTeleMessage(req.user.id, req.params.id, req.body?.text, Number(req.body?.replyTo) || null) };
  });

  // ---------- Photos (only for accounts an admin allowed) ----------
  app.post('/api/tele/dialogs/:id/photo', async (req, reply) => {
    const account = getAccountForUser(req.user.id);
    if (!account?.allow_media) fail(403, 'دسترسی به عکس‌های تلگرام برای شما فعال نیست');
    const part = await req.file({ limits: { fileSize: mediaMaxBytes(), files: 1 } });
    if (!part) fail(400, 'عکسی ارسال نشده');
    if (!/^image\//.test(part.mimetype || '')) fail(400, 'فقط عکس قابل ارسال است');
    const file = newUploadPath();
    try {
      await pipeline(part.file, fs.createWriteStream(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(file, { force: true });
      fail(413, `حداکثر حجم عکس ${settingNumber('tele_media_max_mb') || 5} مگابایت است`);
    }
    reply.code(201);
    return { message: await sendTelePhoto(req.user.id, req.params.id, file, { caption: req.query?.caption, replyTo: Number(req.query?.replyTo) || null }) };
  });
  app.get('/api/tele/messages/:id/photo', async (req, reply) => {
    const file = await telePhotoFile(req.user.id, req.params.id);
    reply.header('cache-control', 'private, max-age=86400');
    reply.type(/\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(file));
  });

  // ---------- Admin: who may load and send photos, and up to which size ----------
  app.get('/api/admin/tele/accounts', async (req) => {
    needTeleAdmin(req);
    const accounts = all(
      `SELECT a.id, a.user_id, a.status, a.display_name AS tg_name, a.allow_media, u.display_name, u.username
       FROM tele_accounts a JOIN users u ON u.id = a.user_id ORDER BY u.display_name`,
    ).map((a) => ({ id: a.id, userId: a.user_id, name: a.display_name, username: a.username, tgName: a.tg_name, status: a.status, allowMedia: !!a.allow_media }));
    return { accounts, mediaMaxMb: settingNumber('tele_media_max_mb') || 5 };
  });
  app.patch('/api/admin/tele/accounts/:id', async (req) => {
    needTeleAdmin(req);
    const allow = req.body?.allowMedia ? 1 : 0;
    run('UPDATE tele_accounts SET allow_media = ?, updated_at = ? WHERE id = ?', allow, now(), Number(req.params.id));
    audit(req.user.id, 'tele.account.media', req.params.id, { allowMedia: !!allow });
    return { ok: true };
  });
  app.patch('/api/admin/tele/media', async (req) => {
    needTeleAdmin(req);
    const mb = Math.round(Number(req.body?.maxMb));
    if (!(mb >= 1 && mb <= 50)) fail(400, 'سقف حجم باید بین ۱ تا ۵۰ مگابایت باشد');
    setSetting('tele_media_max_mb', mb);
    audit(req.user.id, 'tele.media.max', '', { mb });
    return { mediaMaxMb: mb };
  });
}
