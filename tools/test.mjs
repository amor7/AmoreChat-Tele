// Unit tests, each run against a fresh, empty data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(import.meta.dirname, '../server/test');
let failed = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs'))) {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amorechat-unit-'));
  const r = spawnSync(process.execPath, ['--test', path.join(dir, f)], { stdio: 'inherit', env: { ...process.env, DATA_DIR } });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
