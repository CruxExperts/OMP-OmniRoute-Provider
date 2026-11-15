// Direct core/settings research observation; not an HTTP or qualification test.
import { writeFileSync } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { ensureDbInitialized, getDbInstance, pingDb, closeDbInstance, runManagedDbHealthCheck, DATA_DIR, SQLITE_FILE } from './core';
import { getSettings, updateSettings } from './settings';
import { resolveDbHealthWorker } from './healthCheckRunner';
import { getCliVersionOverride } from '@omniroute/open-sse/config/cliVersions.ts';

import { SignJWT } from 'jose';
const phase = process.argv[2];
const sweep = phase === 'sweep-success' || phase === 'sweep-failure';
const auth = phase === 'auth-cold' || phase === 'auth-warm';
const expectedDataDir = auth ? '/work/auth-data' : sweep ? `/work/${phase}-data` : '/work/data';
if (!['cold', 'warm', 'auth-cold', 'auth-warm', 'sweep-success', 'sweep-failure'].includes(phase) || process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1' || DATA_DIR !== expectedDataDir || SQLITE_FILE !== `${expectedDataDir}/storage.sqlite`) throw new Error('lifecycle isolation or phase mismatch');
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
if (sweep) {
  if ((await files()).some(x => x.name === 'storage.sqlite')) throw new Error('sweep database already exists');
  await ensureDbInitialized();
  try {
    const db = getDbInstance();
    if (db.driver !== 'node:sqlite' || process.env.STORAGE_ENCRYPTION_KEY) throw new Error('sweep prerequisites mismatch');
    await updateSettings({ requireLogin: false });
    const marker = 'fixture-only-plaintext';
    db.prepare('INSERT INTO provider_connections (id, provider, name, provider_specific_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('sweep-fixture', 'gemini-cli', 'before', JSON.stringify({ ['api' + 'Key']: marker }), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const cache = await import('./readCache.ts');
    const initialCache = await cache.getCachedRawProviderConnections({ provider: 'gemini-cli' });
    if (initialCache.length !== 1 || initialCache[0].name !== 'before') throw new Error('sweep cache setup failed');
    db.prepare('UPDATE provider_connections SET name = ? WHERE id = ?').run('after', 'sweep-fixture');
    if (phase === 'sweep-failure') db.prepare("CREATE TRIGGER fixture_sweep_failure BEFORE UPDATE OF provider_specific_data ON provider_connections BEGIN SELECT RAISE(FAIL, 'fixture sweep failure'); END").run();
    process.env.STORAGE_ENCRYPTION_KEY = 'fixture-only-encryption-key-not-for-production';
    let nativeBackupCalls = 0;
    const nativeBackup = db.backup.bind(db);
    db.backup = (...args) => { nativeBackupCalls++; return nativeBackup(...args); };
    const route = await import('../../app/api/providers/deprecated/route.ts');
    const before = await files();
    const call = async () => {
      const response = await route.GET(new Request('http://127.0.0.1/api/providers/deprecated'));
      return { status: response.status, body: await response.json() };
    };
    const first = await call();
    const stored = () => JSON.parse(db.prepare('SELECT provider_specific_data FROM provider_connections WHERE id = ?').get('sweep-fixture').provider_specific_data).apiKey;
    const encryptedAfterFirst = typeof stored() === 'string' && stored().startsWith('enc:v1:');
    const cacheAfterFirst = await cache.getCachedRawProviderConnections({ provider: 'gemini-cli' });
    const cacheInvalidated = cacheAfterFirst.length === 1 && cacheAfterFirst[0].name === 'after';
    if (phase === 'sweep-failure') db.prepare('DROP TRIGGER fixture_sweep_failure').run();
    const second = await call();
    const encryptedAfterSecond = typeof stored() === 'string' && stored().startsWith('enc:v1:');
    const after = await files();
    const valid = result => result.status === 200 && Array.isArray(result.body.leftovers) && result.body.leftovers.length === 1 && result.body.leftovers[0].provider === 'gemini-cli' && JSON.stringify(result.body.leftovers[0].connectionIds) === '["sweep-fixture"]' && JSON.stringify(result.body.leftovers[0].names) === '["after"]' && !JSON.stringify(result.body).includes(marker);
    if (!valid(first) || !valid(second) || encryptedAfterFirst !== (phase === 'sweep-success') || encryptedAfterSecond !== encryptedAfterFirst || cacheInvalidated !== (phase === 'sweep-success')) throw new Error('sweep observation mismatch');
    const backupCount = entries => entries.filter(x => x.kind === 'file' && x.name.startsWith('db_backups/') && x.name.endsWith('.sqlite')).length;
    await writeFile(`/work/${phase}.json`, JSON.stringify({ phase, firstStatus: first.status, secondStatus: second.status, encryptedAfterFirst, encryptedAfterSecond, cacheInvalidated, nativeBackupCalls, backupCountBefore: backupCount(before), backupCountAfter: backupCount(after) }) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    delete process.env.STORAGE_ENCRYPTION_KEY;
    await closeDbInstance();
  }
  process.exit(0);
}
if (auth) {
  const cold = phase === 'auth-cold';
  const existed = (await files()).some(x => x.name === 'storage.sqlite');
  if (existed === cold) throw new Error('auth database phase mismatch');
  const { GET: authStatus } = await import('/work/app/src/app/api/auth/status/pinnedLifecycleRoute.ts');
  const status = async token => {
    globalThis.__pinnedAuthCookie = token;
    const response = await authStatus();
    const body = await response.json();
    if (response.status !== 200 || Object.keys(body).join(',') !== 'authenticated' || typeof body.authenticated !== 'boolean') throw new Error('auth status response mismatch');
    return body.authenticated;
  };
  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ authenticated: true }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(now).setExpirationTime(now + 3600).setJti('fixture-session').sign(secret);
  if (await status('invalid')) throw new Error('invalid session accepted');
  if (cold && (await files()).some(x => x.name === 'storage.sqlite')) throw new Error('invalid session initialized database');
  await ensureDbInitialized();
  try {
    const db = getDbInstance();
    if (db.driver !== 'node:sqlite') throw new Error('auth database driver mismatch');
    const rows = () => db.prepare("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('requireLogin', 'setupComplete') ORDER BY key").all();
    const expected = [{ key: 'requireLogin', value: 'true' }, { key: 'setupComplete', value: 'true' }];
    if (JSON.stringify(rows()) !== JSON.stringify(cold ? [] : expected)) throw new Error('auth onboarding before mismatch');
    if (!(await status(token)) || JSON.stringify(rows()) !== JSON.stringify(expected)) throw new Error('auth onboarding after mismatch');
    if (!cold) {
      const setAuth = db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)");
      setAuth.run('revokedDashboardSessions', JSON.stringify([{ jti: 'fixture-session', exp: now + 3600 }]));
      if (!(await status(token))) throw new Error('cached session unexpectedly revoked');
      await new Promise(resolve => setTimeout(resolve, 5100));
      if (await status(token)) throw new Error('revoked session accepted after cache expiry');
      setAuth.run('revokedDashboardSessions', '[]');
      setAuth.run('sessionsValidAfter', JSON.stringify(now + 1));
      await new Promise(resolve => setTimeout(resolve, 5100));
      if (await status(token)) throw new Error('password cutoff ignored after cache expiry');
    }
    const observation = { invalidRejected: true, validAccepted: true, databaseExistedBefore: existed, onboardingBefore: cold ? 'absent' : 'persisted', onboardingAfter: 'persisted', ...(cold ? { invalidNoDatabase: true } : { cachedRevocation: true, revocationAfterExpiry: true, passwordCutoffAfterExpiry: true }) };
    await writeFile(`/work/${phase}.json`, JSON.stringify(observation) + '\n', { flag: 'wx', mode: 0o600 });
  } finally { await closeDbInstance(); }
  process.exit(0);
}
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
  const { observeComboLifecycle } = await import('/work/fixture/combo-lifecycle.mjs');
  const comboLifecycle = await observeComboLifecycle(phase);
  await writeFile(`/work/${phase}-combo-lifecycle.json`, JSON.stringify(comboLifecycle) + '\n', { flag: 'wx', mode: 0o600 });
  // These are source handlers using the real initialized core, not ingress or
  // executor qualification. The disposable sandbox deliberately disables auth;
  // policy is independently observed by the ingress producer.
  if (phase === 'cold') {
    await updateSettings({ requireLogin: false });
    const providerStore = await import('./providers.ts');
    const providerRoute = await import('../../app/api/providers/route.ts');
    const nodeRoute = await import('../../app/api/provider-nodes/route.ts');
    const created = await providerStore.createProviderConnection({ provider: 'openai', authType: 'apikey', name: 'Native Provider Fixture', ['api' + 'Key']: 'native-fixture-secret', isActive: false });
    if (typeof created.id !== 'string') throw new Error('native provider seed failed');
    const providerCall = async (method, body) => {
      const request = new Request('http://127.0.0.1/api/providers', { method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const response = await providerRoute[method](request);
      return { status: response.status, body: await response.json() };
    };
    const listed = await providerCall('GET');
    if (listed.status !== 200 || !Array.isArray(listed.body.connections) || !listed.body.connections.some(row => row.id === created.id)) throw new Error('native provider read failed');
    if (JSON.stringify(listed.body).includes('native-fixture-secret')) throw new Error('native provider GET leaked credential');
    const invalidPatch = await providerCall('PATCH', { ids: [], isActive: true });
    if (invalidPatch.status !== 400 || (await providerStore.getProviderConnectionById(created.id))?.isActive !== false) throw new Error('native invalid provider patch changed target');
    const patched = await providerCall('PATCH', { ids: [created.id], isActive: true });
    const patchedState = await providerStore.getProviderConnectionById(created.id);
    if (patched.status !== 200 || patched.body.updated !== 1 || patchedState?.isActive !== true) throw new Error('native provider patch failed');
    const deleted = await providerCall('DELETE', { ids: [created.id] });
    if (deleted.status !== 200 || deleted.body.deleted !== 1 || await providerStore.getProviderConnectionById(created.id) !== null) throw new Error('native provider delete failed');
    const nodes = await nodeRoute.GET(new Request('http://127.0.0.1/api/provider-nodes'));
    const nodesBody = await nodes.json();
    if (nodes.status !== 200 || !Array.isArray(nodesBody.nodes) || !Number.isInteger(nodesBody.total)) throw new Error('native provider nodes read failed');
    const nodeInput = { name: 'Native Node Fixture', prefix: 'native-fixture-node', apiType: 'chat', baseUrl: 'https://example.com/v1', providerIdSuffix: 'native-fixture' };
    const nodeCreatedResponse = await nodeRoute.POST(new Request('http://127.0.0.1/api/provider-nodes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(nodeInput) }));
    const nodeCreated = await nodeCreatedResponse.json();
    const nodeStore = await import('./providers/nodes.ts');
    const persistedNode = typeof nodeCreated.node?.id === 'string' ? await nodeStore.getProviderNodeById(nodeCreated.node.id) : null;
    if (nodeCreatedResponse.status !== 201 || persistedNode?.prefix !== 'native-fixture-node') throw new Error('native provider node create failed');
    await writeFile('/work/provider-node-create.json', JSON.stringify({ status: nodeCreatedResponse.status, persisted: true, prefix: persistedNode.prefix }) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile('/work/provider-collection-lifecycle.json', JSON.stringify({ getStatus: listed.status, patchStatus: patched.status, patchCount: patched.body.updated, patchedActive: patchedState.isActive, deleteStatus: deleted.status, deleteCount: deleted.body.deleted, deletedAbsent: true, nodeGetStatus: nodes.status, nodeCount: nodesBody.total }) + '\n', { flag: 'wx', mode: 0o600 });
    const routes = {
      interception: await import('../../app/api/providers/[id]/interception-rules/route.ts'),
      filters: await import('../../app/api/providers/[id]/param-filters/route.ts'),
      alias: await import('../../app/api/providers/[id]/cc-alias/route.ts'),
    };
    const context = { params: Promise.resolve({ id: 'native-fixture' }) };
    const call = async (route, method, body) => {
      const request = new Request(`http://127.0.0.1/api/providers/native-fixture/${route}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const response = await routes[route === 'interception-rules' ? 'interception' : route === 'param-filters' ? 'filters' : 'alias'][method](request, context);
      return { status: response.status, body: await response.json() };
    };
    const results = [];
    for (const [route, body] of [
      ['interception-rules', { interceptSearch: true }],
      ['param-filters', { block: ['temperature'], allow: [], autoLearn: false }],
      ['cc-alias', { scope: 'provider', value: 'on' }],
    ]) {
      const before = await call(route, 'GET');
      const applied = await call(route, 'PUT', body);
      const after = await call(route, 'GET');
      if (before.status !== 200 || applied.status !== 200 || after.status !== 200 || JSON.stringify(before.body) === JSON.stringify(after.body)) throw new Error(`native provider lifecycle failed: ${route}`);
      results.push({ route, before, applied, after });
      if (route !== 'cc-alias') {
        const deleted = await call(route, 'DELETE');
        const restored = await call(route, 'GET');
        if (deleted.status !== 200 || restored.status !== 200 || JSON.stringify(restored.body) !== JSON.stringify(before.body)) throw new Error(`native provider delete failed: ${route}`);
        results[results.length - 1].deleted = deleted;
        results[results.length - 1].restored = restored;
      }
    }
    await writeFile('/work/provider-lifecycle.json', JSON.stringify({ phase, results }) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (phase === 'warm') {
    const alias = await import('../../app/api/providers/[id]/cc-alias/route.ts');
    const response = await alias.GET(new Request('http://127.0.0.1/api/providers/native-fixture/cc-alias'), { params: Promise.resolve({ id: 'native-fixture' }) });
    const body = await response.json();
    if (response.status !== 200 || body.provider !== 'on' || Object.keys(body.models).length !== 0) throw new Error('native provider warm read failed');
    await writeFile('/work/provider-warm.json', JSON.stringify({ status: response.status, body }) + '\n', { flag: 'wx', mode: 0o600 });
  }
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
