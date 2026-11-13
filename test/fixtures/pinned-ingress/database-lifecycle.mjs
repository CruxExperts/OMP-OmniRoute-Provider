// Direct core/settings research observation; not an HTTP or qualification test.
import { writeFileSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { ensureDbInitialized, getDbInstance, pingDb, closeDbInstance, runManagedDbHealthCheck, DATA_DIR, SQLITE_FILE } from './core';
import { getSettings, updateSettings } from './settings';
import { resolveDbHealthWorker } from './healthCheckRunner';
import { getCliVersionOverride } from '@omniroute/open-sse/config/cliVersions.ts';

const phase = process.argv[2];
if (!['cold', 'warm'].includes(phase) || process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1' || DATA_DIR !== '/work/data' || SQLITE_FILE !== '/work/data/storage.sqlite') throw new Error('lifecycle isolation or phase mismatch');
const progress = stage => writeFileSync('/work/lifecycle-progress.json', JSON.stringify({ phase, stage }) + '\n', { mode: 0o600 });
progress('before-files');
const files = async () => {
  const result = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('unexpected data symlink');
      if (entry.isDirectory()) { result.push({ name, kind: 'directory' }); await walk(`${dir}/${entry.name}`, `${name}/`); }
      else if (entry.isFile()) result.push({ name, kind: 'file', size: (await stat(`${dir}/${entry.name}`)).size });
      else throw new Error('unexpected data entry');
      if (result.length > 4096) throw new Error('data file limit');
    }
  }
  await walk(DATA_DIR);
  return result.sort((a, b) => a.name.localeCompare(b.name));
};
const before = await files();
if (phase === 'cold' && before.some(x => x.name === 'storage.sqlite')) throw new Error('cold database already exists');
if (phase === 'warm' && !before.some(x => x.name === 'storage.sqlite')) throw new Error('warm database missing');
progress('before-initialize');
await ensureDbInitialized();
progress('after-initialize');
try {
  const db = getDbInstance();
  if (db.driver !== 'node:sqlite' || !pingDb()) throw new Error('core driver or ping failed');
  const worker = resolveDbHealthWorker();
  if (worker.workerFile !== '/work/app/src/lib/db/healthCheckWorker.js' || worker.execArgv.length !== 0) throw new Error('health worker resolution mismatch');
  progress('before-worker');
  const health = await runManagedDbHealthCheck({ autoRepair: false });
  progress('after-worker');
  if (typeof health.isHealthy !== 'boolean') throw new Error('health worker result missing');
  progress('before-settings-read');
  const initial = await getSettings();
  progress('after-settings-read');
  if (phase === 'cold') {
    if (getCliVersionOverride('codex') !== null) throw new Error('unexpected initial runtime override');
    progress('before-settings-write');
    await updateSettings({ pinnedLifecycleMarker: 'cold-written', cliVersionOverrides: { codex: '1.2.3' } });
    progress('after-settings-write');
    if (getCliVersionOverride('codex') !== '1.2.3') throw new Error('runtime override was not applied');
  }
  progress('before-settings-verify');
  const persisted = await getSettings();
  progress('after-settings-verify');
  if (persisted.pinnedLifecycleMarker !== 'cold-written' || (phase === 'warm' && initial.pinnedLifecycleMarker !== 'cold-written')) throw new Error('settings persistence failed');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
  if (!tables.includes('_omniroute_migrations') || !tables.includes('db_meta')) throw new Error('migration metadata missing');
  const migrations = db.prepare('SELECT version, name FROM _omniroute_migrations ORDER BY version').all();
  if (!migrations.length) throw new Error('empty migration ledger');
  const after = await files();
  await writeFile(`/work/${phase}-lifecycle.json`, JSON.stringify({ phase, before, after, driver: db.driver, ping: true, healthWorker: true, healthy: health.isHealthy, settingsMarker: 'cold-written', runtimeSettingApplied: phase === 'cold', tables, migrations }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} finally {
  progress('before-close');
  closeDbInstance();
  progress('after-close');
}
