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
