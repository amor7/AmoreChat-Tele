// The admin panel's navigation rules (web/src/admin-nav.js).
// Usage: node --test server/test/admin-nav.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_NAV, visibleNav, navItems, sectionOf, pickItem, sectionStart, parseAdminLink, adminLink, adminCan, hasAdminPanel } from '../../web/src/admin-nav.js';
import { hasSitePerm } from '../../web/src/util.js';

// The rule Admin.jsx and the sidebar use: util.js hasSitePerm, plus 'owner' for the owner only.
const canFor = (me) => adminCan(me, hasSitePerm);
const owner = canFor({ role: 'owner' });
const ids = (nav) => navItems(nav).map((i) => i.id);

test('every one of the 16 panes is in exactly one section, with a known permission', () => {
  const all = ids(ADMIN_NAV);
  assert.equal(all.length, 16);
  assert.equal(new Set(all).size, 16);
  const perms = new Set(['view_audit', 'manage_users', 'manage_invites', 'manage_chats', 'handle_reports', 'manage_settings', 'manage_storage', 'owner']);
  for (const i of navItems(ADMIN_NAV)) assert.ok(perms.has(i.perm), `${i.id}: ${i.perm}`);
  // Section ids never collide with item ids (deep links name items).
  for (const s of ADMIN_NAV) assert.ok(!all.includes(s.id), s.id);
  assert.deepEqual(sectionOf(ADMIN_NAV, 'vpn').items.map((i) => i.id), ['tele', 'vpn'], 'Telegram and VPN share a section');
});

test('every page keeps the permission it had as a flat tab (before the sections)', () => {
  const LEGACY = {
    health: 'view_audit',
    stats: 'view_audit',
    reports: 'handle_reports',
    users: 'manage_users',
    security: 'manage_users',
    invites: 'manage_invites',
    chats: 'manage_chats',
    live: 'manage_chats',
    tele: 'manage_settings',
    vpn: 'manage_settings',
    settings: 'manage_settings',
    audit: 'view_audit',
    storage: 'manage_storage',
    handles: 'owner',
    backup: 'owner',
    update: 'owner',
  };
  assert.deepEqual(Object.fromEntries(navItems(ADMIN_NAV).map((i) => [i.id, i.perm])), LEGACY);
});

test('hasAdminPanel: the menu entry shows exactly when the panel has a page', () => {
  assert.equal(hasAdminPanel({ role: 'owner' }, hasSitePerm), true);
  assert.equal(hasAdminPanel({ role: 'admin', adminPerms: ['manage_storage'] }, hasSitePerm), true, 'storage only');
  assert.equal(hasAdminPanel({ role: 'admin', adminPerms: ['handle_reports'] }, hasSitePerm), true);
  assert.equal(hasAdminPanel({ role: 'admin', adminPerms: [] }, hasSitePerm), false);
  assert.equal(hasAdminPanel({ role: 'user', adminPerms: ['manage_users'] }, hasSitePerm), false, 'perms without the admin role');
  assert.equal(hasAdminPanel(null, hasSitePerm), false);
});

test('the owner sees everything', () => {
  assert.deepEqual(visibleNav(owner), ADMIN_NAV);
});

test('an admin sees only the items of their permissions; empty sections are left out', () => {
  const nav = visibleNav(canFor({ role: 'admin', adminPerms: ['view_audit', 'manage_storage'] }));
  assert.deepEqual(nav.map((s) => s.id), ['status', 'server']);
  assert.deepEqual(ids(nav), ['health', 'stats', 'audit', 'storage']);

  const settings = visibleNav(canFor({ role: 'admin', adminPerms: ['manage_settings'] }));
  assert.deepEqual(ids(settings), ['tele', 'vpn', 'settings']);
  // Owner-only items never show for an admin, whatever their permissions.
  const full = visibleNav(canFor({ role: 'admin', adminPerms: ['view_audit', 'manage_users', 'manage_invites', 'manage_chats', 'handle_reports', 'manage_settings', 'manage_storage'] }));
  assert.ok(!ids(full).some((id) => ['handles', 'backup', 'update'].includes(id)));
  assert.equal(ids(full).length, 13);

  assert.deepEqual(visibleNav(canFor({ role: 'user' })), []);
  assert.deepEqual(visibleNav(canFor({ role: 'admin' })), [], 'an admin without permissions');
});

test('visibleNav does not change ADMIN_NAV', () => {
  const before = JSON.stringify(ADMIN_NAV);
  visibleNav(() => false);
  assert.equal(JSON.stringify(ADMIN_NAV), before);
});

test('sectionOf finds the section of an item', () => {
  assert.equal(sectionOf(ADMIN_NAV, 'storage').id, 'server');
  assert.equal(sectionOf(ADMIN_NAV, 'users').id, 'people');
  assert.equal(sectionOf(ADMIN_NAV, 'nope'), null);
  assert.equal(sectionOf([], 'users'), null);
});

test('pickItem: deep link, then the last one on this device, then the first allowed', () => {
  const nav = visibleNav(canFor({ role: 'admin', adminPerms: ['manage_users', 'manage_settings'] }));
  assert.equal(pickItem(nav), 'users');
  assert.equal(pickItem(nav, { remembered: 'vpn' }), 'vpn');
  assert.equal(pickItem(nav, { wanted: 'tele', remembered: 'vpn' }), 'tele');
  // Not allowed (or no longer existing): ignored, never opened.
  assert.equal(pickItem(nav, { wanted: 'backup', remembered: 'security' }), 'security');
  assert.equal(pickItem(nav, { wanted: 'gone', remembered: 'storage' }), 'users');
  assert.equal(pickItem([], { wanted: 'users' }), null);
});

test('sectionStart keeps the current item when it is in the chosen section', () => {
  assert.equal(sectionStart(ADMIN_NAV, 'external', 'vpn'), 'vpn');
  assert.equal(sectionStart(ADMIN_NAV, 'external', 'users'), 'tele');
  assert.equal(sectionStart(ADMIN_NAV, 'nope', 'users'), 'users');
});

test('parseAdminLink reads #/admin and #/admin/<item> only', () => {
  assert.deepEqual(parseAdminLink('#/admin'), { item: null });
  assert.deepEqual(parseAdminLink('#/admin/'), { item: null });
  assert.deepEqual(parseAdminLink('#/admin/vpn'), { item: 'vpn' });
  assert.deepEqual(parseAdminLink('#/admin/storage/'), { item: 'storage' });
  for (const h of ['', '#/', '#/chat/3', '#/administrator', '#/admin/a/b', '#/admin/<x>', '#/tele', undefined, null]) assert.equal(parseAdminLink(h), null, String(h));
  assert.equal(adminLink('vpn'), '#/admin/vpn');
  assert.deepEqual(parseAdminLink(adminLink('health')), { item: 'health' });
  assert.deepEqual(parseAdminLink(adminLink()), { item: null });
});
