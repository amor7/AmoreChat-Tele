// Checks a backup file in its own process (a big database takes a while):
//   node server/src/backup-check.js <file>   prints {"ok":true,...} or {"ok":false,"error":...}
import { DatabaseSync } from 'node:sqlite';

let out;
try {
  const db = new DatabaseSync(process.argv[2], { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check(1)').get().integrity_check;
  if (integrity !== 'ok') throw new Error(integrity);
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const users = count('users');
  if (!users) throw new Error('هیچ کاربری در این نسخه نیست');
  out = { ok: true, users, messages: count('messages'), schema: db.prepare('PRAGMA user_version').get().user_version };
  db.close();
} catch (e) {
  out = { ok: false, error: String(e?.message || e).slice(0, 200) };
}
console.log(JSON.stringify(out));
