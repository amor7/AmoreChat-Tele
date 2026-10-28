import { useState } from 'react';
import { useStore } from '../store';
import { hasSitePerm } from '../util';
import { Modal } from './Modals';
import { Live } from './AdminRtc';
import Health from './Health';
import TeleAdmin from './TeleAdmin';
import { Stats, Users } from './AdminPanelsA1';
import { Invites, Chats, Backups } from './AdminPanelsA2';
import { Settings, Reports, Audit } from './AdminPanelsB';
import { HeartPulse, ChartColumn, Flag, Users as UsersIcon, Ticket, MessagesSquare, Radio, Settings as SettingsIcon, ScrollText, DatabaseBackup, Cable } from 'lucide-react';

const TABS = [
  ['health', 'سلامت سرور', 'view_audit', HeartPulse],
  ['stats', 'آمار', 'view_audit', ChartColumn],
  ['reports', 'گزارش‌ها', 'handle_reports', Flag],
  ['users', 'کاربران', 'manage_users', UsersIcon],
  ['invites', 'کدهای دعوت', 'manage_invites', Ticket],
  ['chats', 'گروه‌ها', 'manage_chats', MessagesSquare],
  ['live', 'زنده', 'manage_chats', Radio],
  ['tele', 'Tele / VPN', 'manage_settings', Cable],
  ['settings', 'تنظیمات', 'manage_settings', SettingsIcon],
  ['audit', 'گزارش فعالیت', 'view_audit', ScrollText],
  ['backup', 'پشتیبان', 'owner', DatabaseBackup],
];

export default function Admin({ onClose }) {
  const me = useStore((s) => s.me);
  const tabs = TABS.filter(([, , perm]) => (perm === 'owner' ? me.role === 'owner' : hasSitePerm(me, perm)));
  const [tab, setTab] = useState(tabs[0]?.[0]);

  return (
    <Modal title="پنل مدیریت" onClose={onClose} size="large">
      <div className="tabs scroll">
        {tabs.map(([key, label, , Icon]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>
      {tab === 'health' && <Health />}
      {tab === 'stats' && <Stats />}
      {tab === 'reports' && <Reports />}
      {tab === 'users' && <Users />}
      {tab === 'invites' && <Invites />}
      {tab === 'chats' && <Chats onClose={onClose} />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
      {tab === 'live' && <Live />}
      {tab === 'tele' && <TeleAdmin />}
      {tab === 'backup' && <Backups />}
    </Modal>
  );
}
