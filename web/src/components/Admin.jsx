import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { hasSitePerm } from '../util';
import { visibleNav, navItems, pickItem, sectionOf, sectionStart, adminCan } from '../admin-nav';
import { Modal } from './Modals';
import { Live } from './AdminRtc';
import Health from './Health';
import { TeleSection } from './TeleAdmin';
import VpnAdmin from './TeleAdminVpn';
import AdminSecurity from './AdminSecurity';
import AdminUpdate from './AdminUpdate';
import AdminStorage from './AdminStorage';
import AdminHandles from './AdminHandles';
import { Stats, Users } from './AdminPanelsA1';
import { Invites, Chats, Backups } from './AdminPanelsA2';
import { Settings, Reports, Audit } from './AdminPanelsB';
import { EmptyState } from './States';
import { HeartPulse, ChartColumn, Flag, Users as UsersIcon, Ticket, MessagesSquare, Radio, Settings as SettingsIcon, ScrollText, DatabaseBackup, Cable, ShieldAlert, Send, Rocket, HardDrive, AtSign, ShieldOff } from 'lucide-react';

// Sections, items and permissions are data in admin-nav.js; only the icons live here.
const ICONS = {
  health: HeartPulse,
  stats: ChartColumn,
  audit: ScrollText,
  users: UsersIcon,
  security: ShieldAlert,
  invites: Ticket,
  handles: AtSign,
  chats: MessagesSquare,
  reports: Flag,
  live: Radio,
  tele: Send,
  vpn: Cable,
  settings: SettingsIcon,
  storage: HardDrive,
  backup: DatabaseBackup,
  update: Rocket,
};

/**
 * The admin panel. `item` opens a given page (openModal('admin', { item, nonce }) or
 * #/admin/<item>); otherwise the page opened last on this device, else the first one the user
 * may see. A new `nonce` with the same item jumps there again while the panel is open.
 */
export default function Admin({ onClose, item: wanted, nonce }) {
  const me = useStore((s) => s.me);
  const setPrefs = useStore((s) => s.setPrefs);
  const showToast = useStore((s) => s.showToast);
  const nav = useMemo(() => visibleNav(adminCan(me, hasSitePerm)), [me]);
  const [tab, setTab] = useState(() => pickItem(nav, { wanted, remembered: useStore.getState().prefs.adminItem }));
  const [storageUser, setStorageUser] = useState(null);
  const contentRef = useRef(null);
  // A permission taken away while open: fall back to an allowed page, never show a hidden one.
  const current = pickItem(nav, { wanted: tab });
  const section = sectionOf(nav, current);

  const go = (id) => {
    setTab(id);
    setPrefs({ adminItem: id });
  };
  // A deep link, also while the panel is already open (the store keeps this component and only
  // changes its props). A page this user may not see opens nothing, with a word why.
  useEffect(() => {
    if (!wanted) return;
    if (!navItems(nav).some((i) => i.id === wanted)) {
      if (nav.length) showToast('به آن بخش دسترسی ندارید');
      return;
    }
    setTab(wanted);
  }, [wanted, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new page starts at its top (the content pane on wide screens, the whole sheet on phones).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.scrollTop = 0;
    const body = el.closest('.modal-body');
    if (body) body.scrollTop = 0;
    // Phones: the chosen section and page may sit off-screen in their scrolling rows.
    for (const b of body?.querySelectorAll('.admin-nav [aria-current]') || []) b.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [current]);

  const pane = () => {
    switch (current) {
      case 'health':
        return <Health />;
      case 'stats':
        return <Stats />;
      case 'reports':
        return <Reports />;
      case 'users':
        return (
          <Users
            onStorage={
              hasSitePerm(me, 'manage_storage')
                ? (u) => {
                    setStorageUser({ id: u.id, name: u.displayName });
                    go('storage');
                  }
                : null
            }
          />
        );
      case 'handles':
        return <AdminHandles />;
      case 'storage':
        return <AdminStorage key={storageUser?.id} start={storageUser} />;
      case 'invites':
        return <Invites />;
      case 'chats':
        return <Chats onClose={onClose} />;
      case 'settings':
        return <Settings />;
      case 'audit':
        return <Audit />;
      case 'live':
        return <Live />;
      case 'tele':
        return <TeleSection onVpn={() => go('vpn')} />;
      case 'vpn':
        return <VpnAdmin />;
      case 'security':
        return <AdminSecurity />;
      case 'backup':
        return <Backups />;
      case 'update':
        return <AdminUpdate />;
      default:
        return null;
    }
  };

  return (
    <Modal title="پنل مدیریت" onClose={onClose} size="large admin-modal" bodyClassName="admin-body">
      {!nav.length ? (
        <EmptyState compact icon={<ShieldOff size={36} />} title="دسترسی مدیریتی ندارید" hint="مالک سرور می‌تواند از «کاربران» به حساب شما دسترسی بدهد." />
      ) : (
        <div className="admin-layout">
          <nav className="admin-nav" aria-label="بخش‌های مدیریت">
            {/* Phones: one section at a time, chosen here; wide screens list every section below. */}
            <div className="admin-sections">
              {nav.map((s) => (
                <button key={s.id} type="button" aria-current={s.id === section?.id ? 'true' : undefined} onClick={() => go(sectionStart(nav, s.id, current))}>
                  {s.label}
                </button>
              ))}
            </div>
            {nav.map((s) => (
              <div key={s.id} className={`admin-group ${s.id === section?.id ? 'current' : ''}`.trim()}>
                <h4 className="admin-nav-title" id={`admin-sec-${s.id}`}>
                  {s.label}
                </h4>
                <ul aria-labelledby={`admin-sec-${s.id}`}>
                  {s.items.map((i) => {
                    const Icon = ICONS[i.id];
                    return (
                      <li key={i.id}>
                        {/* data-admin-item: the stable hook for e2e tests (labels may change). */}
                        <button type="button" data-admin-item={i.id} aria-current={i.id === current ? 'page' : undefined} onClick={() => go(i.id)}>
                          {Icon && <Icon size={16} aria-hidden="true" />} {i.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          <div className="admin-content" ref={contentRef}>
            {pane()}
          </div>
        </div>
      )}
    </Modal>
  );
}
