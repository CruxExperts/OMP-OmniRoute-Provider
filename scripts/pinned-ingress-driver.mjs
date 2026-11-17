// Executed only inside the reviewed private, loopback-only ingress sandbox.
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { jwtVerify } from 'jose';
import { projectMfaStatus } from '/work/fixture/mfa-response.mjs';

if (process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1') throw new Error('INGRESS_SANDBOX_REQUIRED');
const dir = '/work/data';
const port = 43179;
const secret = 'research-only-jwt-secret-32-byte-minimum';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const payload = `${encode({ alg: 'HS256' })}.${encode({ authenticated: true, iat: now, exp: now + 3600, jti: 'fixture-session' })}`;
const cookie = `auth_token=${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
const secondPayload = `${encode({ alg: 'HS256' })}.${encode({ authenticated: true, iat: now, exp: now + 3600, jti: 'fixture-session-second' })}`;
const secondCookie = `auth_token=${secondPayload}.${createHmac('sha256', secret).update(secondPayload).digest('base64url')}`;
const db = new DatabaseSync(`${dir}/metrics.sqlite`);
db.exec(`CREATE TABLE usage_history (provider TEXT, combo_strategy TEXT, tokens_input INTEGER, tokens_cache_read INTEGER, tokens_cache_creation INTEGER);
  INSERT INTO usage_history VALUES ('alpha', NULL, 100, 50, 10), ('alpha', 'round-robin', 40, 0, 0), ('beta', 'round-robin', 200, 100, 0);`);
db.exec("CREATE TABLE call_logs (requested_model TEXT, request_type TEXT, provider TEXT, error_summary TEXT); INSERT INTO call_logs VALUES ('auto', NULL, 'alpha', 'fixture-private'), ('auto', NULL, 'alpha', 'fixture-private'), ('auto/fast', NULL, 'beta', 'fixture-private'), ('auto/fast', NULL, ' ', 'fixture-private'), ('auto/smart', NULL, NULL, 'fixture-private'), ('auto/fast', 'upstream_http_attempt', 'alpha', 'fixture-private'), ('other', NULL, 'alpha', 'fixture-private')");
db.exec(await readFile('/work/app/src/lib/db/migrations/038_compression_analytics.sql', 'utf8'));
const compressionInsert = db.prepare('INSERT INTO compression_analytics (timestamp, provider, mode, original_tokens, compressed_tokens, tokens_saved, duration_ms) VALUES (?, ?, ?, 100, ?, ?, 20)');
for (const [age, saved] of [[1, 30], [2 * 24, 20], [15 * 24, 10], [45 * 24, 5]]) compressionInsert.run(new Date(Date.now() - age * 3600000).toISOString(), 'fixture-private-provider', 'fixture-private-mode', 100 - saved, saved);
db.exec(await readFile('/work/app/src/lib/db/migrations/002_mcp_a2a_tables.sql', 'utf8'));
const ownerHash = key => createHash('sha256').update(key).digest('hex').slice(0, 32);
const historyRows = [
  ['one', 'completed', 'alpha', null, '2026-01-01T00:00:00.000Z'],
  ['two', 'working', 'alpha', ownerHash('fixture_api_key_manage'), '2026-01-02T00:00:00.000Z'],
  ['three', 'failed', 'beta', ownerHash('fixture_api_key_admin'), '2026-01-03T00:00:00.000Z'],
  ['four', 'completed', 'alpha', ownerHash('fixture_api_key_manage'), '2026-01-04T00:00:00.000Z'],
  ['five', 'cancelled', null, null, '2026-01-05T00:00:00.000Z'],
];
const historyInsert = db.prepare('INSERT INTO a2a_tasks (id,state,skill_id,api_key_id,created_at,updated_at,completed_at,input_json,output_json) VALUES (?,?,?,?,?,?,?,?,?)');
for (const [id, state, skill, owner, date] of historyRows) historyInsert.run(id, state, skill, owner, date, date, state === 'completed' ? date : null, 'fixture-private-input', 'fixture-private-output');
const statusDb = new DatabaseSync(`${dir}/auth-status.sqlite`);
statusDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const mfaDb = new DatabaseSync(`${dir}/mfa-status.sqlite`);
mfaDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const ssoDb = new DatabaseSync(`${dir}/sso-config.sqlite`);
ssoDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const loginDb = new DatabaseSync(`${dir}/login-settings.sqlite`);
const oidcDb = new DatabaseSync(`${dir}/oidc-settings.sqlite`);
oidcDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const oidcSettings = { oidcEnabled: true, oidcIssuer: 'http://127.0.0.1:43182', oidcClientId: 'local-client', oidcClientSecret: 'local-secret', oidcAllowedSubjects: ['local-subject'], oidcAdmissionClaim: { path: 'roles', values: ['admin'] }, setupComplete: false };
const oidcInsert = oidcDb.prepare("INSERT OR REPLACE INTO key_value (namespace,key,value) VALUES ('settings',?,?)");
for (const [key, value] of Object.entries(oidcSettings)) oidcInsert.run(key, JSON.stringify(value));
const keyA = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyB = generateKeyPairSync('rsa', { modulusLength: 2048 });
let issuerMode = 'success', flowNonce = '', expectedVerifier = '', expectedChallenge = '', expectedCode = '', exchanges = 0, jwksRequests = 0;
const issuer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:43182');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/.well-known/openid-configuration') { if (issuerMode === 'discovery-fallback') { res.statusCode = 503; return res.end('{}'); } return res.end(JSON.stringify({ issuer: oidcSettings.oidcIssuer, authorization_endpoint: `${oidcSettings.oidcIssuer}/authorize`, token_endpoint: `${oidcSettings.oidcIssuer}/token`, jwks_uri: `${oidcSettings.oidcIssuer}/jwks` })); }
  if (url.pathname === '/jwks') { jwksRequests++; const rotated = issuerMode === 'rotation' || issuerMode === 'rotation-recovery'; return res.end(JSON.stringify({ keys: [{ ...(rotated ? keyB : keyA).publicKey.export({ format: 'jwk' }), kid: rotated ? 'rotated-key' : 'local-key', alg: 'RS256', use: 'sig' }] })); }
  if (url.pathname !== '/token' || req.method !== 'POST') { res.statusCode = 404; return res.end('{}'); }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const form = new URLSearchParams(Buffer.concat(chunks).toString()); exchanges++;
  if (!expectedCode || form.get('client_id') !== 'local-client' || form.get('client_secret') !== 'local-secret' || form.get('code') !== expectedCode || form.get('redirect_uri') !== `${issuerMode === 'secure' ? 'https' : 'http'}://127.0.0.1:${issuerMode === 'missing-secret' ? 43184 : 43183}/api/auth/oidc/callback` || (issuerMode === 'no-verifier' ? form.has('code_verifier') : form.get('code_verifier') !== expectedVerifier || createHash('sha256').update(expectedVerifier).digest('base64url') !== expectedChallenge) || form.get('grant_type') !== 'authorization_code') { res.statusCode = 400; return res.end('{}'); }
  expectedCode = '';
  if (issuerMode === 'exchange-network') { req.socket.destroy(); return; }
  if (issuerMode === 'exchange') { res.statusCode = 500; return res.end('{}'); }
  if (issuerMode === 'bad-json') return res.end('{');
  if (issuerMode === 'no-token') return res.end('{}');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerMode === 'issuer' ? 'https://invalid.example' : oidcSettings.oidcIssuer, aud: issuerMode === 'audience' ? 'wrong' : 'local-client', sub: issuerMode === 'subject' ? 'wrong' : 'local-subject', roles: issuerMode === 'role' ? ['reader'] : issuerMode === 'malformed-role' ? ['admin', 1] : ['admin'], ...(issuerMode === 'token-missing-nonce' ? {} : { nonce: issuerMode === 'nonce' ? 'wrong' : flowNonce }), iat: now, exp: issuerMode === 'expired' ? now - 60 : now + 300, nbf: issuerMode === 'future' ? now + 300 : now - 1 };
  const input = `${encode({ alg: 'RS256', kid: issuerMode.startsWith('rotation') ? 'rotated-key' : 'local-key' })}.${encode(payload)}`;
  const signature = sign('RSA-SHA256', Buffer.from(input), ['signature', 'rotation', 'rotation-recovery'].includes(issuerMode) ? keyB.privateKey : keyA.privateKey).toString('base64url');
  res.end(JSON.stringify({ id_token: `${input}.${signature}` }));
});
await new Promise((resolve, reject) => { issuer.once('error', reject); issuer.listen(43182, '127.0.0.1', resolve); });
loginDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const a2aDb = new DatabaseSync(`${dir}/a2a-status.sqlite`);
a2aDb.exec('CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (namespace, key));');
const visibilityDb = new DatabaseSync(`${dir}/visibility.sqlite`);
visibilityDb.exec(`CREATE TABLE proxy_registry (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT, password TEXT, region TEXT, notes TEXT, status TEXT, source TEXT, family TEXT, subscription_id TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE proxy_assignments (id INTEGER PRIMARY KEY, proxy_id TEXT, scope TEXT, scope_id TEXT, position INTEGER);
  CREATE TABLE proxy_scope_rotation (scope TEXT, scope_id TEXT, strategy TEXT);
  INSERT INTO proxy_registry VALUES ('private-a','private-name','http','fixture-private.invalid',8080,'fixture-user','fixture-password',NULL,'fixture-note','active','manual','auto',NULL,'2026','2026');
  INSERT INTO proxy_assignments VALUES (1,'private-a','global','__global__',0),(2,'private-a','provider','private-provider',0),(3,'private-a','account','private-account',0),(4,'private-a','combo','private-combo',0);
  INSERT INTO proxy_scope_rotation VALUES ('provider','private-provider','sticky');`);
