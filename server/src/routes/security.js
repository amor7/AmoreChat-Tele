import { hasSitePerm } from '../perms.js';
import { fail, audit } from '../chats.js';
import { secSettings, setSecSettings, listBans, banIp, unbanIp, failureSummary, normalizeIp, securityAlert } from '../secwatch.js';

// Seeing attacks and banning IPs: the owner and admins who manage users. Alert settings: the owner.
const needSecurity = (req) => {
  if (req.user.role !== 'owner' && !hasSitePerm(req.user, 'manage_users')) fail(403, 'دسترسی ندارید');
};
const needOwner = (req) => {
  if (req.user.role !== 'owner') fail(403, 'فقط مالک');
};

export default async function securityRoutes(app) {
  app.get('/api/admin/security', async (req) => {
    needSecurity(req);
    return { settings: secSettings(), bans: listBans(), failures: failureSummary(7), myIp: normalizeIp(req.ip) };
  });
  app.patch('/api/admin/security', async (req) => {
    needOwner(req);
    const settings = setSecSettings(req.body || {});
    audit(req.user.id, 'security.settings', '', settings);
    return { settings };
  });
  app.post('/api/admin/security/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    needOwner(req);
    return { recipients: securityAlert('🔔 پیام آزمایشی هشدارهای امنیتی.', { force: true }) };
  });
  app.post('/api/admin/security/bans', async (req) => {
    needSecurity(req);
    const ip = normalizeIp(req.body?.ip);
    if (!ip) fail(400, 'آی‌پی نامعتبر است');
    // Banning yourself would lock you out of this panel too.
    if (ip === normalizeIp(req.ip)) fail(400, 'این آی‌پی خود شماست؛ بن کردنش شما را هم بیرون می‌کند');
    const minutes = req.body?.minutes == null || req.body.minutes === '' ? 0 : Number(req.body.minutes);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 525600) fail(400, 'مدت بن نامعتبر است');
    banIp(ip, { by: req.user.id, reason: String(req.body?.reason || '').trim(), minutes });
    audit(req.user.id, 'security.ban', ip, { minutes, manual: true });
    return { bans: listBans() };
  });
  app.delete('/api/admin/security/bans/:ip', async (req) => {
    needSecurity(req);
    const ip = normalizeIp(decodeURIComponent(req.params.ip));
    if (!ip) fail(400, 'آی‌پی نامعتبر است');
    unbanIp(ip);
    audit(req.user.id, 'security.unban', ip);
    return { bans: listBans() };
  });
}
