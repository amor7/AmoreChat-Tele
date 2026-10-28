// Manual backup: `docker compose exec app node server/src/backup-cli.js`
import { backupNow } from './backup.js';

console.log('backup written:', await backupNow());