const scopedTokens = Object.fromEntries(['read', 'write', 'admin'].map(scope => [scope, `oma_live_fixture_${scope}_only`]));
const managementKeys = Object.fromEntries(['read', 'write', 'admin', 'manage'].map(scope => [scope, `fixture_api_key_${scope}`]));
const ownedProbe = '/work/fixture/acp-owned-probe';
const state = { bypass: 'disabled', settings: { requireLogin: true, password: 'fixture-configured', setupComplete: true, customAgents: [{ id: 'owned', name: 'owned', binary: ownedProbe, versionCommand: `${ownedProbe} --version`, providerAlias: 'owned', spawnArgs: [], protocol: 'stdio' }] }, tokens: Object.entries(scopedTokens).map(([scope, token]) => ({ id: `fixture-${scope}`, token_hash: createHash('sha256').update(token).digest('hex'), token_prefix: 'oma_live_fixtu', name: `fixture-${scope}`, scope, created_at: '2025-01-01T00:00:00.000Z', last_used_at: null, expires_at: null, revoked_at: null })), apiKeys: Object.entries(managementKeys).map(([scope, key]) => ({ id: `key-${scope}`, key_hash: createHash('sha256').update(key).digest('hex'), is_active: 1, is_banned: 0, scopes: JSON.stringify([scope]) })) };
await writeFile(`${dir}/state.json`, JSON.stringify(state), { mode: 0o600 });
await writeFile(`${dir}/csrf-disabled-state.json`, JSON.stringify({ ...state, settings: { ...state.settings, requireLogin: false } }), { mode: 0o600 });
await writeFile(`${dir}/csrf-disabled-events.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/csrf-failure-state.json`, JSON.stringify({ ...state, failTokenRead: true }), { mode: 0o600 });
await writeFile(`${dir}/csrf-failure-events.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/events.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/auth-status-reads.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/sso-config-reads.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/login-settings-reads.jsonl`, '', { mode: 0o600 });
await writeFile(`${dir}/a2a-status-reads.jsonl`, '', { mode: 0o600 });
const child = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret, INITIAL_PASSWORD: 'fixture-only-initial-password' }, stdio: ['ignore', 'inherit', 'inherit'],
});
const oidcChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '43183'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret }, stdio: ['ignore', 'inherit', 'inherit'],
});
const oidcNoSecretChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '43184'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl` }, stdio: ['ignore', 'inherit', 'inherit'],
});
const acpChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/fixture/acp-server.mjs'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret }, stdio: ['ignore', 'inherit', 'inherit'],
});
const historyChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '43181'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret, INITIAL_PASSWORD: 'fixture-only-initial-password', REQUIRE_API_KEY: 'true' }, stdio: ['ignore', 'inherit', 'inherit'],
});
const csrfDisabledChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '43185'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/csrf-disabled-state.json`, INGRESS_EVENT_FILE: `${dir}/csrf-disabled-events.jsonl` }, stdio: ['ignore', 'inherit', 'inherit'],
});
const csrfFailureChild = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '43186'], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/csrf-failure-state.json`, INGRESS_EVENT_FILE: `${dir}/csrf-failure-events.jsonl`, JWT_SECRET: secret, INITIAL_PASSWORD: 'fixture-only-initial-password' }, stdio: ['ignore', 'inherit', 'inherit'],
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
  return { status: response.status, routeClass: response.headers.get('x-omniroute-route-class'), requestId: response.headers.get('x-request-id'), cacheControl: response.headers.get('cache-control'), contentType: response.headers.get('content-type'), contentLength: response.headers.get('content-length'), ...(path === '/api/auth/csrf' ? { setCookie: response.headers.has('set-cookie') } : {}), text, body };
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
  await ready(oidcChild, 43183);
  await ready(oidcNoSecretChild, 43184);
  const configCases = {};
  for (const [name, key, value] of [['disabled', 'oidcEnabled', false], ['incomplete', 'oidcClientSecret', '']]) {
    oidcInsert.run(key, JSON.stringify(value));
    await delay(5100);
    const login = await fetch('http://127.0.0.1:43183/api/auth/oidc/login', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const callback = await fetch('http://127.0.0.1:43183/api/auth/oidc/callback?code=single&state=config-state', { headers: { cookie: 'oidc_state=config-state' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = await login.json();
    configCases[name] = { loginStatus: login.status, loginPublic: login.headers.get('x-omniroute-route-class') === 'PUBLIC', fixedError: body.error === 'OIDC is not configured. Use password login or configure OIDC in settings.', noLoginCookies: login.headers.getSetCookie().length === 0, callbackStatus: callback.status, callbackResult: new URL(callback.headers.get('location')).searchParams.get('oidc_error'), callbackPublic: callback.headers.get('x-omniroute-route-class') === 'PUBLIC' };
    oidcInsert.run(key, JSON.stringify(oidcSettings[key]));
    await delay(5100);
  }
  const oidcCases = {};
  for (const mode of ['nonce', 'missing-nonce', 'token-missing-nonce', 'signature', 'issuer', 'audience', 'expired', 'future', 'subject', 'role', 'malformed-role', 'exchange', 'exchange-network', 'bad-json', 'no-token', 'missing-code', 'missing-state', 'wrong-state', 'missing-secret', 'no-verifier', 'discovery-fallback', 'success', 'secure', 'rotation', 'rotation-recovery']) {
    if (mode === 'rotation-recovery') await delay(31000);
    issuerMode = mode;
    expectedCode = `single-use-${mode}`;
    if (['success', 'secure', 'no-verifier', 'discovery-fallback', 'rotation', 'rotation-recovery'].includes(mode)) { oidcInsert.run('setupComplete', 'false'); if (oidcDb.prepare("SELECT value FROM key_value WHERE namespace='settings' AND key='setupComplete'").get()?.value !== 'false') throw new Error('OIDC_SETUP_RESET_FAILED'); }
    const oidcPort = mode === 'missing-secret' ? 43184 : 43183;
    const login = await fetch(`http://127.0.0.1:${oidcPort}/api/auth/oidc/login`, { headers: mode === 'secure' ? { 'x-forwarded-proto': 'https' } : {}, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const location = new URL(login.headers.get('location'));
    if (mode === 'discovery-fallback' && (location.origin !== oidcSettings.oidcIssuer || location.pathname !== '/authorize')) throw new Error('OIDC_DISCOVERY_FALLBACK_MISMATCH');
    const flowCookies = login.headers.getSetCookie();
    const values = Object.fromEntries(flowCookies.map(value => { const pair = value.split(';', 1)[0]; const at = pair.indexOf('='); return [pair.slice(0, at), pair.slice(at + 1)]; }));
    flowNonce = location.searchParams.get('nonce'); expectedVerifier = values.oidc_pkce_verifier; expectedChallenge = location.searchParams.get('code_challenge');
    const before = exchanges, beforeJwks = jwksRequests;
    const query = mode === 'missing-code' ? `state=${encodeURIComponent(values.oidc_state)}` : mode === 'missing-state' ? `code=${encodeURIComponent(expectedCode)}` : `code=${encodeURIComponent(expectedCode)}&state=${encodeURIComponent(mode === 'wrong-state' ? 'foreign-state' : values.oidc_state)}`;
    const response = await fetch(`http://127.0.0.1:${oidcPort}/api/auth/oidc/callback?${query}`, { headers: { ...(mode === 'secure' ? { 'x-forwarded-proto': 'https' } : {}), cookie: Object.entries(values).filter(([key]) => (mode !== 'missing-nonce' || key !== 'oidc_nonce') && (mode !== 'no-verifier' || key !== 'oidc_pkce_verifier')).map(([key, value]) => `${key}=${value}`).join('; ') }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const destination = new URL(response.headers.get('location'));
    const returnedCookies = response.headers.getSetCookie();
    const session = returnedCookies.find(value => value.startsWith('auth_token='));
    const clearCookiesValid = ['oidc_pkce_verifier', 'oidc_nonce'].every(name => returnedCookies.some(value => value.startsWith(`${name}=`) && /max-age=0/i.test(value) && /httponly/i.test(value) && /samesite=lax/i.test(value)));
    let sessionValid = false;
    if (session) { try { const token = session.split(';', 1)[0].slice('auth_token='.length); const verified = await jwtVerify(token, new TextEncoder().encode(secret)); sessionValid = verified.payload.authenticated === true; } catch {} }
    const setup = oidcDb.prepare("SELECT value FROM key_value WHERE namespace='settings' AND key='setupComplete'").get();
    oidcCases[mode] = { loginStatus: login.status, loginPublic: login.headers.get('x-omniroute-route-class') === 'PUBLIC', loginCookiesValid: ['oidc_state', 'oidc_pkce_verifier', 'oidc_nonce'].every(name => flowCookies.some(value => value.startsWith(`${name}=`) && /httponly/i.test(value) && /samesite=lax/i.test(value) && /max-age=600/i.test(value) && /path=\//i.test(value) && (/; secure/i.test(value) === (mode === 'secure')))), stateMatches: location.searchParams.get('state') === values.oidc_state, nonceMatches: flowNonce === values.oidc_nonce, challengeMatches: createHash('sha256').update(expectedVerifier).digest('base64url') === expectedChallenge && location.searchParams.get('code_challenge_method') === 'S256', callbackStatus: response.status, callbackPublic: response.headers.get('x-omniroute-route-class') === 'PUBLIC', result: destination.pathname === '/dashboard' ? 'dashboard' : destination.searchParams.get('oidc_error'), stateCleared: returnedCookies.some(value => value.startsWith('oidc_state=') && /max-age=0/i.test(value)), clearCookiesValid, sessionIssued: Boolean(session), sessionValid, sessionAttributesValid: !session || (/httponly/i.test(session) && /samesite=lax/i.test(session) && /max-age=2592000/i.test(session) && /path=\//i.test(session) && (/; secure/i.test(session) === (mode === 'secure'))), setupComplete: setup?.value === 'true', exchangeCount: exchanges - before, jwksRequests: jwksRequests - beforeJwks };
  }
  // The isolated boundary records calls but never runs catalog revalidation.
  const catalogBoundary = `${dir}/oidc-catalog-boundary.jsonl`;
  const boundaryDeadline = Date.now() + 10000;
  let boundaryEvents = [];
  while (Date.now() < boundaryDeadline) {
    try { boundaryEvents = (await readFile(catalogBoundary, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (boundaryEvents.length >= 6) break;
    await delay(50);
  }
  assert(boundaryEvents.length === 6 && boundaryEvents.every(event => JSON.stringify(event) === '{"event":"schedule-not-executed"}'), 'oidc-catalog-boundary');
  const oidcHttp = { cases: oidcCases, configCases };
  await ready(acpChild, 43180);
  const statusPath = '/api/auth/status';
  const csrfCases = {};
  let firstCsrfToken;
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer invalid' }, session: { cookie }, session2: { cookie: secondCookie }, inference: { authorization: `Bearer ${managementKeys.read}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.admin}` }, omaRead: { authorization: `Bearer ${scopedTokens.read}` }, omaWrite: { authorization: `Bearer ${scopedTokens.write}` } })) {
    const before = Math.floor(Date.now() / 1000);
    const response = await request('/api/auth/csrf', 'GET', headers);
    const after = Math.floor(Date.now() / 1000);
    let issued = null, hmacBound = null, expiryValid = null, shapeValid = null;
    if (response.status === 200) {
      const body = response.body;
      shapeValid = body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).sort().join(',') === 'expiresAt,token';
      issued = typeof body?.token === 'string';
      if (issued) {
        const parts = body.token.split('.');
        const expiry = Number(parts[1]);
        const session = headers.cookie?.slice('auth_token='.length) ?? '';
        const hash = createHash('sha256').update(session).digest('base64url');
        const mac = createHmac('sha256', secret).update(`omniroute-dashboard-csrf-v1\n${expiry}\n${hash}`).digest('base64url');
        hmacBound = parts.length === 3 && parts[0] === 'v1' && parts[2] === mac;
        expiryValid = Number.isSafeInteger(expiry) && expiry >= before + 600 && expiry <= after + 600 && expiry <= 8_640_000_000_000 && body.expiresAt === new Date(expiry * 1000).toISOString();
        if (name === 'session') firstCsrfToken = body.token;
      } else {
        shapeValid &&= body?.token === null && body?.expiresAt === null;
      }
    }
    csrfCases[name] = { status: response.status, routeClass: response.routeClass, issued, hmacBound, expiryValid, shapeValid, sessionDistinct: name === 'session2' ? issued && typeof firstCsrfToken === 'string' && response.body.token !== firstCsrfToken : null, noStore: response.cacheControl === 'no-store', json: response.contentType === 'application/json', cookieMutation: response.setCookie };
  }
  await ready(csrfDisabledChild, 43185);
  for (const [name, headers] of Object.entries({ disabled: {}, missingSecret: { cookie: 'auth_token=fixture-session' } })) {
    const r = await request('/api/auth/csrf', 'GET', headers, 43185);
    csrfCases[name] = { status: r.status, routeClass: r.routeClass, issued: r.status === 200 ? r.body?.token !== null : null, hmacBound: null, expiryValid: null, shapeValid: r.status === 200 ? JSON.stringify(r.body) === JSON.stringify({ token: null, expiresAt: null }) : null, sessionDistinct: null, noStore: r.cacheControl === 'no-store', json: r.contentType === 'application/json', cookieMutation: r.setCookie };
  }
  await ready(csrfFailureChild, 43186);
  const failed = await request('/api/auth/csrf', 'GET', { authorization: `Bearer ${scopedTokens.read}` }, 43186);
  csrfCases.backendFailure = { status: failed.status, routeClass: failed.routeClass, issued: null, hmacBound: null, expiryValid: null, shapeValid: null, sessionDistinct: null, noStore: failed.cacheControl === 'no-store', json: failed.contentType === 'application/json', cookieMutation: failed.setCookie };
  const csrfHttp = { cases: csrfCases };
  const analyticsPath = '/api/analytics/auto-routing';
  const analyticsAuth = {};
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, inference: { authorization: `Bearer ${managementKeys.read}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.read}` } })) {
    const r = await request(analyticsPath, 'GET', headers);
    assert(!r.text.includes('fixture-private') && !r.text.includes('invalid-fixture-secret'), 'analytics-private-data');
    analyticsAuth[name] = { status: r.status, routeClass: r.routeClass, body: r.status === 200 ? r.body : null };
  }
  const analyticsBefore = db.prepare('SELECT count(*) AS rows FROM call_logs').get().rows;
  db.exec('ALTER TABLE call_logs RENAME TO fixture_hidden_call_logs');
  const analyticsFailure = await request(analyticsPath, 'GET', { cookie });
  db.exec('ALTER TABLE fixture_hidden_call_logs RENAME TO call_logs');
  const analyticsAfter = db.prepare('SELECT count(*) AS rows FROM call_logs').get().rows;
  const analyticsHttp = { auth: analyticsAuth, beforeRows: analyticsBefore, afterRows: analyticsAfter, failure: { status: analyticsFailure.status, routeClass: analyticsFailure.routeClass, body: analyticsFailure.body } };
  assert(analyticsFailure.status === 200 && !analyticsFailure.text.includes('fixture-private'), 'analytics-caught-failure');
  const compressionPath = '/api/analytics/compression';
  const compressionColumns = () => db.prepare('PRAGMA table_info(compression_analytics)').all().map(row => row.name);
  const compressionBefore = compressionColumns();
  const compressionAuth = {};
  let deniedColumns;
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer invalid' }, inference: { authorization: `Bearer ${managementKeys.read}` }, session: { cookie }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.read}` } })) {
    const r = await request(compressionPath, 'GET', headers);
    compressionAuth[name] = { status: r.status, routeClass: r.routeClass };
    if (name === 'inference') deniedColumns = compressionColumns().length;
  }
  const compressionAfter = compressionColumns();
  const compressionPeriods = [];
  for (const query of ['', '?since=24h', '?since=unknown', '?since=7d', '?since=30d', '?since=all']) {
    const r = await request(compressionPath + query, 'GET', { cookie });
    compressionPeriods.push({ status: r.status, routeClass: r.routeClass, totalRequests: r.body?.totalRequests, totalTokensSaved: r.body?.totalTokensSaved, chartLength: r.body?.last24h?.length, chartCount: r.body?.last24h?.reduce((sum, row) => sum + row.count, 0) });
  }
  db.exec('ALTER TABLE compression_analytics RENAME TO fixture_hidden_compression_analytics');
  let compressionFailure;
  try { const r = await request(compressionPath, 'GET', { cookie }); compressionFailure = { status: r.status, routeClass: r.routeClass, body: r.body }; }
  finally { db.exec('ALTER TABLE fixture_hidden_compression_analytics RENAME TO compression_analytics'); }
  const compressionHttp = { auth: compressionAuth, beforeColumns: compressionBefore.length, deniedColumns, afterColumns: compressionAfter.length, periods: compressionPeriods, failure: compressionFailure };
  assert(compressionFailure.status === 500 && JSON.stringify(compressionFailure.body) === JSON.stringify({ error: 'Internal server error' }), 'compression-failure');
  const diversityAuth = {};
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, inference: { authorization: `Bearer ${managementKeys.read}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.read}` } })) {
    const r = await request('/api/analytics/diversity', 'GET', headers);
    diversityAuth[name] = { status: r.status, routeClass: r.routeClass, body: r.status === 200 ? r.body : null };
  }
  const diversityHttp = { auth: diversityAuth };
  // The wrapper exists only in this disposable bundle; ordinary requests run the pinned route.
  const metricsPath = '/api/combos/metrics';
  const metricsAuth = {};
  const metricsCredentials = { anonymous: {}, invalid: { authorization: 'Bearer invalid' }, session: { cookie }, 'key-read': { authorization: `Bearer ${managementKeys.read}` }, 'key-write': { authorization: `Bearer ${managementKeys.write}` }, 'key-manage': { authorization: `Bearer ${managementKeys.manage}` }, 'key-admin': { authorization: `Bearer ${managementKeys.admin}` }, 'oma-read': { authorization: `Bearer ${scopedTokens.read}` }, 'oma-write': { authorization: `Bearer ${scopedTokens.write}` }, 'oma-admin': { authorization: `Bearer ${scopedTokens.admin}` } };
  for (const method of ['GET', 'DELETE']) {
    metricsAuth[method] = {};
    for (const [name, headers] of Object.entries(metricsCredentials)) {
      const r = await request(metricsPath, method, headers);
      metricsAuth[method][name] = { status: r.status, routeClass: r.routeClass };
    }
  }
  const fixtureMetrics = async action => {
    const r = await request(metricsPath, 'GET', { cookie, 'x-ingress-metrics-fixture': action });
    assert(r.status === 200 && r.routeClass === 'MANAGEMENT' && Array.isArray(r.body?.states), `metrics-fixture-${action}`);
    return r.body.states;
  };
  const metricGet = async query => {
    const r = await request(metricsPath + query, 'GET', { cookie });
    assert(r.status === 200 && r.routeClass === 'MANAGEMENT', `metrics-get-${query}`);
    return r.body.metrics;
  };
  const metricDelete = async query => {
    const r = await request(metricsPath + query, 'DELETE', { cookie });
    assert(r.status === 200 && r.routeClass === 'MANAGEMENT' && r.body?.success === true, `metrics-delete-${query}`);
  };
  await fixtureMetrics('hidden');
  const hiddenOnlyGetNull = (await metricGet('?combo=fixture-selected')) === null;
  const hiddenOnlyCount = (await fixtureMetrics('inspect'))[0].hidden;
  await fixtureMetrics('seed');
  const selected = await metricGet('?combo=fixture-selected');
  const all = await metricGet('');
  const metricsEmpty = await metricGet('?combo=');
  const prototype = await metricGet('?combo=__proto__');
  const seededStates = await fixtureMetrics('inspect');
  await metricDelete('?combo=fixture-selected');
  const selectedAfter = await metricGet('?combo=fixture-selected');
  const otherAfter = await metricGet('?combo=fixture-other');
  const selectedStates = await fixtureMetrics('inspect');
  await metricDelete('?combo=');
  const afterEmptyDelete = await metricGet('');
  const emptyStates = await fixtureMetrics('inspect');
  await fixtureMetrics('hidden'); await fixtureMetrics('seed');
  await metricDelete('');
  const afterGlobal = await metricGet('');
  const globalStates = await fixtureMetrics('inspect');
  const metricsHttp = { auth: metricsAuth, hiddenOnlyGetNull, hiddenOnlyCount, selectedProduction: selected?.totalRequests, selectedShadow: selected?.shadow?.totalRequests, selectedHidden: selected?.persistedSkipBypassed, allNames: Object.keys(all).sort(), emptyNames: Object.keys(metricsEmpty).sort(), prototypeSelected: prototype?.totalRequests, prototypeInAll: Object.hasOwn(all, '__proto__'), seededStates, selectedAfterNull: selectedAfter === null, unrelatedProduction: otherAfter?.totalRequests, unrelatedShadow: otherAfter?.shadow?.totalRequests, unrelatedHidden: otherAfter?.persistedSkipBypassed, selectedStates, afterEmptyDeleteNames: Object.keys(afterEmptyDelete).sort(), emptyStates, afterGlobalNames: Object.keys(afterGlobal).sort(), globalStates };
  const concurrencyPath = '/api/admin/concurrency';
  const concurrencyProject = r => ({ status: r.status, routeClass: r.routeClass, cacheControl: r.cacheControl, contentType: r.contentType, counts: r.status === 200 && r.body ? Object.fromEntries(['rateLimits', 'comboQueues', 'semaphores'].map(key => [key, r.body[key] && typeof r.body[key] === 'object' && !Array.isArray(r.body[key]) ? Object.keys(r.body[key]).length : null])) : null, shape: r.status === 200 && r.body ? Object.keys(r.body).sort().join(',') === 'comboQueues,rateLimits,semaphores,timestamp' && typeof r.body.timestamp === 'string' && Number.isFinite(Date.parse(r.body.timestamp)) : null });
  const concurrencyAuth = {};
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer invalid' }, inference: { authorization: `Bearer ${managementKeys.read}` }, writeKey: { authorization: `Bearer ${managementKeys.write}` }, session: { cookie }, oma: { authorization: `Bearer ${scopedTokens.read}` }, omaWrite: { authorization: `Bearer ${scopedTokens.write}` }, omaAdmin: { authorization: `Bearer ${scopedTokens.admin}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` } })) {
    concurrencyAuth[name] = concurrencyProject(await request(concurrencyPath, 'GET', headers));
  }
  const concurrencyEmpty = concurrencyProject(await request(concurrencyPath, 'GET', { cookie }));
  const firstConcurrency = await request(concurrencyPath, 'GET', { cookie, 'x-ingress-concurrency-control': 'seed' });
  const secondConcurrency = await request(concurrencyPath, 'GET', { cookie });
  const concurrencyFailure = await request(concurrencyPath, 'GET', { cookie, 'x-ingress-concurrency-control': 'failure' });
  const concurrencyHttp = { auth: concurrencyAuth, empty: concurrencyEmpty, populated: concurrencyProject(firstConcurrency), unchanged: ['rateLimits', 'comboQueues', 'semaphores'].every(key => JSON.stringify(firstConcurrency.body?.[key]) === JSON.stringify(secondConcurrency.body?.[key])), failure: { status: concurrencyFailure.status, routeClass: concurrencyFailure.routeClass, cacheControl: concurrencyFailure.cacheControl, contentType: concurrencyFailure.contentType, json: concurrencyFailure.body !== null, privateMarkerPresent: concurrencyFailure.text.includes('fixture-private') } };
  await ready(historyChild, 43181);
  const historyPath = '/api/a2a/tasks/history';
  const historyCall = (query = '', headers = {}) => request(historyPath + query, 'GET', headers, 43181);
  const historyAuth = {};
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, inference: { authorization: `Bearer ${managementKeys.read}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.read}` } })) {
    const r = await historyCall('', headers);
    historyAuth[name] = { status: r.status, routeClass: r.routeClass, ids: r.status === 200 ? r.body.tasks.map(task => task.id) : null };
  }
  const historyPages = [];
  for (const query of ['?limit=2&offset=0', '?limit=2&offset=2', '?limit=2&offset=4', '?limit=2&offset=8', '?limit=501', '?from=2026-01-02T00%3A00%3A00.000Z&to=2026-01-04T00%3A00%3A00.000Z&skill=alpha&state=completed']) {
    const r = await historyCall(query, { cookie });
    assert(r.status === 200 && !r.text.includes('fixture-private'), 'history-page');
    historyPages.push({ status: r.status, ids: r.body.tasks.map(task => task.id), total: r.body.total, limit: r.body.limit, offset: r.body.offset });
  }
  const invalidHistory = [];
  for (const query of ['?from=invalid', '?state=unknown', '?skill=', '?limit=0', '?offset=-1']) {
    const r = await historyCall(query, { cookie });
    invalidHistory.push(r.status);
  }
  db.exec('DROP TABLE a2a_tasks');
  const historyFailure = await historyCall('', { cookie });
  const a2aHistoryHttp = { auth: historyAuth, pages: historyPages, invalid: invalidHistory, failure: { status: historyFailure.status, routeClass: historyFailure.routeClass, hasTasks: Array.isArray(historyFailure.body?.tasks) } };
  assert(historyFailure.status === 500 && !a2aHistoryHttp.failure.hasTasks, 'history-storage-failure');
  const visibilityPath = '/api/admin/proxy-pool-visibility';
  const visibilityCall = (query, headers = { cookie }) => request(visibilityPath + query, 'GET', headers, 43181);
  const visibilityAuth = {};
  for (const [name, headers] of Object.entries({ anonymous: {}, invalid: { authorization: 'Bearer invalid' }, session: { cookie }, inference: { authorization: `Bearer ${managementKeys.read}` }, writeKey: { authorization: `Bearer ${managementKeys.write}` }, manage: { authorization: `Bearer ${managementKeys.manage}` }, admin: { authorization: `Bearer ${managementKeys.admin}` }, oma: { authorization: `Bearer ${scopedTokens.read}` }, omaWrite: { authorization: `Bearer ${scopedTokens.write}` }, omaAdmin: { authorization: `Bearer ${scopedTokens.admin}` } })) {
    const result = await visibilityCall('?scope=global', headers);
    visibilityAuth[name] = { status: result.status, routeClass: result.routeClass };
  }
  const visibilityCases = {};
  for (const [name, query] of Object.entries({ global: '?scope=global', provider: '?scope=provider&scopeId=private-provider', account: '?scope=account&scopeId=private-account', combo: '?scope=combo&scopeId=private-combo', key: '?scope=key&scopeId=private-account', proxy: '?proxyId=private-a', unknownProxy: '?proxyId=unknown-private', unknownScope: '?scope=unknown&scopeId=private-id', missing: '', missingId: '?scope=provider', pauseMissing: '?freeTierPauses=1', pauses: '?freeTierPauses=1&provider=opencode-private&scope=global&proxyId=private-a', nonOpencode: '?freeTierPauses=1&provider=other' })) {
    const result = await visibilityCall(query);
    visibilityCases[name] = { status: result.status, routeClass: result.routeClass, total: Number.isInteger(result.body?.total) ? result.body.total : null, scope: typeof result.body?.scope === 'string' ? result.body.scope : null, opaque: result.body?.members?.[0]?.opaque ?? null, pauses: Array.isArray(result.body?.pauses) ? result.body.pauses.length : null };
  }
  visibilityDb.exec('DROP TABLE proxy_registry');
  const visibilityFailure = await visibilityCall('?scope=global');
  const proxyVisibilityHttp = { auth: visibilityAuth, cases: visibilityCases, failure: { status: visibilityFailure.status, routeClass: visibilityFailure.routeClass } };
  assert(visibilityFailure.status === 500, 'visibility-storage-failure');
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
  const a2aMatcherMatched = matchers.some(entry => new RegExp(entry.regexp).test('/api/a2a/status'));
  assert(a2aMatcherMatched, 'a2a-proxy-matcher');
  const a2aCases = {};
  const a2aCredentials = { anonymous: {}, invalid: { authorization: 'Bearer [REDACTED:auth_header]' }, session: { cookie }, ...Object.fromEntries(Object.entries(managementKeys).map(([name, key]) => [`key-${name}`, { authorization: `Bearer ${key}` }])), ...Object.fromEntries(Object.entries(scopedTokens).map(([name, key]) => [`oma-${name}`, { authorization: `Bearer ${key}` }])) };
  for (const [name, headers] of Object.entries(a2aCredentials)) {
    const response = await request('/api/a2a/status', 'GET', headers);
    const allowed = ['session', 'key-admin', 'key-manage', 'oma-read', 'oma-write', 'oma-admin'].includes(name);
    assert(response.routeClass === 'MANAGEMENT' && response.status === (allowed ? 200 : name === 'anonymous' ? 401 : 403), `a2a-auth:${name}`);
    if (allowed) assert(response.body?.enabled === false && response.body?.status === 'disabled' && response.body?.tasks?.total === 0, `a2a-disabled:${name}`);
    a2aCases[name] = { status: response.status, routeClass: response.routeClass, disabled: allowed ? response.body.enabled === false : null };
  }
  const a2aHttp = { matcherMatched: a2aMatcherMatched, cases: a2aCases };
  a2aDb.prepare("INSERT INTO key_value (namespace,key,value) VALUES ('settings','a2aEnabled','true')").run();
  await delay(5100);
  const a2aEnabled = await request('/api/a2a/status', 'GET', { cookie });
  assert(a2aEnabled.status === 200 && a2aEnabled.routeClass === 'MANAGEMENT' && a2aEnabled.body?.enabled === true && a2aEnabled.body?.agent?.name === 'OmniRoute AI Gateway' && a2aEnabled.body?.capabilities?.streaming === true && a2aEnabled.body?.skills?.length === 6, 'a2a-enabled');
  a2aDb.exec('DROP TABLE key_value');
  await delay(5100);
  const a2aFailure = await request('/api/a2a/status', 'GET', { cookie });
  assert(a2aFailure.status === 500 && a2aFailure.routeClass === 'MANAGEMENT' && typeof a2aFailure.body?.error === 'string', 'a2a-failure');
  a2aHttp.enabled = { status: a2aEnabled.status, routeClass: a2aEnabled.routeClass, enabled: true, agentName: a2aEnabled.body.agent.name, streaming: true, skillCount: a2aEnabled.body.skills.length };
  a2aHttp.failure = { status: a2aFailure.status, routeClass: a2aFailure.routeClass, rawErrorPresent: true };
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
    const control = path === reasoningPath || path === deprecatedPath || path === metricsPath ? { 'x-ingress-policy-control': '1' } : {};
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
  await writeFile(`${dir}/pinned-ingress-observations.json`, JSON.stringify({ identity, results, events, liveness, livenessHead, livenessMatcherMatched, reasoningHttp, deprecatedHttp, wellKnown, acpHttp, authStatusHttp, csrfHttp, mfaStatusHttp, ssoConfigHttp, requireLoginHttp, a2aHttp, a2aHistoryHttp, proxyVisibilityHttp, analyticsHttp, compressionHttp, diversityHttp, concurrencyHttp, oidcHttp, metricsHttp }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} finally {
  oidcDb.close();
  await new Promise(resolve => issuer.close(resolve));
  statusDb.close();
  visibilityDb.close();
  a2aDb.close();
  loginDb.close();
  mfaDb.close();
  ssoDb.close();
  await stop(oidcChild);
  await stop(oidcNoSecretChild);
  db.close();
  await stop(csrfDisabledChild);
  await stop(csrfFailureChild);
  await stop(historyChild);
  await stop(acpChild);
  await stop();
}
