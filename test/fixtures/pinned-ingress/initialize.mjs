// Load before Next. This process owns only research fixture state.
import { readFileSync, appendFileSync } from 'node:fs';
const path = process.env.INGRESS_STATE_FILE;
const log = process.env.INGRESS_EVENT_FILE;
if (!path?.startsWith('/work/data/') || !log?.startsWith('/work/data/')) throw new Error('INGRESS_SANDBOX_PATH_REQUIRED');
const state = JSON.parse(readFileSync(path, 'utf8'));
if (state.bypass === 'disabled') globalThis.__omniroute_authzBypass_config__ = { enabled: false, prefixes: ['/api/mcp/'] };
else if (state.bypass !== 'source-default') throw new Error('INGRESS_INVALID_BYPASS');
if (state.syncToken) globalThis.__omnirouteModelSyncInternalAuthToken = state.syncToken;
globalThis.__omnirouteShutdown = { init: false, shuttingDown: false, activeRequests: 0 };
process.on('SIGUSR2', () => {
  globalThis.__omnirouteShutdown.shuttingDown = !globalThis.__omnirouteShutdown.shuttingDown;
  appendFileSync(log, JSON.stringify({ event: 'fixture:draining', value: globalThis.__omnirouteShutdown.shuttingDown }) + '\n', { mode: 0o600 });
});
