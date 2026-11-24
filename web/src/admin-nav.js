// The admin panel's navigation as data, plus the pure rules around it (which items a user sees,
// which one opens first, deep links). No imports, so node tests it directly
// (server/test/admin-nav.test.mjs); Admin.jsx adds the icons and the panes.
//
// perm: a site permission (hasSitePerm), or 'owner' for the server owner only.

export const ADMIN_NAV = [
  {
    id: 'status',
    label: 'وضعیت',
    items: [
      { id: 'health', label: 'سلامت سرور', perm: 'view_audit' },
      { id: 'stats', label: 'آمار', perm: 'view_audit' },
      { id: 'audit', label: 'گزارش فعالیت', perm: 'view_audit' },
    ],
  },
  {
    id: 'people',
    label: 'کاربران',
    items: [
      { id: 'users', label: 'فهرست کاربران', perm: 'manage_users' },
      { id: 'security', label: 'امنیت', perm: 'manage_users' },
      { id: 'invites', label: 'کدهای دعوت', perm: 'manage_invites' },
      { id: 'handles', label: 'شناسه‌ها', perm: 'owner' },
    ],
  },
  {
    id: 'talk',
    label: 'گفتگوها',
    items: [
      { id: 'chats', label: 'گروه‌ها', perm: 'manage_chats' },
      { id: 'reports', label: 'گزارش تخلف', perm: 'handle_reports' },
      { id: 'live', label: 'تماس و ویس‌چت فعال', perm: 'manage_chats' },
    ],
  },
  {
    // Telegram and the tunnel it goes through: one place, two sub-pages.
    id: 'external',
    label: 'اتصال بیرونی',
    items: [
      { id: 'tele', label: 'تلگرام', perm: 'manage_settings' },
      { id: 'vpn', label: 'VPN', perm: 'manage_settings' },
    ],
  },
  {
    id: 'server',
    label: 'سرور',
    items: [
      { id: 'settings', label: 'تنظیمات', perm: 'manage_settings' },
      { id: 'storage', label: 'مدیریت فضا', perm: 'manage_storage' },
      { id: 'backup', label: 'پشتیبان', perm: 'owner' },
      { id: 'update', label: 'آپدیت', perm: 'owner' },
    ],
  },
];

/**
 * The one admin permission rule: `perm` is 'owner' (the server owner only) or a site permission
 * checked with `hasSitePerm(me, perm)` (util.js, passed in to keep this file import-free).
 */
export const adminCan = (me, hasSitePerm) => (perm) => (perm === 'owner' ? me?.role === 'owner' : hasSitePerm(me, perm));

/** Whether `me` may open the panel at all (it has at least one page for them). */
export const hasAdminPanel = (me, hasSitePerm) => visibleNav(adminCan(me, hasSitePerm)).length > 0;

/**
 * The sections and items `can(perm)` allows, in the same order; a section with no allowed item
 * is left out. The caller supplies `can` so the permission rule stays in one place (util.js).
 */
export function visibleNav(can, nav = ADMIN_NAV) {
  return nav.map((s) => ({ ...s, items: s.items.filter((i) => can(i.perm)) })).filter((s) => s.items.length > 0);
}

/** Every item of `nav`, flat, in order. */
export const navItems = (nav) => nav.flatMap((s) => s.items);

/** The section that holds item `id`, or null. */
export const sectionOf = (nav, id) => nav.find((s) => s.items.some((i) => i.id === id)) || null;

/**
 * The item to open: the one asked for (a deep link), else the one opened last on this device,
 * else the first. Only items in `nav` (already filtered) count; null when nothing is allowed.
 */
export function pickItem(nav, { wanted, remembered } = {}) {
  const ids = navItems(nav).map((i) => i.id);
  for (const id of [wanted, remembered]) if (id && ids.includes(id)) return id;
  return ids[0] || null;
}

/** The item to open when a section is chosen: the current one if it is in there, else its first. */
export function sectionStart(nav, sectionId, current) {
  const s = nav.find((x) => x.id === sectionId);
  if (!s) return current || null;
  return s.items.some((i) => i.id === current) ? current : s.items[0].id;
}

/**
 * `#/admin` or `#/admin/<item>` → { item } (item null for the plain link); anything else → null.
 * Whether the item exists or is allowed is pickItem's job, so an old link still opens the panel.
 */
export function parseAdminLink(hash) {
  const m = /^#\/admin(?:\/([\w-]+))?\/?$/.exec(hash || '');
  return m ? { item: m[1] || null } : null;
}

/** The deep link of an item (for links in messages or notifications). */
export const adminLink = (item) => (item ? `#/admin/${item}` : '#/admin');
