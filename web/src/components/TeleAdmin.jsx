// Admin panel → «اتصال بیرونی» → Telegram: an overview, the users, and the channels copied into
// the app. The VPN page (the tunnel Telegram goes through) is TeleAdminVpn.jsx; each page's
// parts live in TeleAdmin*.jsx and their requests in teleApi.js (admin section).
import { useState } from 'react';
import { useStore } from '../store';
import TeleOverview from './TeleAdminOverview';
import { TeleAccess, TeleUsers, FILES_LABELS } from './TeleAdminAccounts';
import TeleMirrors from './TeleAdminMirrors';
import Segments from './Segments';
import { FileDown } from 'lucide-react';

export function TeleSection({ onVpn }) {
  const me = useStore((s) => s.me);
  const [page, setPage] = useState('overview');
  return (
    <div className="tele-admin">
      <Segments
        value={page}
        onChange={setPage}
        items={[
          ['overview', 'نمای کلی'],
          ['users', 'کاربران'],
          ...(me.role === 'owner' ? [['channels', 'کانال‌ها']] : []),
        ]}
      />
      {page === 'overview' && <TeleOverview go={setPage} onVpn={onVpn} />}
      {page === 'users' && (
        <>
          <TeleAccess />
          <TeleUsers />
        </>
      )}
      {page === 'channels' && (
        <>
          <TeleMirrors />
          <TeleAccess
            feature="mirror-files"
            icon={FileDown}
            title="چه کسانی ویدیو و فایل کانال را بگیرند"
            hint="اولین باز کردن ویدیو یا فایل از تلگرام گرفته می‌شود و VPN مصرف می‌کند. فقط این کاربران می‌توانند آن را بگیرند؛ بعد از آن برای همه اعضا باز است."
            labels={FILES_LABELS}
            announce={false}
          />
        </>
      )}
    </div>
  );
}
