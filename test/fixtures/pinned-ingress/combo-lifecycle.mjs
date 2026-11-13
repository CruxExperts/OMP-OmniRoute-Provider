// Disposable native-source observation; callers must initialize the real database first.
// This is not an ingress authorization or operation qualification receipt.
import assert from 'node:assert/strict';

export async function observeComboLifecycle(phase) {
  if (!['cold', 'warm'].includes(phase) || process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1' || process.env.DATA_DIR !== '/work/data') throw new Error('combo lifecycle isolation or phase mismatch');
  const [core, keys, collection, item, reorder, duplicate, probe, auto, builder, metrics, portableImport, portableExport] = await Promise.all([
    import('/work/app/src/lib/db/core.ts'), import('/work/app/src/lib/db/apiKeys.ts'),
    import('/work/app/src/app/api/combos/route.ts'), import('/work/app/src/app/api/combos/[id]/route.ts'),
    import('/work/app/src/app/api/combos/reorder/route.ts'), import('/work/app/src/app/api/combos/duplicate/route.ts'),
    import('/work/app/src/app/api/combos/test/route.ts'), import('/work/app/src/app/api/combos/auto/route.ts'),
    import('/work/app/src/app/api/combos/builder/options/route.ts'), import('/work/app/src/app/api/combos/metrics/route.ts'),
    import('/work/app/src/app/api/combos/import/route.ts'), import('/work/app/src/app/api/combos/export/route.ts'),
  ]);
  if (core.getDbInstance().driver !== 'node:sqlite') throw new Error('combo lifecycle requires native SQLite');
  const [keyList, keyItem, proxyList, proxyManagement, models] = await Promise.all([
    import('/work/app/src/app/api/keys/route.ts'), import('/work/app/src/app/api/keys/[id]/route.ts'),
    import('/work/app/src/app/api/settings/proxies/assignments/route.ts'),
    import('/work/app/src/app/api/v1/management/proxies/assignments/route.ts'),
    import('/work/app/src/app/api/models/route.ts'),
  ]);
  const { classifyRoute } = await import('/work/app/src/server/authz/classify.ts');
  for (const path of ['/api/keys', '/api/keys/fixture-id', '/api/settings/proxies/assignments', '/api/models']) assert.equal(classifyRoute(path, 'GET').routeClass, 'MANAGEMENT');
  assert.equal(classifyRoute('/api/v1/management/proxies/assignments', 'GET').routeClass, 'CLIENT_API');
  const store = await import('/work/app/src/lib/db/combos.ts');
  const observations = [];
  let credential;
  async function request(operation, handler, path, body, id) {
    const method = operation.split(' ')[0];
    const headers = new Headers({ authorization: `Bearer ${credential}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await handler(new Request(`http://127.0.0.1:3000${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ...(id === undefined ? [] : [{ params: Promise.resolve({ id }) }]));
    const mediaType = response.headers.get('content-type') ?? '';
    assert.match(mediaType, /^application\/json(?:;|$)/i);
    const text = await response.text();
    assert.ok(Buffer.byteLength(text) <= 1048576, `${operation} response exceeds limit`);
    const data = JSON.parse(text);
    observations.push({ operation, status: response.status, mediaType: 'application/json' });
    return { response, data, text };
  }
  if (phase === 'cold') {
    const manager = await keys.createApiKey('combo-lifecycle-manager', 'combo-lifecycle-machine', ['manage']);
    assert.equal(typeof manager.key, 'string');
    credential = manager.key;
    const scoped = await keys.createApiKey('combo-lifecycle-scoped', 'combo-lifecycle-machine', [], { allowedCombos: ['Native Delete', 'combo/*'] });
    const providers = await import('/work/app/src/lib/db/providers.ts');
    const provider = await providers.createProviderConnection({ provider: 'openai', authType: 'apikey', name: 'native-fixture-provider', ['api' + 'Key']: 'native-fixture-provider-secret', isActive: true });
    assert.equal(typeof provider.id, 'string');
    const modelStore = await import('/work/app/src/lib/db/models.ts');
    await modelStore.replaceSyncedAvailableModelsForConnection('openai', provider.id, [{ id: 'gpt-4o', name: 'GPT-4o', supportedEndpoints: ['chat'], contextWindow: 128000, outputTokenLimit: 4096, supportsThinking: true }]);
    const allKeys = await request('GET /api/keys', keyList.GET, '/api/keys');
    assert.equal(allKeys.response.status, 200);
    assert.equal(allKeys.data.keys.length, allKeys.data.total);
    const grants = allKeys.data.keys.map(row => ({ id: row.id, allowedCombos: row.allowedCombos }));
    assert.deepEqual(grants.find(row => row.id === scoped.id)?.allowedCombos, ['Native Delete', 'combo/*']);
    assert.ok(!allKeys.text.includes(manager.key) && !allKeys.text.includes(scoped.key));
    const oneKey = await request('GET /api/keys/{id}', keyItem.GET, `/api/keys/${scoped.id}`, undefined, scoped.id);
    assert.equal(oneKey.response.status, 200);
    assert.deepEqual({ id: oneKey.data.id, allowedCombos: oneKey.data.allowedCombos }, { id: scoped.id, allowedCombos: ['Native Delete', 'combo/*'] });
    assert.ok(!oneKey.text.includes(scoped.key));
    const assignments = await request('GET /api/settings/proxies/assignments', proxyList.GET, '/api/settings/proxies/assignments?scope=combo');
    assert.equal(assignments.response.status, 200);
    assert.equal(assignments.data.items.length, assignments.data.total);
    const assignmentsV1 = await request('GET /api/v1/management/proxies/assignments', proxyManagement.GET, '/api/v1/management/proxies/assignments?scope=combo&limit=200&offset=0');
    assert.equal(assignmentsV1.response.status, 200);
    assert.equal(assignmentsV1.data.items.length, assignmentsV1.data.page.total);
    const projectAssignments = rows => rows.map(row => ({ scope: row.scope, scopeId: row.scopeId, proxyId: row.proxyId }));
    assert.deepEqual(projectAssignments(assignmentsV1.data.items), projectAssignments(assignments.data.items));
    const invalidPage = await request('GET /api/v1/management/proxies/assignments', proxyManagement.GET, '/api/v1/management/proxies/assignments?limit=invalid');
    assert.equal(invalidPage.response.status, 400);
    const modelList = await request('GET /api/models', models.GET, '/api/models?withLimits=1');
    assert.equal(modelList.response.status, 200);
    assert.ok(Array.isArray(modelList.data.models));
    const projectedModels = modelList.data.models.map(row => ({ fullModel: row.fullModel, supportsVision: row.supportsVision, contextWindow: row.contextWindow ?? null, maxInputTokens: row.maxInputTokens ?? null, maxOutputTokens: row.maxOutputTokens ?? null }));
    assert.ok(projectedModels.every(row => typeof row.fullModel === 'string' && typeof row.supportsVision === 'boolean'));
    const invalidModels = await request('GET /api/models', models.GET, '/api/models?withLimits=invalid');
    assert.equal(invalidModels.response.status, 400);
    const created = await request('POST /api/combos', collection.POST, '/api/combos', { name: 'Native Delete', models: ['fixture/chat'] });
    assert.equal(created.response.status, 201);
    const id = created.data.id;
    assert.equal(typeof id, 'string');
    const proxies = await import('/work/app/src/lib/db/proxies.ts');
    const proxy = await proxies.createProxy({ name: 'native-fixture-proxy', type: 'http', host: '127.0.0.1', port: 1 });
    await proxies.assignProxyToScope('combo', id, proxy.id);
    const assigned = await request('GET /api/settings/proxies/assignments', proxyList.GET, `/api/settings/proxies/assignments?scope=combo&scopeId=${encodeURIComponent(id)}`);
    assert.deepEqual(projectAssignments(assigned.data.items), [{ scope: 'combo', scopeId: id, proxyId: proxy.id }]);
    const assignedV1 = await request('GET /api/v1/management/proxies/assignments', proxyManagement.GET, `/api/v1/management/proxies/assignments?scope=combo&scope_id=${encodeURIComponent(id)}`);
    assert.equal(assignedV1.data.page.total, 1);
    assert.deepEqual(projectAssignments(assignedV1.data.items), projectAssignments(assigned.data.items));
    const sentinel = 'fixture-export-secret';
    const extra = await request('POST /api/combos', collection.POST, '/api/combos', { name: 'Native Keep', models: ['fixture/chat'], config: { ['api' + 'Key']: sentinel } });
    assert.equal(extra.response.status, 201);
    assert.equal((await store.getComboById(extra.data.id)).config.apiKey, sentinel);
    const updated = await request('PATCH /api/combos/{id}', item.PATCH, `/api/combos/${id}`, { description: 'patched' }, id);
    assert.equal(updated.response.status, 200);
    const replaced = await request('PUT /api/combos/{id}', item.PUT, `/api/combos/${id}`, { description: 'updated' }, id);
    assert.equal(replaced.response.status, 200);
    const selected = await request('GET /api/combos/{id}', item.GET, `/api/combos/${id}`, undefined, id);
    assert.equal(selected.response.status, 200);
    assert.equal(selected.data.description, 'updated');
    const list = await request('GET /api/combos', collection.GET, '/api/combos');
    assert.equal(list.response.status, 200);
    assert.ok(list.data.combos.some(row => row.id === id));
    const order = list.data.combos.map(row => row.id).reverse();
    const ordered = await request('POST /api/combos/reorder', reorder.POST, '/api/combos/reorder', { comboIds: order });
    assert.equal(ordered.response.status, 200);
    assert.deepEqual((await store.getCombos()).map(row => row.id), order);
    const exported = await request('GET /api/combos/export', portableExport.GET, '/api/combos/export');
    assert.equal(exported.response.status, 200);
    assert.equal(exported.data._meta.version, 'omniroute-combos-v1');
    assert.ok(!exported.text.includes(sentinel));
    const imported = await request('POST /api/combos/import', portableImport.POST, '/api/combos/import', { mode: 'merge', combos: [{ name: 'Native Imported', models: ['fixture/chat'] }] });
    assert.equal(imported.response.status, 200);
    assert.ok(imported.data.created.includes('Native Imported'));
    const invalidImport = await request('POST /api/combos/import', portableImport.POST, '/api/combos/import', { mode: 'replace', combos: [] });
    assert.equal(invalidImport.response.status, 400);
    assert.ok((await store.getCombos()).some(row => row.name === 'Native Imported'));
    const removed = await request('DELETE /api/combos/{id}', item.DELETE, `/api/combos/${id}`, undefined, id);
    assert.equal(removed.response.status, 200);
    assert.equal(await store.getComboById(id), null);
    const afterAssignment = await request('GET /api/settings/proxies/assignments', proxyList.GET, `/api/settings/proxies/assignments?scope=combo&scopeId=${encodeURIComponent(id)}`);
    assert.equal(afterAssignment.data.total, 0);
    assert.deepEqual(afterAssignment.data.items, []);
    const afterGrant = await request('GET /api/keys/{id}', keyItem.GET, `/api/keys/${scoped.id}`, undefined, scoped.id);
    assert.deepEqual(afterGrant.data.allowedCombos, ['combo/*']);
    const scopedAfter = await keys.getApiKeyById(scoped.id);
    assert.deepEqual(scopedAfter.allowedCombos, ['combo/*']);
    const replaceScoped = await keys.createApiKey('combo-lifecycle-replace', 'combo-lifecycle-machine', [], { allowedCombos: ['Native Keep', 'Native Imported', 'combo/*'] });
    const replacement = await request('POST /api/combos/import', portableImport.POST, '/api/combos/import', { mode: 'replace', combos: [{ name: 'Native Imported', models: ['fixture/chat'] }] });
    assert.equal(replacement.response.status, 200);
    assert.ok(replacement.data.removed >= 2);
    assert.deepEqual((await store.getCombos()).map(row => row.name), ['Native Imported']);
    const replaceGrants = await keys.getApiKeyById(replaceScoped.id);
    assert.deepEqual(replaceGrants.allowedCombos, ['Native Imported', 'combo/*']);
    await assert.rejects(store.importCombos([{ name: 'duplicate', models: ['fixture/chat'] }, { name: 'duplicate', models: ['fixture/chat'] }], { replaceVisible: true }));
    assert.deepEqual((await store.getCombos()).map(row => row.name), ['Native Imported']);
    assert.deepEqual((await keys.getApiKeyById(replaceScoped.id)).allowedCombos, ['Native Imported', 'combo/*']);
    const catalog = await request('GET /api/combos/auto', auto.GET, '/api/combos/auto');
    assert.equal(catalog.response.status, 200);
    const options = await request('GET /api/combos/builder/options', builder.GET, '/api/combos/builder/options');
    assert.equal(options.response.status, 200);
    const duplicated = await request('POST /api/combos/duplicate', duplicate.POST, '/api/combos/duplicate', { name: 'auto/best-coding' });
    assert.equal(duplicated.response.status, 201);
    const duplicatedRow = await store.getComboById(duplicated.data.id);
    assert.ok(duplicatedRow && duplicatedRow.name.startsWith('static-best-coding') && duplicatedRow.models.length > 0);
    const metric = await request('GET /api/combos/metrics', metrics.GET, '/api/combos/metrics?combo=Native%20Keep');
    assert.equal(metric.response.status, 200);
    const reset = await request('DELETE /api/combos/metrics', metrics.DELETE, '/api/combos/metrics?combo=Native%20Keep');
    assert.equal(reset.response.status, 200);
    const invalidDuplicate = await request('POST /api/combos/duplicate', duplicate.POST, '/api/combos/duplicate', { name: 'auto/not-a-built-in-template' });
    assert.equal(invalidDuplicate.response.status, 422);
    const invalidProbe = await request('POST /api/combos/test', probe.POST, '/api/combos/test', { comboName: 'missing-combo' });
    assert.equal(invalidProbe.response.status, 404);
    return { phase, driver: 'node:sqlite', observations, grantAfterDelete: scopedAfter.allowedCombos, deletedAbsent: true, importedPersisted: true, exportSecretAbsent: true };
  }
  const stored = await store.getCombos();
  assert.ok(stored.some(row => row.name === 'Native Imported'));
  assert.ok(!stored.some(row => row.name === 'Native Delete'));
  return { phase, driver: 'node:sqlite', importedPersisted: true, deletedAbsent: true };
}
