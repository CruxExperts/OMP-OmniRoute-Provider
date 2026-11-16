// Executed only inside the reviewed private, loopback-only ingress sandbox.
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { projectMfaStatus } from '/work/fixture/mfa-response.mjs';

if (process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1') throw new Error('INGRESS_SANDBOX_REQUIRED');
const dir = '/work/data';
const port = 43179;
const secret = 'research-only-jwt-secret-32-byte-minimum';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const payload = `${encode({ alg: 'HS256' })}.${encode({ authenticated: true, iat: now, exp: now + 3600, jti: 'fixture-session' })}`;
const cookie = `auth_token=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
const db = new DatabaseSync(`${dir}/metrics.sqlite`);
db.exec(`CREATE TABLE usage_history (provider TEXT, combo_strategy TEXT, tokens_input INTEGER, tokens_cache_read INTEGER, tokens_cache_creation INTEGER);
  INSERT INTO usage_history VALUES ('alpha', NULL, 100, 50, 10), ('alpha', 'round-robin', 40, 0, 0), ('beta', 'round-robin', 200, 100, 0);`);
const statusDb = new DatabaseSync(`${dir}/auth-status.sqlite`);
statusDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const mfaDb = new DatabaseSync(`${dir}/mfa-status.sqlite`);
mfaDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const ssoDb = new DatabaseSync(`${dir}/sso-config.sqlite`);
ssoDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const loginDb = new DatabaseSync(`${dir}/login-settings.sqlite`);
loginDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const scopedTokens = Object.fromEntries(['read', 'write', 'admin'].map(scope => [scope, `oma_live_fixture_${scope}_only`]));
const managementKeys = Object.fromEntries(['read', 'write', 'admin', 'manage'].map(scope => [scope, `fixture_api_key_${scope}`]));
const ownedProbe = '/work/fixture/acp-owned-probe';
const state = { bypass: 'disabled', settings: { requireLogin: true, password: 'fixture-configured', setupComplete: true, customAgents: [{ id: 'owned', name: 'owned', binary: ownedProbe, versionCommand: `${ownedProbe} --version`, providerAlias: 'owned', spawnArgs: [], protocol: 'stdio' }] }, tokens: Object.entries(scopedTokens).map(([scope, token]) => ({ id: `fixture-${scope}`, token_hash: createHash('sha256').update(token).digest('hex'), token_prefix: 'oma_live_fixtu', name: `fixture-${scope}`, scope, created_at: '2025-01-01T00:00:00.000Z', last_used_at: null, expires_at: null, revoked_at: null })), apiKeys: Object.entries(managementKeys).map(([scope, key]) => ({ id: `key-${scope}`, key_hash: createHash('sha256').update(key).digest('hex'), is_active: 1, is_banned: 0, scopes: JSON.stringify([scope]) })) };
await writeFile(`${dir}/state.json`, JSON.stringify(state), { mode: 0o600 });
await writeFile(`${dir}/events.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/auth-status-reads.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/sso-config-reads.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/login-settings-reads.jsonl`, '', { mode: 0o600 });
const child = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret, INITIAL_PASSWORD: 'fixture-only-initial-password' }, stdio: ['ignore', 'inherit', 'inherit'],
});
const acpChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/fixture/acp-server.mjs'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret }, stdio: ['ignore', 'inherit', 'inherit'],
});
function assert(condition, name) { if (!condition) throw new Error(`INGRESS_ASSERTION:${name}`); }
async function ready(target = child, targetPort = port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert(target.exitCode === null && target.signalCode === null, 'server-exited');
    const open = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port: targetPort }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (open) return;
    await delay(100);
  }
  throw new Error('INGRESS_START_TIMEOUT');
}
async function request(path, method = 'GET', headers = {}, targetPort = port) {
  const response = await fetch(`http://127.0.0.1:${targetPort}${path}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const reader = response.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new Error('INGRESS_BODY_LIMIT'); }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, routeClass: response.headers.get('x-omniroute-route-class'), requestId: response.headers.get('x-request-id'), cacheControl: response.headers.get('cache-control'), contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'), text, body };
}
async function transition(path, status) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, 'transition-server-exited');
    const response = await request(path);
    if (response.status === status) return response;
    await delay(50);
  }
  throw new Error(`INGRESS_TRANSITION_TIMEOUT:${path}:${status}`);
}
async function stop(target = child) {
  if (target.exitCode !== null || target.signalCode !== null) return;
  const exited = new Promise(resolve => target.once('exit', resolve));
  target.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) return;
  target.kill('SIGKILL');
  assert(await Promise.race([exited.then(() => true), delay(2000).then(() => false)]), 'server-stop');
}
const results = [];
try {
  await ready();
  await ready(acpChild, 43180);
  const statusPath = '/api/auth/status';
  const statusRows = () => statusDb.prepare("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin') ORDER BY key").all();
  const statusBefore = statusRows();
  const statusCases = {};
  async function statusCase(name, headers, expected) {
    const response = await request(statusPath, 'GET', headers);
    assert(response.status === 200 && JSON.stringify(response.body) === JSON.stringify({ authenticated: expected }) && response.routeClass === 'PUBLIC', `auth-status:${name}`);
    statusCases[name] = { status: response.status, routeClass: response.routeClass, authenticated: response.body.authenticated };
  }
  const expiredPayload = `${encode({ alg: 'HS256' })}.${encode({ authenticated: true, iat: now - 100, exp: now - 1 })}`;
  const expiredCookie = `auth_token=${expiredPayload}.${createHmac('sha256', secret).update(expiredPayload).digest('base64url')}`;
  const signatureStart = cookie.lastIndexOf('.') + 1;
  const tamperedCookie = `${cookie.slice(0, signatureStart)}${cookie[signatureStart] === 'A' ? 'B' : 'A'}${cookie.slice(signatureStart + 1)}`;
  await statusCase('anonymous', {}, false);
  await statusCase('expired', { cookie: expiredCookie }, false);
  await statusCase('invalid', { cookie: 'auth_token=invalid' }, false);
  await statusCase('tampered', { cookie: tamperedCookie }, false);
  assert(statusRows().length === 0, 'auth-status-no-invalid-writes');
  const invalidSettingsReads = (await readFile(`${dir}/auth-status-reads.jsonl`, 'utf8')).split('\n').filter(Boolean).length;
  assert(invalidSettingsReads === 0, 'auth-status-no-invalid-reads');
  await statusCase('valid', { cookie }, true);
  const statusAfter = statusRows();
  assert(JSON.stringify(statusBefore) === '[]' && JSON.stringify(statusAfter) === JSON.stringify([{key:'requireLogin',value:'true'},{key:'setupComplete',value:'true'}]), 'auth-status-onboarding');
  const setStatus = statusDb.prepare("INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings',?,?)");
  setStatus.run('revokedDashboardSessions', JSON.stringify([{jti:'fixture-session',exp:now+3600}]));
  await statusCase('cachedRevocation', { cookie }, true);
  await delay(5100);
  await statusCase('revoked', { cookie }, false);
  setStatus.run('revokedDashboardSessions', '[]');
  setStatus.run('sessionsValidAfter', JSON.stringify(now+1));
  await delay(5100);
  await statusCase('passwordChanged', { cookie }, false);
  statusDb.exec('DROP TABLE key_value');
  await delay(5100);
  await statusCase('settingsFailure', { cookie }, false);
  const authStatusHttp = { cases: statusCases, invalidSettingsReads, onboardingBefore: statusBefore, onboardingAfter: statusAfter };
  const ssoPath = '/api/auth/sso/config';
  const ssoCases = {};
  const ssoCall = async (name, headers = {}) => {
    const response = await request(ssoPath, 'GET', headers);
    assert(response.status === 200 && response.routeClass === 'PUBLIC' && response.contentType === 'application/json' && !response.text.includes('fixture-private'), `sso:${name}`);
    ssoCases[name] = { status: response.status, routeClass: response.routeClass, contentType: response.contentType, body: response.body, privateMarkerPresent: response.text.includes('fixture-private') };
  };
  await ssoCall('anonymous');
  await ssoCall('invalid', { authorization: 'Bearer [REDACTED:auth_header]', cookie: 'auth_token=fixture-private-invalid' });
  const ssoSet = ssoDb.prepare("INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings',?,?)");
  for (const [key, value] of Object.entries({ entraSsoEnabled: true, entraTenantId: ' tenant.example ', entraApiAudience: ' api://fixture-audience ', entraClientId: ' fixture-client ', entraAuthorityHost: ' https://login.example.test/// ', entraGraphClientSecret: 'fixture-private-secret', entraGroupMappings: [{ groupId: 'fixture-private-group', keyGroupId: 'fixture-private-key' }] })) ssoSet.run(key, JSON.stringify(value));
  await ssoCall('cached');
  await delay(5100);
  await ssoCall('enabled');
  ssoSet.run('entraApiAudience', JSON.stringify(''));
  await delay(5100);
  await ssoCall('incomplete');
  ssoDb.exec('DROP TABLE key_value');
  await delay(5100);
  await ssoCall('failure');
  const ssoConfigHttp = { cases: ssoCases };
  const loginCases = {};
  const loginCall = async (name, headers = {}) => {
    const response = await request('/api/settings/require-login', 'GET', headers);
    assert(response.status === 200 && response.routeClass === 'PUBLIC' && response.contentType === 'application/json' && !response.text.includes('fixture-private'), `require-login:${name}`);
    loginCases[name] = { status: response.status, routeClass: response.routeClass, contentType: response.contentType, body: response.body, privateMarkerPresent: response.text.includes('fixture-private') };
  };
  const loginRows = () => loginDb.prepare("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin') ORDER BY key").all();
  const loginBefore = loginRows();
  await loginCall('anonymous');
  const loginAfter = loginRows();
  await loginCall('invalid', { authorization: 'Bearer [REDACTED:auth_header]', cookie: 'auth_token=fixture-private-invalid' });
  await loginCall('valid', { cookie });
  const loginSet = loginDb.prepare("INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings',?,?)");
  loginSet.run('oidcEnabled', 'true');
  loginSet.run('oidcClientSecret', JSON.stringify('fixture-private-secret'));
  loginDb.prepare("INSERT INTO key_value (namespace,key,value) VALUES ('feature_flags','OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN','yes')").run();
  await delay(1100);
  await loginCall('configured');
  loginDb.exec('DROP TABLE key_value');
  await loginCall('failure');
  const requireLoginHttp = { cases: loginCases, onboardingBefore: loginBefore, onboardingAfter: loginAfter };
  const mfaPath = '/api/auth/mfa/status';
  const mfaCases = {};
  const mfaCredentials = { anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, ...Object.fromEntries(Object.entries(managementKeys).map(([name, key]) => [`key-${name}`, { authorization: `Bearer ${key}` }])), ...Object.fromEntries(Object.entries(scopedTokens).map(([name, key]) => [`oma-${name}`, { authorization: `Bearer ${key}` }])) };
  for (const [name, headers] of Object.entries(mfaCredentials)) {
    const response = await request(mfaPath, 'GET', headers);
    mfaCases[name] = { status: response.status, routeClass: response.routeClass, cacheControl: response.cacheControl, contentType: response.status === 200 ? response.contentType : null, body: response.status === 200 ? projectMfaStatus(response.body) : null };
  }
  const mfaRow = JSON.stringify({ enabled: true, secret: 'fixture-private-seed', backupCodeHashes: ['fixture-private-hash'], lastTotpCounter: 42, enabledAt: '2025-01-01T00:00:00.000Z' });
  mfaDb.prepare("INSERT INTO key_value (namespace, key, value) VALUES ('dashboardMfa', 'state', ?)").run(mfaRow);
  const enrolled = await request(mfaPath, 'GET', { authorization: `Bearer ${managementKeys.manage}` });
  const persisted = mfaDb.prepare("SELECT value FROM key_value WHERE namespace = 'dashboardMfa' AND key = 'state'").get();
  const mfaEnrolled = { status: enrolled.status, routeClass: enrolled.routeClass, cacheControl: enrolled.cacheControl, contentType: enrolled.contentType, body: projectMfaStatus(enrolled.body), privateMarkerPresent: enrolled.text.includes('fixture-private'), rowUnchanged: persisted?.value === mfaRow };
  await writeFile(`${dir}/mfa-status-fail`, '', { mode: 0o600 });
  const mfaFailure = await request(mfaPath, 'GET', { authorization: `Bearer ${managementKeys.manage}` });
  const mfaStatusHttp = { cases: mfaCases, enrolled: mfaEnrolled, failure: { status: mfaFailure.status, routeClass: mfaFailure.routeClass, cacheControl: mfaFailure.cacheControl, privateMarkerPresent: mfaFailure.text.includes('private MFA backend failure') } };
  const acpCases = {};
  const unstamped = await request('/api/acp/agents', 'GET', { cookie });
  console.log('ACP_UNSTAMPED', unstamped.status, unstamped.routeClass);
  const acpCredentials = { anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, ...Object.fromEntries(Object.entries(managementKeys).map(([name, key]) => [`key-${name}`, { authorization: `Bearer ${key}` }])), ...Object.fromEntries(Object.entries(scopedTokens).map(([name, key]) => [`oma-${name}`, { authorization: `Bearer ${key}` }])) };
  for (const [name, headers] of Object.entries(acpCredentials)) {
    const response = await request('/api/acp/agents', 'GET', headers, 43180);
    const owned = response.body?.agents?.find(agent => agent.id === 'owned');
    acpCases[name] = { status: response.status, routeClass: response.routeClass, owned: owned ? { installed: owned.installed, version: owned.version } : null };
    console.log('ACP_CASE', name, response.status, response.routeClass, owned ? (owned.installed ? 'installed' : 'not-installed') : 'no-agent');
  }
  const probeRecords = (await readFile(`${dir}/acp-probe.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(probeRecords.every(record => JSON.stringify(record) === JSON.stringify({ argv: ['--version'], cwd: dir, env: { PATH: '', HOME: '/work/home', TMPDIR: '/work/tmp' } })), 'acp-probe-boundary');
  const acpHttp = { cases: acpCases, unstampedSessionStatus: unstamped.status, probeCount: probeRecords.length, processPlatform: process.platform };
  const config = JSON.parse(await readFile('/work/app/.build/next/server/functions-config-manifest.json', 'utf8'));
  const matchers = config.functions?.['/_middleware']?.matchers;
  assert(Array.isArray(matchers) && matchers.length > 0 && matchers.every(entry => typeof entry.regexp === 'string'), 'proxy-matchers-present');
  const livenessMatcherMatched = matchers.some(entry => new RegExp(entry.regexp).test('/livez'));
  assert(!livenessMatcherMatched, 'livez-proxy-matcher');
  const wellKnown = [];
  for (const path of ['/.well-known/agent-card.json', '/.well-known/agent.json']) {
    const matcherMatched = matchers.some(entry => new RegExp(entry.regexp).test(path));
    const response = await request(path);
    const v1 = path.endsWith('agent-card.json');
    assert(!matcherMatched && response.status === 200 && response.contentType === 'application/json' && response.cacheControl === 'public, max-age=3600' && response.routeClass === null && response.requestId === null, `well-known-ingress:${path}`);
    assert(response.body?.name === 'OmniRoute AI Gateway', `well-known-name:${path}`);
    assert(response.body?.url === `http://localhost:${port}/a2a`, `well-known-url:${path}`);
    assert(response.body?.version === '3.8.53', `well-known-version:${path}:${response.body?.version}`);
    assert(response.body?.skills?.length === 6, `well-known-skills:${path}:${response.body?.skills?.length}`);
    assert(Boolean(response.body?.[v1 ? 'supportedInterfaces' : 'authentication']) && !response.body?.[v1 ? 'authentication' : 'supportedInterfaces'], `well-known-envelope:${path}`);
    wellKnown.push({ path, matcherMatched, response });
  }
  const liveInvalid = ['oma', 'live', 'unknownfixture'].join('_');
  const liveness = {};
  for (const [name, headers] of [['anonymous', {}], ['invalidCredential', { authorization: `Bearer ${liveInvalid}` }], ['session', { cookie }]]) {
    const response = await request('/livez', 'GET', headers);
    assert(response.status === 200 && response.text === 'ok\n' && response.contentType === 'text/plain; charset=utf-8' && response.cacheControl === 'no-store' && response.contentLength === '3' && response.routeClass === null, `livez:${name}`);
    liveness[name] = { status: response.status, body: response.text, contentType: response.contentType, cacheControl: response.cacheControl, contentLength: response.contentLength, routeClass: response.routeClass };
  }
  const livenessHead = {};
  for (const [name, headers] of [['anonymous', {}], ['invalidCredential', { authorization: `Bearer ${liveInvalid}` }], ['session', { cookie }]]) {
    const response = await request('/livez', 'HEAD', headers);
    assert(response.status === 200 && response.text === '' && response.contentType === 'text/plain; charset=utf-8' && response.cacheControl === 'no-store' && response.contentLength === '3' && response.routeClass === null, `livez:HEAD:${name}`);
    livenessHead[name] = { status: response.status, body: response.text, contentType: response.contentType, cacheControl: response.cacheControl, contentLength: response.contentLength, routeClass: response.routeClass };
  }
  for (const path of ['/api/health', '/api/health/ping']) {
    const response = await request(path);
    assert(response.status === 200 && response.body?.status === 'ok' && typeof response.body?.timestamp === 'string', `health:${path}`);
    assert(response.cacheControl?.includes('no-store'), `cache-control:${path}`);
    if (path.endsWith('/ping')) assert(typeof response.body.latencyMs === 'number' && response.body.latencyMs >= 0, 'ping-latency');
    results.push({ case: `public GET ${path}`, response });
  }
  for (const method of ['GET', 'DELETE']) {
    const path = '/api/settings/cache-metrics';
    const denied = await request(path, method);
    assert(denied.status === 401 || denied.status === 403, `denied:${method}`);
    const invalidCredential = ['oma', 'live', 'unknownfixture'].join('_');
    const invalid = await request(path, method, { authorization: `Bearer ${invalidCredential}` });
    assert(invalid.status === 401 || invalid.status === 403, `invalid:${method}`);
    assert(!JSON.stringify(invalid.body).includes(invalidCredential), `redaction:${method}`);
    const allowed = await request(path, method, { cookie });
    assert(allowed.status === 200 && allowed.body?.totalRequests === 3 && allowed.body?.requestsWithCacheControl === 2 && allowed.body?.totalInputTokens === 300 && allowed.body?.totalCachedTokens === 150 && allowed.body?.totalCacheCreationTokens === 10 && allowed.body?.byProvider?.alpha?.totalRequests === 2 && allowed.body?.byStrategy?.direct?.cachedTokens === 50, `metrics:${method}`);
    const count = db.prepare('SELECT count(*) AS count FROM usage_history').get().count;
    assert(count === 3, `history-preserved:${method}`);
    results.push({ case: `${method} ${path}`, denied, invalid, allowed, usageRowsAfter: count });
  }
  db.exec('DROP TABLE usage_history');
  const fallback = await request('/api/settings/cache-metrics', 'GET', { cookie });
  assert(fallback.status === 200 && fallback.body?.totalRequests === 0 && fallback.body?.totalCachedTokens === 0 && Object.keys(fallback.body?.byProvider ?? {}).length === 0, 'metrics-query-fallback');
  results.push({ case: 'GET cache-metrics missing usage_history', response: fallback, boundary: 'disposable SQLite query failure' });
  child.kill('SIGUSR2');
  const draining = await transition('/api/health', 503);
  child.kill('SIGUSR2');
  const recovered = await transition('/api/health', 200);
  results.push({ case: 'drain-transition GET /api/health', draining, recovered });
  const degradationPath = '/api/health/degradation';
  const invalidCredential = ['oma', 'live', 'unknownfixture'].join('_');
  const denied = await request(degradationPath);
  const invalid = await request(degradationPath, 'GET', { authorization: `Bearer ${invalidCredential}` });
  assert([401, 403].includes(denied.status) && [401, 403].includes(invalid.status) && denied.routeClass === 'MANAGEMENT' && invalid.routeClass === 'MANAGEMENT' && !JSON.stringify(invalid.body).includes(invalidCredential), 'degradation-denials');
  const empty = await request(degradationPath, 'GET', { cookie });
  assert(empty.status === 200 && empty.body?.active === false && empty.body?.features?.length === 0, 'degradation-empty');
  async function control(command) {
    await writeFile(`${dir}/degradation-control`, command, { mode: 0o600 });
    assert(child.kill('SIGUSR1'), 'degradation-control-signal');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      assert(child.exitCode === null && child.signalCode === null, 'degradation-control-server-exited');
      if ((await readFile(`${dir}/events.jsonl`, 'utf8')).includes(`"event":"degradation:${command}"`)) return;
      await delay(50);
    }
    throw new Error(`DEGRADATION_CONTROL_TIMEOUT:${command}`);
  }
  await control('populate');
  const populated = await request(degradationPath, 'GET', { cookie });
  const summary = await request(`${degradationPath}?summary=true`, 'GET', { cookie });
  const falseSummary = await request(`${degradationPath}?summary=false`, 'GET', { cookie });
  const capitalSummary = await request(`${degradationPath}?summary=True`, 'GET', { cookie });
  await control('recover');
  const recovery = await request(degradationPath, 'GET', { cookie });
  assert([empty, populated, summary, falseSummary, capitalSummary, recovery].every(response => response.routeClass === 'MANAGEMENT'), 'degradation-route-class');
  results.push({ case: 'GET /api/health/degradation', denied, invalid, empty, populated, summary, falseSummary, capitalSummary, recovery });
  const skillsPath = '/api/agent-skills?category=config&area=config-codex-cli';
  const skillsDenied = await request(skillsPath);
  const skillsInvalid = await request(skillsPath, 'GET', { authorization: `Bearer ${invalidCredential}` });
  const skillsAllowed = await request(skillsPath, 'GET', { cookie });
  assert(skillsDenied.status === 401 && skillsInvalid.status === 401 && !JSON.stringify(skillsInvalid.body).includes(invalidCredential), 'agent-skills-denials');
  assert([skillsDenied, skillsInvalid, skillsAllowed].every(response => response.routeClass === 'MANAGEMENT') && skillsAllowed.status === 200 && skillsAllowed.body?.count === 1 && skillsAllowed.body?.skills?.[0]?.id === 'config-codex-cli', 'agent-skills-query');
  results.push({ case: 'GET /api/agent-skills', denied: skillsDenied, invalid: skillsInvalid, allowed: skillsAllowed });
  for (const path of ['/api/agent-skills/config-codex-cli', '/api/agent-skills/coverage']) {
    const denied = await request(path);
    const invalid = await request(path, 'GET', { authorization: `Bearer ${invalidCredential}` });
    const allowed = await request(path, 'GET', { cookie });
    assert(denied.status === 401 && invalid.status === 401 && allowed.status === 200 && [denied, invalid, allowed].every(response => response.routeClass === 'MANAGEMENT') && !JSON.stringify(invalid.body).includes(invalidCredential), `agent-skills-read:${path}`);
    if (path.endsWith('/coverage')) assert(Number.isInteger(allowed.body?.totalSkills) && allowed.body?.api && allowed.body?.cli && allowed.body?.config, 'agent-skills-coverage');
    else assert(allowed.body?.id === 'config-codex-cli', 'agent-skills-detail');
    results.push({ case: `GET ${path}`, denied, invalid, allowed });
  }
  const reasoningPath = '/api/settings/reasoning-routing-rules';
  const reasoningDenied = await request(reasoningPath);
  const reasoningInvalid = await request(reasoningPath, 'GET', { authorization: `Bearer ${invalidCredential}` });
  const reasoningFailure = await request(reasoningPath, 'GET', { cookie });
  assert(reasoningDenied.status === 401 && reasoningInvalid.status === 401 && !reasoningInvalid.text.includes(invalidCredential), 'reasoning-denials');
  const privateMarkerPresent = ['INGRESS_PRIVATE_REASONING_FAULT', '/work/', 'SQLITE_', 'reasoning_routing_rules', 'no such table'].some(marker => reasoningFailure.text.includes(marker));
  assert(reasoningFailure.status >= 500 && !privateMarkerPresent, 'reasoning-failure-privacy');
  let bodyCategory = 'empty';
  if (reasoningFailure.text !== '') {
    try { JSON.parse(reasoningFailure.text); bodyCategory = 'json'; } catch { bodyCategory = 'text'; }
  }
  const reasoningFailureObservation = { status: reasoningFailure.status, routeClass: reasoningFailure.routeClass, contentType: reasoningFailure.contentType, bodyCategory, privateMarkerPresent };
  db.exec('CREATE TABLE reasoning_routing_rules (id TEXT, priority INTEGER, created_at TEXT)');
  const reasoningAllowed = await request(reasoningPath, 'GET', { cookie });
  const reasoningCached = await request(reasoningPath, 'GET', { cookie });
  assert(reasoningAllowed.status === 200 && JSON.stringify(reasoningAllowed.body) === '{"rules":[]}' && reasoningCached.status === 200 && JSON.stringify(reasoningCached.body) === '{"rules":[]}', 'reasoning-recovery-cache');
  const reasoningHttp = { denied: { status: reasoningDenied.status, routeClass: reasoningDenied.routeClass }, invalid: { status: reasoningInvalid.status, routeClass: reasoningInvalid.routeClass }, failure: reasoningFailureObservation, allowed: { status: reasoningAllowed.status, routeClass: reasoningAllowed.routeClass, body: reasoningAllowed.body }, cached: { status: reasoningCached.status, routeClass: reasoningCached.routeClass, body: reasoningCached.body } };
  const deprecatedPath = '/api/providers/deprecated';
  const deprecatedDenied = await request(deprecatedPath);
  const deprecatedInvalid = await request(deprecatedPath, 'GET', { authorization: `Bearer ${invalidCredential}` });
  const deprecatedFailure = await request(deprecatedPath, 'GET', { cookie });
  const privateDeprecatedFailure = ['fixture_deprecated_providers', 'SQLITE_', '/work/', 'no such table'].some(marker => deprecatedFailure.text.includes(marker));
  assert(deprecatedDenied.status === 401 && deprecatedInvalid.status === 401 && deprecatedFailure.status >= 500 && deprecatedFailure.status <= 599 && [null, 'MANAGEMENT'].includes(deprecatedFailure.routeClass) && !privateDeprecatedFailure, 'deprecated-handler-denial-or-failure');
  db.exec('CREATE TABLE fixture_deprecated_providers (id TEXT, provider TEXT, name TEXT, priority INTEGER)');
  const insertDeprecated = db.prepare('INSERT INTO fixture_deprecated_providers VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 105; index++) insertDeprecated.run(`fixture-${index}`, 'gemini-cli', `name-${index}`, index);
  insertDeprecated.run('ignored', 'openai', 'ignored', 106);
  const deprecatedAllowed = await request(deprecatedPath, 'GET', { cookie });
  const group = deprecatedAllowed.body?.leftovers?.[0];
  assert(deprecatedAllowed.status === 200 && deprecatedAllowed.body?.leftovers?.length === 1 && group?.provider === 'gemini-cli' && group?.migrateTo === 'gemini' && group?.connectionIds?.length === 105 && group?.names?.length === 105 && group.connectionIds.every((id, index) => id === `fixture-${index}` && group.names[index] === `name-${index}`), 'deprecated-handler-projection');
  const deprecatedHttp = { denied: { status: deprecatedDenied.status, routeClass: deprecatedDenied.routeClass }, invalid: { status: deprecatedInvalid.status, routeClass: deprecatedInvalid.routeClass }, failure: { status: deprecatedFailure.status, routeClass: deprecatedFailure.routeClass, privateMarkerPresent: privateDeprecatedFailure }, allowed: { status: deprecatedAllowed.status, routeClass: deprecatedAllowed.routeClass, body: deprecatedAllowed.body } };
  for (const [method, path] of [['GET', '/api/model-combo-mappings'], ['POST', '/api/model-combo-mappings'], ['GET', '/api/model-combo-mappings/fixture-id'], ['PUT', '/api/model-combo-mappings/fixture-id'], ['DELETE', '/api/model-combo-mappings/fixture-id']]) {
    const denied = await request(path, method);
    const invalid = await request(path, method, { authorization: `Bearer ${invalidCredential}` });
    const allowed = await request(path, method, { cookie });
    assert(denied.status === 401 && invalid.status === 401 && allowed.status === 200 && allowed.body?.fixture === 'management-handler-reached' && [denied, invalid, allowed].every(response => response.routeClass === 'MANAGEMENT'), `mapping-policy:${method}:${path}`);
    results.push({ case: `${method} ${path}`, denied, invalid, allowed });
  }
  // These exact method/path cases observe policy reachability, not actual handlers.
  const familyPolicyCases = [
    ['DELETE', '/api/combos/metrics'],
    ['DELETE', '/api/combos/fixture-id'],
    ['DELETE', '/api/fallback/chains'],
    ['DELETE', '/api/model-capability-overrides'],
    ['DELETE', '/api/providers'],
    ['DELETE', '/api/providers/fixture-id/interception-rules'],
    ['DELETE', '/api/providers/fixture-id/param-filters'],
    ['GET', '/api/combos'],
    ['GET', '/api/combos/fixture-id'],
    ['GET', '/api/combos/auto'],
    ['GET', '/api/combos/builder/options'],
    ['GET', '/api/combos/export'],
    ['GET', '/api/combos/metrics'],
    ['GET', '/api/keys'],
    ['GET', '/api/keys/fixture-id'],
    ['GET', '/api/models'],
    ['GET', '/api/settings'],
    ['GET', '/api/settings/cc-discovery-metrics'],
    ['GET', '/api/settings/proxies'],
    ['GET', '/api/settings/proxies/assignments'],
    ['GET', '/api/settings/reasoning-routing-rules'],
    ['GET', '/api/fallback/chains'],
    ['GET', '/api/model-capability-overrides'],
    ['GET', '/api/provider-nodes'],
    ['GET', '/api/providers'],
    ['GET', '/api/providers/deprecated'],
    ['GET', '/api/providers/fixture-id/cc-alias'],
    ['GET', '/api/providers/fixture-id/interception-rules'],
    ['GET', '/api/providers/fixture-id/param-filters'],
    ['PATCH', '/api/combos/fixture-id'],
    ['PATCH', '/api/model-capability-overrides'],
    ['PATCH', '/api/providers'],
    ['POST', '/api/combos'],
    ['POST', '/api/combos/duplicate'],
    ['POST', '/api/combos/import'],
    ['POST', '/api/combos/reorder'],
    ['POST', '/api/combos/test'],
    ['POST', '/api/fallback/chains'],
    ['POST', '/api/provider-nodes'],
    ['POST', '/api/providers'],
    ['PUT', '/api/combos/fixture-id'],
    ['PUT', '/api/providers/fixture-id/cc-alias'],
    ['PUT', '/api/providers/fixture-id/interception-rules'],
    ['PUT', '/api/providers/fixture-id/param-filters'],
  ];
  for (const [method, path] of familyPolicyCases) {
    const control = path === reasoningPath || path === deprecatedPath ? { 'x-ingress-policy-control': '1' } : {};
    const denied = await request(path, method, control);
    const invalid = await request(path, method, { ...control, authorization: `Bearer ${invalidCredential}` });
    const allowed = await request(path, method, { ...control, cookie });
    const readScope = await request(path, method, { ...control, authorization: `Bearer ${scopedTokens.read}` });
    const writeScope = await request(path, method, { ...control, authorization: `Bearer ${scopedTokens.write}` });
    const adminScope = await request(path, method, { ...control, authorization: `Bearer ${scopedTokens.admin}` });
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const adminRequired = mutation && (path === '/api/providers' || path.startsWith('/api/providers/'));
    assert(readScope.status === (mutation ? 403 : 200) && writeScope.status === (adminRequired ? 403 : 200) && adminScope.status === 200 && [readScope, writeScope, adminScope].every(response => response.routeClass === 'MANAGEMENT') && [readScope, writeScope, adminScope].every(response => !Object.values(scopedTokens).some(token => response.text.includes(token))), `family-scopes:${method}:${path}`);
    assert(denied.status === 401 && invalid.status === 401 && allowed.status === 200 && allowed.body?.fixture === 'management-handler-reached' && [denied, invalid, allowed].every(response => response.routeClass === 'MANAGEMENT') && !JSON.stringify(invalid.body).includes(invalidCredential), `family-policy:${method}:${path}`);
    results.push({ case: `${method} ${path}`, denied, invalid, allowed, readScope, writeScope, adminScope });
  }
  assert((await stat(`${dir}/events.jsonl`)).size <= 1048576, 'event-limit');
  const events = (await readFile(`${dir}/events.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(!events.some(event => String(event.event).startsWith('unsupported:')), 'unsupported-boundary');
  assert(events.some(event => event.event === 'sqlite:read'), 'sqlite-not-observed');
  const identity = JSON.parse(await readFile(`${dir}/pinned-ingress-identity.json`, 'utf8'));
  await writeFile(`${dir}/pinned-ingress-observations.json`, JSON.stringify({ identity, results, events, liveness, livenessHead, livenessMatcherMatched, reasoningHttp, deprecatedHttp, wellKnown, acpHttp, authStatusHttp, mfaStatusHttp, ssoConfigHttp, requireLoginHttp }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} finally {
  statusDb.close();
  loginDb.close();
  mfaDb.close();
  ssoDb.close();
  db.close();
  await stop(acpChild);
  await stop();
}
