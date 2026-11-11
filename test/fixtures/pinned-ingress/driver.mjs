// Research-only driver, only inside the private isolated runner.
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

if (process.cwd() !== '/work/app' || process.env.INGRESS_APPROVED_SANDBOX !== '1') throw new Error('INGRESS_SANDBOX_REQUIRED');
const port = 43179;
const base = `http://127.0.0.1:${port}`;
const fixture = '/work/fixture';
const stateDir = '/work/data';
const node = process.execPath;
const jwtSecret = 'research-only-jwt-secret-32-byte-minimum';
const token = ['oma', 'live', 'fixture-secret'].join('_');
const sync = 'research-only-internal-sync-token';
const sha = value => createHash('sha256').update(value).digest('hex');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64({ alg: 'HS256' })}.${b64({ authenticated: true, iat: now, exp: now + 3600, jti: 'fixture-session' })}`;
const session = `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;
const row = { id: 'fixture-token', token_hash: sha(token), token_prefix: 'oma_live_resea', name: 'fixture', scope: 'admin', created_at: '2025-01-01T00:00:00.000Z', last_used_at: null, expires_at: null, revoked_at: null };
await mkdir(stateDir, { recursive: true });
async function ready(child) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('NEXT_EXITED_BEFORE_LISTEN');
    const up = await new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (up) return;
    await delay(100);
  }
  throw new Error('NEXT_START_TIMEOUT');
}
async function request(path, headers = {}) {
  const response = await fetch(base + path, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const reader = response.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error('HTTP_BODY_LIMIT'); }
      chunks.push(value);
    }
  }
  return { status: response.status, routeClass: response.headers.get('x-omniroute-route-class'), body: Buffer.concat(chunks).toString('utf8') };
}
async function awaitStatus(child, path, status) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('NEXT_EXITED_DURING_TRANSITION');
    const result = await request(path);
    if (result.status === status) return result;
    await delay(50);
  }
  throw new Error(`HTTP_TRANSITION_TIMEOUT:${status}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  if (await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) return;
  child.kill('SIGKILL');
  if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) throw new Error('NEXT_EXIT_TIMEOUT');
}
const cases = [
  { name: 'default-bypass-health', bypass: 'source-default', path: '/api/health', status: 200, marker: '"status":"ok"', health: true },
  { name: 'disabled-bypass-health', bypass: 'disabled', path: '/api/health', status: 200, marker: '"status":"ok"', health: true },
  { name: 'default-bypass-management-denied', bypass: 'source-default', path: '/api/ingress-control', status: 401 },
  { name: 'disabled-bypass-management-denied', bypass: 'disabled', path: '/api/ingress-control', status: 401 },
  { name: 'session-allowed', bypass: 'disabled', path: '/api/ingress-control', headers: { cookie: `auth_token=${session}` }, status: 200, marker: 'management-handler-reached' },
  { name: 'access-allowed', bypass: 'disabled', path: '/api/ingress-control', headers: { authorization: `Bearer ${token}` }, status: 200, marker: 'management-handler-reached', row },
  { name: 'access-invalid', bypass: 'disabled', path: '/api/ingress-control', headers: { authorization: ['Bearer', ['oma', 'live', 'unknown'].join('_')].join(' ') }, status: 401 },
  { name: 'access-expired', bypass: 'disabled', path: '/api/ingress-control', headers: { authorization: `Bearer ${token}` }, status: 401, row: { ...row, expires_at: '2020-01-01T00:00:00.000Z' } },
  { name: 'access-revoked', bypass: 'disabled', path: '/api/ingress-control', headers: { authorization: `Bearer ${token}` }, status: 401, row: { ...row, revoked_at: '2020-01-01T00:00:00.000Z' } },
  { name: 'access-backend-error', bypass: 'disabled', path: '/api/ingress-control', headers: { authorization: `Bearer ${token}` }, status: 503, row, failTokenRead: true },
  { name: 'sync-valid', bypass: 'disabled', path: '/api/providers/fixture/models', headers: { 'x-model-sync-internal-auth': sync }, status: 200, marker: 'management-handler-reached' },
  { name: 'sync-invalid', bypass: 'disabled', path: '/api/providers/fixture/models', headers: { 'x-model-sync-internal-auth': 'invalid' }, status: 401 },
];
const results = [];
for (const scenario of cases) {
  const statePath = `${stateDir}/state.json`, eventsPath = `${stateDir}/events.jsonl`;
  const state = { bypass: scenario.bypass, syncToken: sync, settings: { requireLogin: true, password: 'fixture-configured', setupComplete: true }, tokens: scenario.row ? [scenario.row] : [], failTokenRead: scenario.failTokenRead === true };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  await writeFile(eventsPath, '', { mode: 0o600 });
  const child = spawn(node, ['--import', `${fixture}/initialize.mjs`, '/work/app/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: '/work/app', env: { PATH: '/runtime', HOME: '/work/home', TMPDIR: '/work/tmp', NODE_ENV: 'production', DATA_DIR: stateDir, INGRESS_STATE_FILE: statePath, INGRESS_EVENT_FILE: eventsPath, JWT_SECRET: jwtSecret }, stdio: ['ignore', 'inherit', 'inherit'] });
  try {
    await ready(child);
    const result = await request(scenario.path, scenario.headers);
    const expectedClass = scenario.health ? 'PUBLIC' : 'MANAGEMENT';
    if (result.routeClass !== expectedClass) throw new Error(`MATCHER_NOT_OBSERVED:${scenario.name}`);
    if (result.status !== scenario.status || (scenario.marker && !result.body.includes(scenario.marker))) throw new Error(`HTTP_MISMATCH:${scenario.name}:${result.status}`);
    let draining;
    if (scenario.name === 'disabled-bypass-health') {
      child.kill('SIGUSR2');
      const during = await awaitStatus(child, '/api/health', 503);
      child.kill('SIGUSR2');
      const after = await awaitStatus(child, '/api/health', 200);
      if (during.status !== 503 || after.status !== 200) throw new Error('DRAIN_TRANSITION_MISMATCH');
      draining = { during, after };
    }
    if ((await stat(eventsPath)).size > 1048576) throw new Error(`EVENT_LOG_LIMIT:${scenario.name}`);
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (events.some(e => String(e.event).startsWith('unsupported:'))) throw new Error(`UNSUPPORTED_BOUNDARY:${scenario.name}`);
    if (scenario.name === 'access-allowed' && !events.some(e => e.event === 'access-token:usage-stamp')) throw new Error('TOKEN_USAGE_STAMP_MISSING');
    results.push({ name: scenario.name, stateSha256: sha(JSON.stringify(state)), response: result, draining, events });
  } finally {
    await stop(child);
  }
}
await writeFile(`${stateDir}/observations.json`, JSON.stringify({ fixture: 'research-only', results }, null, 2), { mode: 0o600 });
