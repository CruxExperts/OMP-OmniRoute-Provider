const NAMESPACE = "feature_flags";

// Flag reads sit on hot paths that call them once per string leaf of a request
// body (sanitizePII, the PII masker guardrail), so a synchronous SELECT per
// read turned a 2 MB agentic request into a thousand SQLite round trips. The
// cache is invalidated by every writer in this module; the short TTL only
// covers edits made to the store from outside this process. It is keyed by the
// database instance so a reopened store (tests, resetDbInstance) starts clean.
const OVERRIDE_CACHE_TTL_MS = 1000;
type OverrideCacheEntry = { value: string | undefined; expiresAt: number };
const overrideCaches = new WeakMap<object, Map<string, OverrideCacheEntry>>();

function overrideCacheFor(db: object): Map<string, OverrideCacheEntry> {
  let cache = overrideCaches.get(db);
  if (!cache) {
    cache = new Map();
    overrideCaches.set(db, cache);
  }
  return cache;
}

export function clearFeatureFlagOverrideCache(key?: string): void {
  const cache = overrideCaches.get(getDbInstance());
  if (!cache) return;
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

export function getFeatureFlagOverride(key: string): string | undefined {
  const db = getDbInstance();
  const cache = overrideCacheFor(db);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key) as { value: string } | undefined;
  cache.set(key, { value: row?.value, expiresAt: now + OVERRIDE_CACHE_TTL_MS });
  return row?.value;
}
