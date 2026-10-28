import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import { listProxies, getProxy, createProxy, updateProxy, deleteProxy, getRoutePolicy, setRoutePolicy, publicProxy, PROTOCOL_HINTS, ROUTE_MODES } from '../tele/proxies.js';
import { probeViaEgress, egressStatus, ensureEgress, stopEgress } from '../tele/egress.js';
import { beginLogin, submitCode, submitPassword, disconnectAccount, getAccountForUser, publicAccount, listDialogs, setDialogSelected, teleRuntimeInfo } from '../tele/accounts.js';
import { syncDialogMessages, sendTeleMessage, refreshDialogsFromTelegram, listStoredMessages, publicMessage } from '../tele/messages.js';

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
    if (policy.enabled) { try { await ensureEgress(); } catch {} } else await stopEgress();
    audit(req.user.id, 'tele.policy', '', policy);
    return { policy, egress: egressStatus() };
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
    return { proxy: updateProxy(req.params.id, req.body || {}) };
  });
  app.delete('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    deleteProxy(req.params.id);
    return { ok: true };
  });
  app.post('/api/admin/tele/proxies/:id/probe', async (req) => {
    needTeleAdmin(req);
    return { proxy: await probeViaEgress(Number(req.params.id)), egress: egressStatus() };
  });
  app.post('/api/admin/tele/egress/restart', async (req) => {
    needTeleAdmin(req);
    await stopEgress();
    const ep = await ensureEgress();
    return { egress: egressStatus(), endpoint: ep };
  });
  app.get('/api/tele/status', async (req) => {
    const account = getAccountForUser(req.user.id);
    return { account: publicAccount(account), runtime: teleRuntimeInfo(), dialogs: account ? listDialogs(account.id) : [] };
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
  app.post('/api/tele/dialogs/refresh', async (req) => refreshDialogsFromTelegram(req.user.id));
  app.get('/api/tele/dialogs/:id/messages', async (req) => {
    const account = getAccountForUser(req.user.id);
    if (!account) fail(400, 'حساب وصل نیست');
    try {
      return await syncDialogMessages(req.user.id, req.params.id, { limit: Number(req.query?.limit) || 40 });
    } catch (e) {
      if (e.statusCode === 503 || /TDLib/i.test(String(e.message))) {
        return { messages: listStoredMessages(account.id, Number(req.params.id)).map(publicMessage), notice: e.message };
      }
      throw e;
    }
  });
  app.post('/api/tele/dialogs/:id/messages', async (req) => {
    return { message: await sendTeleMessage(req.user.id, req.params.id, req.body?.text) };
  });
}
