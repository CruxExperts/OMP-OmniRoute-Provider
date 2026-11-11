// Executed only inside the reviewed private, loopback-only ingress sandbox.
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

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
const state = { bypass: 'disabled', settings: { requireLogin: true, password: 'fixture-configured', setupComplete: true }, tokens: [] };
await writeFile(`${dir}/state.json`, JSON.stringify(state), { mode: 0o600 });
await writeFile(`${dir}/events.jsonl`, '', { mode: 0o600 });
const child = spawn(process.execPath, ['--import', '/work/fixture/initialize.mjs', '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: dir, INGRESS_STATE_FILE: `${dir}/state.json`, INGRESS_EVENT_FILE: `${dir}/events.jsonl`, JWT_SECRET: secret }, stdio: ['ignore', 'inherit', 'inherit'],
});
function assert(condition, name) { if (!condition) throw new Error(`INGRESS_ASSERTION:${name}`); }
async function ready() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert(child.exitCode === null && child.signalCode === null, 'server-exited');
    const open = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (open) return;
    await delay(100);
  }
  throw new Error('INGRESS_START_TIMEOUT');
}
async function request(path, method = 'GET', headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
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
  return { status: response.status, routeClass: response.headers.get('x-omniroute-route-class'), cacheControl: response.headers.get('cache-control'), body };
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
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) return;
  child.kill('SIGKILL');
  assert(await Promise.race([exited.then(() => true), delay(2000).then(() => false)]), 'server-stop');
}
const results = [];
try {
  await ready();
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
  assert((await stat(`${dir}/events.jsonl`)).size <= 1048576, 'event-limit');
  const events = (await readFile(`${dir}/events.jsonl`, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert(!events.some(event => String(event.event).startsWith('unsupported:')), 'unsupported-boundary');
  assert(events.some(event => event.event === 'sqlite:read'), 'sqlite-not-observed');
  const identity = JSON.parse(await readFile(`${dir}/pinned-ingress-identity.json`, 'utf8'));
  await writeFile(`${dir}/pinned-ingress-observations.json`, JSON.stringify({ identity, results, events }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
} finally {
  db.close();
  await stop();
}
