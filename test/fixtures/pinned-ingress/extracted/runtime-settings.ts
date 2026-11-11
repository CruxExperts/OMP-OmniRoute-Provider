
interface AuthzBypassSnapshot {
  enabled: boolean;
  prefixes: string[];
}

const DEFAULT_AUTHZ_BYPASS_SNAPSHOT: AuthzBypassSnapshot = {
  enabled: true,
  prefixes: ["/api/mcp/"],
};

const AUTHZ_BYPASS_GLOBAL_KEY = "__omniroute_authzBypass_config__";

const _authzBypassStore = globalThis as unknown as Record<string, AuthzBypassSnapshot | undefined>;

function getCurrentAuthzBypass(): AuthzBypassSnapshot {
  if (!_authzBypassStore[AUTHZ_BYPASS_GLOBAL_KEY]) {
    _authzBypassStore[AUTHZ_BYPASS_GLOBAL_KEY] = DEFAULT_AUTHZ_BYPASS_SNAPSHOT;
  }
  return _authzBypassStore[AUTHZ_BYPASS_GLOBAL_KEY]!;
}

export function getAuthzBypassSnapshot(): AuthzBypassSnapshot {
  return getCurrentAuthzBypass();
}
