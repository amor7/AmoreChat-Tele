import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import {
  listProxies,
  getProxy,
  createProxy,
  updateProxy,
  deleteProxy,
  getRoutePolicy,
  setRoutePolicy,
  publicProxy,
  PROTOCOL_HINTS,
  ROUTE_MODES,
} from '../tele/proxies.js';
import { probeViaEgress, egressStatus, ensureEgress, stopEgress } from '../tele/egress.js';
import {
  beginLogin,
  submitCode,
  submitPassword,
  disconnectAccount,
  getAccountForUser,
  publicAccount,
  listDialogs,
  setDialogSelected,
  teleRuntimeInfo,
} from '../tele/accounts.js';

const needTeleAdmin = (req) => {
  if (!hasSitePerm(req.user, 'manage_settings') && req.user.role !== 'owner') {
    fail(403, 'دسترسی ندارید');
  }
};

export default async function teleRoutes(app) {
  // ---------- Admin: policy & proxies ----------
  app.get('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    return {
      policy: getRoutePolicy(),
      modes: ROUTE_MODES,
      protocols: PROTOCOL_HINTS,
      egress: egressStatus(),
      runtime: teleRuntimeInfo(),
    };
  });

  app.patch('/api/admin/tele/policy', async (req) => {
    needTeleAdmin(req);
    const policy = setRoutePolicy(req.body || {});
    if (policy.enabled) {
      try {
        await ensureEgress();
      } catch {
        /* selection may have no healthy proxy yet */
      }
    } else {
      await stopEgress();
    }
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
    if (Array.isArray(b.configs)) {
      const created = [];
      for (const item of b.configs.slice(0, 50)) {
        created.push(
          createProxy({
            name: item.name,
            config: item.config || item.link || item.url,
            protocol: item.protocol,
            priority: item.priority,
            groupName: item.groupName || b.groupName,
            enabled: item.enabled !== false,
          }),
        );
      }
      audit(req.user.id, 'tele.proxy.bulk_create', '', { count: created.length });
      return { proxies: created };
    }
    if (typeof b.links === 'string' && b.links.trim()) {
      const lines = b.links
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      const created = [];
      for (const line of lines.slice(0, 50)) {
        created.push(
          createProxy({
            name: b.name || undefined,
            config: line,
            protocol: b.protocol,
            priority: b.priority,
            groupName: b.groupName,
            enabled: b.enabled !== false,
          }),
        );
      }
      audit(req.user.id, 'tele.proxy.bulk_create', '', { count: created.length });
      return { proxies: created };
    }
    const proxy = createProxy({
      name: b.name,
      config: b.config || b.link || b.url,
      protocol: b.protocol,
      priority: b.priority,
      groupName: b.groupName,
      enabled: b.enabled !== false,
    });
    audit(req.user.id, 'tele.proxy.create', proxy.id, { name: proxy.name, protocol: proxy.protocol });
    return { proxy };
  });

  app.patch('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    const proxy = updateProxy(req.params.id, req.body || {});
    audit(req.user.id, 'tele.proxy.update', proxy.id, { name: proxy.name });
    return { proxy };
  });

  app.delete('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    deleteProxy(req.params.id);
    audit(req.user.id, 'tele.proxy.delete', req.params.id);
    return { ok: true };
  });

  app.post('/api/admin/tele/proxies/:id/probe', async (req) => {
    needTeleAdmin(req);
    const proxy = await probeViaEgress(Number(req.params.id));
    audit(req.user.id, 'tele.proxy.probe', proxy.id);
    return { proxy, egress: egressStatus() };
  });

  app.get('/api/admin/tele/proxies/:id', async (req) => {
    needTeleAdmin(req);
    const row = getProxy(req.params.id);
    if (!row) fail(404, 'پروکسی پیدا نشد');
    return { proxy: publicProxy(row) };
  });

  app.post('/api/admin/tele/egress/restart', async (req) => {
    needTeleAdmin(req);
    await stopEgress();
    const ep = await ensureEgress();
    audit(req.user.id, 'tele.egress.restart', ep.proxyId);
    return { egress: egressStatus(), endpoint: ep };
  });

  // ---------- User: own Telegram account ----------
  app.get('/api/tele/status', async (req) => {
    const account = getAccountForUser(req.user.id);
    return {
      account: publicAccount(account),
      runtime: teleRuntimeInfo(),
      dialogs: account ? listDialogs(account.id, { selectedOnly: false }) : [],
    };
  });

  app.post('/api/tele/login/phone', async (req) => {
    const r = await beginLogin(req.user.id, req.body?.phone);
    audit(req.user.id, 'tele.login.phone', r.account?.id);
    return r;
  });

  app.post('/api/tele/login/code', async (req) => {
    const r = await submitCode(req.user.id, req.body?.code);
    audit(req.user.id, 'tele.login.code', r.account?.id);
    return r;
  });

  app.post('/api/tele/login/password', async (req) => {
    const r = await submitPassword(req.user.id, req.body?.password);
    audit(req.user.id, 'tele.login.password', r.account?.id);
    return r;
  });

  app.post('/api/tele/disconnect', async (req) => {
    await disconnectAccount(req.user.id);
    audit(req.user.id, 'tele.disconnect');
    return { ok: true };
  });

  app.patch('/api/tele/dialogs/:id', async (req) => {
    const account = getAccountForUser(req.user.id);
    if (!account) fail(400, 'حساب تلگرام وصل نیست');
    const dialogs = setDialogSelected(account.id, req.params.id, req.body?.selected !== false);
    return { dialogs };
  });
}
