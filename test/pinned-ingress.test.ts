import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectedHealthIngressIdentities, validateHealthIngressEvidence } from "../scripts/generate-contracts.ts";
import type { OperationEvidenceBinding } from "../src/admin/eligibility.ts";

const runner = resolve(import.meta.dir, "../scripts/pinned-ingress.py");

test("read ingress rejects missing, contradictory, duplicate, and source-mismatched policy", () => {
  const root = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(resolve(root, "test/fixtures/pinned-ingress/source-manifest.json"), "utf8")) as { commit: string; archiveSha256: string };
  const runtime = JSON.parse(readFileSync(resolve(root, "test/fixtures/pinned-ingress/runtime.json"), "utf8")) as { nodeVersion: string; nodeSha256: string };
  const identities = expectedHealthIngressIdentities("3.8.53", manifest.commit);
  const declarationPath = "test/pinned-ingress.test.ts.inputs.json";
  const declaration = JSON.parse(readFileSync(resolve(root, declarationPath), "utf8")) as { files: string[] };
  const sha256 = Object.fromEntries(["test/pinned-ingress.test.ts", declarationPath, ...declaration.files].map(path => [path, createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")]));
  const publicCase = (name: string, bypass: string) => ({ name, input: { method: "GET", path: "/api/health", bypass, credential: "none", requireLogin: true, setupComplete: true }, observed: { status: 200, routeClass: "PUBLIC", successMarkerPresent: true, usageStampObserved: false } });
  const policies = ["/api/fallback/chains", "/api/providers/fixture-id/cc-alias", "/api/provider-nodes"].map(path => ({ method: "GET", path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 }));
  const artifact = {
    schemaVersion: 1, classification: "research-only-not-qualification",
    source: { version: "3.8.53", commit: manifest.commit, archiveSha256: manifest.archiveSha256, addedSourceSha256: identities.addedSourceSha256, pingDeclarationSha256: identities.pingDeclarationSha256 },
    inputs: { sha256, nodeSha256: runtime.nodeSha256, runtime: { node: runtime.nodeVersion, next: "16.4.2", react: "19.2.8", "react-dom": "19.2.8" }, sourceOverlaySha256: identities.sourceOverlaySha256, executedOverlaySha256: identities.executedOverlaySha256 },
    isolation: { namespacesDistinct: true, memoryLimitEnforced: true, cpuLimitEnforced: true, privateLoopbackOnly: true, environmentAllowlisted: true },
    health: [{ method: "GET", path: "/api/health", status: 200, bodyKeys: ["status", "timestamp"], timestamp: "2026-01-01T00:00:00.000Z", cacheControl: "no-store" }],
    publicHealthHttp: { method: "GET", path: "/api/health", anonymous: true, status: 200, bodyKeys: ["status", "timestamp"], timestampFormatAndRequestWindowValid: true, cacheControl: "no-store, no-cache, must-revalidate", contentType: "application/json", routeClass: "PUBLIC", requestIdUuid: true, drain: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Server is shutting down", requestIdUuid: true, correlationMatchesRequestId: true, retryAfter: "5", contentType: "application/json", routeClass: "PUBLIC", recoveryStatus: 200 }, cors: { configuredAllowedOrigin: "https://allowed.example", allowedOriginEchoed: true, unlistedOriginOmitted: true, credentialsOmitted: true } },
    sharedAuthentication: [publicCase("default-bypass-health", "source-default"), publicCase("disabled-bypass-health", "disabled")],
    publicHealthIpFilter: { enabled: true, mode: "blacklist", configReadObserved: true, forwardedAddressFallback: { deniedStatus: 403, error: "IP blacklisted", recoveryStatus: 200, routeClass: "PUBLIC", requestIdUuid: true, allowedOriginEchoed: true } },
    readPolicy: policies,
    modelCapabilityOverridesPolicy: { method: "GET", path: "/api/model-capability-overrides", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 },
  };
  const cases = [
    ["GET /api/fallback/chains", "src/app/api/fallback/chains/route.ts"],
    ["GET /api/providers/{id}/cc-alias", "src/app/api/providers/[id]/cc-alias/route.ts"],
    ["GET /api/provider-nodes", "src/app/api/provider-nodes/route.ts"],
  ] as const;
  function check(value: unknown, binding: OperationEvidenceBinding, operation: string, error?: RegExp) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = `provenance/qualification/ingress-${digest}.json`;
    const absolute = resolve(root, path);
    writeFileSync(absolute, bytes, { flag: "wx" });
    try {
      const validate = () => validateHealthIngressEvidence({ artifact: path, sha256: digest }, binding, operation);
      if (error) expect(validate).toThrow(error); else expect(validate).not.toThrow();
    } finally { rmSync(absolute); }
  }
  for (const [index, [operation, route]] of cases.entries()) {
    const binding = { handlerSha256: (identities.addedSourceSha256 as Record<string, string>)[route] } as OperationEvidenceBinding;
    check(artifact, binding, operation);
    check({ ...artifact, readPolicy: undefined }, binding, operation, /read policy observation mismatch/);
    check({ ...artifact, readPolicy: policies.filter((_, i) => i !== index) }, binding, operation, /read policy observation mismatch/);
    check({ ...artifact, readPolicy: [...policies, policies[index]] }, binding, operation, /read policy observation mismatch/);
    for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "PATCH"]] as const) {
      check({ ...artifact, readPolicy: policies.map((policy, i) => i === index ? { ...policy, [key]: value } : policy) }, binding, operation, /read policy observation mismatch/);
    }
    check(artifact, { ...binding, handlerSha256: "0".repeat(64) }, operation, /source mismatch/);
    check({ ...artifact, source: { ...artifact.source, addedSourceSha256: { ...(identities.addedSourceSha256 as Record<string, unknown>), [route]: "0".repeat(64) } } }, binding, operation, /source mismatch/);
  }
  const capabilityBinding = { handlerSha256: (identities.addedSourceSha256 as Record<string, string>)["src/app/api/model-capability-overrides/route.ts"] } as OperationEvidenceBinding;
  const capabilityOperation = "GET /api/model-capability-overrides";
  check(artifact, capabilityBinding, capabilityOperation);
  check({ ...artifact, modelCapabilityOverridesPolicy: undefined }, capabilityBinding, capabilityOperation, /capability policy observation mismatch/);
  for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "PATCH"]] as const) {
    check({ ...artifact, modelCapabilityOverridesPolicy: { ...artifact.modelCapabilityOverridesPolicy, [key]: value } }, capabilityBinding, capabilityOperation, /capability policy observation mismatch/);
  }
  check(artifact, { ...capabilityBinding, handlerSha256: "0".repeat(64) }, capabilityOperation, /source mismatch/);
}, 120_000);

test("ingress rejects an unapproved Node executable before starting the sandbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-"));
  try {
    const node = join(dir, "node");
    const archive = join(dir, "source.tar.gz");
    writeFileSync(node, "wrong runtime");
    writeFileSync(archive, "wrong source");
    const result = spawnSync("python3", [runner, "--node", node, "--source-archive", archive, "--dependency-dir", dir, "--output-dir", dir], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Node runtime mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingress rejects archive path traversal before materialization", () => {
  const code = `
import importlib.util,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for name in ('../escape', '/absolute', 'a/../../escape', 'a\\\\b'):
 try: module.safe_parts(name)
 except RuntimeError: continue
 raise AssertionError(name)
assert module.safe_parts('node_modules/example/package.json') == ('node_modules','example','package.json')
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.status).toBe(0);
});

test("dependency materialization enforces exact bytes and safe file identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-dependency-"));
  try {
    const code = `
import base64,hashlib,importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2]); data=b'approved'; path=root/(('a'*64)+'.tgz'); path.write_bytes(data)
item={'name':'example','file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'integrity':'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()}
assert module.verified_dependency(root,item)==data
path.write_bytes(b'tampered')
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'integrity mismatch' in str(error)
else: raise AssertionError('tampered dependency accepted')
path.unlink()
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'missing or wrong-size' in str(error)
else: raise AssertionError('missing dependency accepted')
item['file']='../escape.tgz'
try: module.verified_dependency(root,item)
except RuntimeError as error: assert 'invalid package file identity' in str(error)
else: raise AssertionError('escaped dependency accepted')
if os.name != 'nt':
 item['file']=path.name; target=root/'other'; target.write_bytes(data); path.symlink_to(target)
 try: module.verified_dependency(root,item)
 except RuntimeError as error: assert 'missing or wrong-size' in str(error)
 else: raise AssertionError('dependency symlink accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("staging rejects unapproved URLs, pre-existing paths, and oversized downloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-stage-"));
  try {
    const code = `
import importlib.util,io,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for url in ('http://registry.npmjs.org/a.tgz', 'https://registry.npmjs.org.evil.example/a', 'https://user@registry.npmjs.org/a'):
 try: module.validate_url(url, {'registry.npmjs.org'})
 except RuntimeError: continue
 raise AssertionError(url)
module.validate_url('https://registry.npmjs.org/pkg/-/pkg-1.tgz', {'registry.npmjs.org'})
root=pathlib.Path(sys.argv[2]);
for path,approval in ((root/'new','wrong'), (root,module.NODE_ARCHIVE_SHA)):
 try: module.stage(path, approval)
 except RuntimeError: continue
 raise AssertionError('unsafe stage accepted')
module.validate_bwrap=lambda value: value
module.preflight=lambda: None
sys.argv=['pinned-ingress.py','--stage-dir',str(root/'cli-new'),'--approve-node-archive-sha256','wrong']
try: module.main()
except RuntimeError as error: assert 'approval' in str(error).lower()
else: raise AssertionError('CLI accepted an unapproved Node archive')
class Response(io.BytesIO):
 def __enter__(self): return self
 def __exit__(self,*args): self.close()
class Opener:
 def open(self,*args,**kwargs): return Response(b'oversized')
module.urllib.request.build_opener=lambda *args: Opener()
try: module.download('https://registry.npmjs.org/pkg/-/pkg-1.tgz',root/'file',3)
except RuntimeError as error: assert 'byte limit' in str(error)
else: raise AssertionError('oversized download accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bubblewrap staging rejects missing approval, unsafe paths, tampering, and oversized output", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-bwrap-"));
  try {
    const code = `
import importlib.util,io,pathlib,sys
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2])
for path in (None, pathlib.Path('relative/bwrap'), root/'missing'):
 try: module.validate_bwrap(path)
 except RuntimeError: continue
 raise AssertionError('unsafe path accepted')
try: module.stage_bwrap(root/'new', 'wrong')
except RuntimeError as error: assert 'approval' in str(error)
else: raise AssertionError('missing approval accepted')
package=root/'bubblewrap.deb'; package.write_bytes(b'tampered')
try: module.bwrap_members(package)
except RuntimeError as error: assert 'identity mismatch' in str(error)
else: raise AssertionError('tampered package accepted')
module.acquisition_preflight=lambda: None
try: module.stage_bwrap(root, module.BWRAP_SHA)
except RuntimeError as error: assert 'already exists' in str(error)
else: raise AssertionError('existing stage accepted')
executable=root/'bwrap'; executable.write_bytes(b'tampered'); executable.chmod(0o755)
module.bwrap_members_original=module.bwrap_members
module.bwrap_members=lambda path: {'bwrap':b'approved','copyright':b'license'}
try: module.validate_bwrap(executable)
except RuntimeError as error: assert 'identity mismatch' in str(error)
else: raise AssertionError('tampered executable accepted')
class Proc:
 def __init__(self,*args,**kwargs): self.stdout=io.BytesIO(b'x'*(module.BWRAP_LIMIT+1)); self.done=False
 def poll(self): return 0 if self.done else None
 def kill(self): self.done=True
 def wait(self,timeout=None): self.done=True; return 0
module.subprocess.Popen=Proc
module.file_sha=lambda path: module.BWRAP_SHA
package.write_bytes(b'x'*56876)
try: module.bwrap_members_original(package)
except RuntimeError as error: assert 'byte limit' in str(error)
else: raise AssertionError('oversized archive accepted')
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("hosted AppArmor profile rejects unauthorized and unsafe attachment contexts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-profile-"));
  try {
    const code = `
import importlib.util,os,pathlib,sys,types
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.sys.platform='linux'; m.os.uname=lambda: types.SimpleNamespace(machine='x86_64')
root=pathlib.Path(sys.argv[2]); os.environ.update(CI='true',GITHUB_ACTIONS='true',GITHUB_EVENT_NAME='workflow_dispatch',RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='Linux',GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',RUNNER_TEMP=str(root))
def rejected(f):
 try: f()
 except RuntimeError: return
 raise AssertionError('unsafe context accepted')
rejected(lambda: m.ci_profile_context(False))
for key,value in [('RUNNER_ENVIRONMENT','self-hosted'),('GITHUB_EVENT_NAME','push'),('GITHUB_RUN_ID','123*')]:
 old=os.environ[key]; os.environ[key]=value; rejected(lambda: m.ci_profile_context(True)); os.environ[key]=old
bad=root/'bad*path'; bad.mkdir(); os.environ['RUNNER_TEMP']=str(bad); rejected(lambda: m.ci_profile_context(True))
os.environ['RUNNER_TEMP']=str(root)
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("hosted AppArmor lifecycle refuses collisions and uncertain cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingress-profile-"));
  try {
    const code = `
import importlib.util,os,pathlib,sys,types
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.sys.platform='linux'; m.os.uname=lambda: types.SimpleNamespace(machine='x86_64')
root=pathlib.Path(sys.argv[2]); os.environ.update(CI='true',GITHUB_ACTIONS='true',GITHUB_EVENT_NAME='workflow_dispatch',RUNNER_ENVIRONMENT='github-hosted',RUNNER_OS='Linux',GITHUB_RUN_ID='123',GITHUB_RUN_ATTEMPT='1',RUNNER_TEMP=str(root))
path,name,source,state=m.ci_profile_context(True); path.parent.mkdir(); path.write_bytes(b'test helper')
m.os.access=lambda *args: True
m.validate_bwrap=lambda p: p
loaded=[]
m.ci_profiles=lambda name: list(loaded)
def rejected(f):
 try: f()
 except RuntimeError: return
 raise AssertionError('unsafe lifecycle accepted')
access=m.os.access
m.os.access=lambda *args: False
rejected(lambda: m.ci_profile(True)); assert not state.exists()
m.os.access=access
loaded.append(name+' (unconfined)'); rejected(lambda: m.ci_profile(True)); assert not state.exists(); loaded.clear()
state.write_text('{}'); rejected(lambda: m.ci_profile(True,cleanup=True)); assert state.exists(); state.unlink()
def parser(args,**kwargs):
 if args[-1]=='-a': loaded.append(name+' (unconfined)')
 else: loaded.clear()
 return types.SimpleNamespace(returncode=0)
m.subprocess.run=parser
m.ci_profile(True); assert state.exists() and loaded
rejected(lambda: m.ci_profile(True))
m.ci_profile(True,cleanup=True); assert not state.exists() and not loaded
m.ci_profile(True); loaded.clear(); m.ci_profile(True,cleanup=True); assert not state.exists()
calls=[]
def timed_parser(args,**kwargs):
 calls.append(args[-1])
 if args[-1]=='-a':
  if install_before_timeout: loaded.append(name+' (unconfined)')
  raise m.subprocess.TimeoutExpired(args,30)
 loaded.clear()
 return types.SimpleNamespace(returncode=0)
m.subprocess.run=timed_parser
for install_before_timeout in (True,False):
 calls.clear()
 try: m.ci_profile(True)
 except m.subprocess.TimeoutExpired: pass
 else: raise AssertionError('load did not time out')
 assert state.exists() and bool(loaded)==install_before_timeout
 m.ci_profile(True,cleanup=True)
 assert not state.exists() and not loaded
 assert calls==(['-a','-R'] if install_before_timeout else ['-a'])
`;
    const result = spawnSync("python3", ["-c", code, runner, dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture database identity and feature flag reads stay bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-flags-"));
  try {
    const source = readFileSync(resolve(import.meta.dir, "fixtures/pinned-ingress/backend/core.ts"), "utf8");
    const importLine = 'import { API_KEY_COLUMN_FALLBACKS } from "@/lib/db/apiKeyColumnFallbacks";';
    expect(source.split(importLine)).toHaveLength(2);
    const code = source.replace(importLine, "const API_KEY_COLUMN_FALLBACKS: { name: string }[] = [];")
      .replaceAll('"/work/data/"', JSON.stringify(`${dir}/`)) + `
const first = getDbInstance();
if (first !== getDbInstance()) throw new Error("database identity changed");
const query = first.prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?");
if (process.env.EXPECT_FAILURE === "1") {
  try { query.get("feature_flags", "sample"); throw new Error("read unexpectedly succeeded"); }
  catch (error) { if (!(error instanceof Error) || error.message !== "INGRESS_FEATURE_FLAG_BACKEND_ERROR") throw error; }
} else {
  if (query.get("feature_flags", "sample")?.value !== "enabled") throw new Error("override missing");
  if (query.get("feature_flags", "missing") !== undefined || query.get("feature_flags", "toString") !== undefined) throw new Error("unexpected override");
}
`;
    const script = join(dir, "core.ts"), state = join(dir, "state.json"), events = join(dir, "events.jsonl");
    writeFileSync(script, code);
    writeFileSync(events, "");
    for (const fail of [false, true]) {
      writeFileSync(state, JSON.stringify({ tokens: [], featureFlags: { sample: "enabled" }, failFeatureFlagRead: fail }));
      const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, INGRESS_STATE_FILE: state, INGRESS_EVENT_FILE: events, EXPECT_FAILURE: fail ? "1" : "0" } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line).event)).toEqual(Array(4).fill("feature-flag:read"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source flag cache respects expiry, misses, explicit invalidation and database identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "pinned-ingress-cache-"));
  try {
    const source = readFileSync(resolve(import.meta.dir, "fixtures/pinned-ingress/extracted/feature-flag-cache.ts"), "utf8");
    const code = `
let now = 1000, reads = 0, fail = false;
Date.now = () => now;
const values: Record<string, string> = { flag: "one" };
function makeDb() { return { prepare(sql: string) { if (sql !== "SELECT value FROM key_value WHERE namespace = ? AND key = ?") throw new Error("unexpected query"); return { get(namespace: string, key: string) { if (namespace !== "feature_flags") throw new Error("unexpected namespace"); reads++; if (fail) throw new Error("backend failure"); return Object.hasOwn(values, key) ? { value: values[key] } : undefined; } }; } }; }
let db = makeDb(); function getDbInstance() { return db; }
` + source + `
if (getFeatureFlagOverride("flag") !== "one" || reads !== 1) throw new Error("initial read");
values.flag = "two";
if (getFeatureFlagOverride("flag") !== "one" || reads !== 1) throw new Error("cache miss");
now += 1000;
if (getFeatureFlagOverride("flag") !== "two" || reads !== 2) throw new Error("expiry");
if (getFeatureFlagOverride("missing") !== undefined || getFeatureFlagOverride("missing") !== undefined || reads !== 3) throw new Error("negative cache");
clearFeatureFlagOverrideCache("flag"); values.flag = "three";
if (getFeatureFlagOverride("flag") !== "three" || reads !== 4) throw new Error("invalidation");
db = makeDb(); if (getFeatureFlagOverride("flag") !== "three" || reads !== 5) throw new Error("database identity");
clearFeatureFlagOverrideCache(); fail = true;
try { getFeatureFlagOverride("flag"); throw new Error("failure swallowed"); } catch (error) { if (!(error instanceof Error) || error.message !== "backend failure") throw error; }
fail = false; if (getFeatureFlagOverride("flag") !== "three" || reads !== 7) throw new Error("failure cached");
`;
    const script = join(dir, "cache.ts"); writeFileSync(script, code);
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("read closure extraction rejects source and boundary drift before writing", () => {
  const code = String.raw`
import importlib.util, pathlib, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
api = '''let _schemaChecked = false;
async function deleteRedisAuthCacheEntry(
function markApiKeyUsed(
async function getModelPermissionCandidates(
function ensureApiKeysColumns(
export async function getApiKeys(
async function hashKey(
export async function createApiKey(
marker_create();
export async function regenerateApiKey(
export async function deleteApiKey( marker_delete();
/**
 * Revoke an API key by id.
export async function validateApiKey(
/**
 * Check if a model is allowed for a given API key
function clearPreparedStatementCache() { marker_reset(); }
'''
flags = '''const NAMESPACE = "feature_flags";
const CATALOG_RELEVANT_FEATURE_FLAGS =
export function getFeatureFlagOverrides()
/**
 * Persists (or replaces) an override
'''
cache = '''type CacheEntry<T> = { value: T };
const settingsCache = marker_cache;
/**
 * Cached wrapper for getSettings.
export async function getCachedSettings() { marker_settings(); }
export async function getCachedBodySizeSettings() { marker_body(); }
/**
 * Cached wrapper for getPricing.
const rawConnectionsCache = marker_raw;
/**
 * Cached wrapper for getRawProviderConnections.
const connectionByIdCache = marker_id;
/**
 * Cached wrapper for getProviderConnectionById.
let combosCacheVersion = 0;
/**
 * Current combo-cache version.
let modelCatalogCacheVersion = 0;
/**
 * Connection fields written by the chat path
export function invalidateDbCache() { marker_invalidate(); }
'''
encryption = '''import { createCipheriv, marker_crypto };
/** Connection object with potentially encrypted credential fields.
import fs from "fs";
import { mapProviderSpecificDataSecrets
function ensureSecretLoaded() { marker_secret(); }
/**
 * Loud production warning
export function looksEncrypted( marker_encrypt();
/**
 * #11500
'''
compliance = '''function getDb() { marker_db(); }
type AuditLogWriteEntry
const AUDIT_LOG_REQUIRED_COLUMNS: marker_schema;
type AuditLogQuery
type ApiKeyAuthTouchDbState = marker_audit;
/**
 * Query audit log entries.
'''
backup = '''let _lastBackupAt = 0;
function setStoredDbBackupInteger(
export function getDbBackupMaxFiles() { marker_retention(); }
/** Persist the operator-chosen age-based
export function getDbBackupRetentionDays() { marker_days(); }
function sleep(
export function backupDbFile( marker_backup();
// ──────────────── List Backups
'''
with tempfile.TemporaryDirectory() as tmp:
 app = pathlib.Path(tmp); contents = dict(zip(m.READ_CLOSURES, (api, flags, cache, encryption, compliance, backup)))
 manifest = {'selectedFiles': {}, 'additionalFiles': {}}
 for name, text in contents.items():
  path = app/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)
  m.READ_CLOSURES[name] = m.sha(text.encode()); manifest['selectedFiles'][name] = {'sha256': m.sha(text.encode())}
 result = m.read_closures(app, manifest)
 assert b'marker_reset' in result[next(iter(contents))]
 assert b'marker_settings' in result['src/lib/db/readCache.ts'] and b'marker_body' in result['src/lib/db/readCache.ts']
 assert b'marker_create' in result['src/lib/db/apiKeys.ts'] and b'marker_delete' in result['src/lib/db/apiKeys.ts']
 assert b'marker_secret' in result['src/lib/db/encryption.ts'] and b'marker_encrypt' in result['src/lib/db/encryption.ts']
 assert b'marker_schema' in result['src/lib/compliance/index.ts'] and b'marker_audit' in result['src/lib/compliance/index.ts']
 assert b'marker_retention' in result['src/lib/db/backup.ts'] and b'marker_backup' in result['src/lib/db/backup.ts']
 flag_fixture = (m.FIXTURE/'extracted/feature-flag-cache.ts').read_text()
 prefix, marker, suffix = flag_fixture.partition('export function getFeatureFlagOverride(key: string)')
 flag_source = prefix + 'const unrelated = 1;\n' + marker + suffix
 m.verify_flag_cache_fixture(flag_source, flag_fixture)
 for altered in (flag_fixture.replace('OVERRIDE_CACHE_TTL_MS = 1000', 'OVERRIDE_CACHE_TTL_MS = 999'), flag_fixture + 'changed'):
  try: m.verify_flag_cache_fixture(flag_source, altered); raise AssertionError('fixture drift accepted')
  except RuntimeError: pass
 try: m.verify_flag_cache_fixture(flag_source + marker + suffix, flag_fixture); raise AssertionError('ambiguous fixture accepted')
 except RuntimeError: pass
 path = app/'src/lib/db/readCache.ts'; path.write_text(cache + 'drift')
 try: m.read_closures(app, manifest); raise AssertionError('source drift accepted')
 except RuntimeError: pass
 changed = cache.replace('const rawConnectionsCache =', 'const alteredCache ='); path.write_text(changed)
 m.READ_CLOSURES['src/lib/db/readCache.ts'] = m.sha(changed.encode()); manifest['selectedFiles']['src/lib/db/readCache.ts']['sha256'] = m.sha(changed.encode())
 try: m.read_closures(app, manifest); raise AssertionError('boundary drift accepted')
 except RuntimeError: pass
 changed = cache + '\nexport function invalidateDbCache() {}'; path.write_text(changed)
 m.READ_CLOSURES['src/lib/db/readCache.ts'] = m.sha(changed.encode()); manifest['selectedFiles']['src/lib/db/readCache.ts']['sha256'] = m.sha(changed.encode())
 try: m.read_closures(app, manifest); raise AssertionError('ambiguous suffix accepted')
 except RuntimeError: pass
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("source overlays reject missing or mismatched originals and replacements before copying", () => {
  const code = String.raw`
import importlib.util, json, pathlib, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root = pathlib.Path(temp); app = root/'app'; fixture = root/'fixture'; app.mkdir(); fixture.mkdir()
 mapping = json.loads((m.FIXTURE/'alias-map.json').read_text()); manifest = {'selectedFiles':{},'additionalFiles':{},'nextConfig':{}}
 config = b'config'; (app/'next.config.upstream.mjs').write_bytes(config); mapping['originalConfigSha256'] = m.sha(config); manifest['nextConfig']['sha256'] = m.sha(config)
 for alias in mapping['aliases']:
  original = b'export const value = 1;\n'; replacement = original if alias['kind'] == 'declaration-extraction' else b'fixture'
  source = app/alias['source']; target = fixture/alias['replacement']; source.parent.mkdir(parents=True, exist_ok=True); target.parent.mkdir(parents=True, exist_ok=True); source.write_bytes(original); target.write_bytes(replacement)
  alias['sourceSha256'] = m.sha(original); alias['replacementSha256'] = m.sha(replacement); manifest['selectedFiles'][alias['source']] = {'sha256':m.sha(original)}
 (fixture/'alias-map.json').write_text(json.dumps(mapping))
 def rejected():
  try: m.overlay_plan(app, fixture, manifest)
  except (RuntimeError, FileNotFoundError): return
  raise AssertionError('invalid overlay accepted')
 for alias in mapping['aliases']:
  for path in (app/alias['source'], fixture/alias['replacement']):
   original = path.read_bytes(); path.write_bytes(b'tampered'); rejected(); path.unlink(); rejected(); path.write_bytes(original)
 aliases = m.overlay_plan(app, fixture, manifest)
 result = m.apply_overlays(app, fixture, aliases)
 assert len(result) == 6 and all(m.sha((app/a['source']).read_bytes()) == result[a['source']]['executedSha256'] for a in aliases)
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("ingress failure evidence is bounded, source-bound, and excludes private data", () => {
  const code = String.raw`
import importlib.util, json, pathlib, subprocess, sys, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root = pathlib.Path(temp); output = root/'ingress-run'; output.mkdir()
 hashes = {'tracked': 'a'*64}; m.input_hashes = lambda: hashes
 state = output/'failure-state.json'
 state.write_text(json.dumps({'stage':'build','exceptionClass':'CalledProcessError','returnCode':-9}))
 (output/'build.private').write_text('private-canary /path/private-account token\nModule not found: cannot find module secret-package\nEROFS: read-only file system\n')
 assert m.worker_failure_state(output) == ('build','CalledProcessError',-9)
 m.write_failure(output, hashes, *m.worker_failure_state(output))
 artifact = json.loads((root/'failure.json').read_text())
 assert set(artifact) == {'schemaVersion','classification','stage','exceptionClass','exitCode','signal','sourceCommit','sourceArchiveSha256','nodeSha256','trackedInputsSha256','compilerSignals'}
 assert artifact['compilerSignals'] == ['module-not-found','read-only-output']
 (output/'build.private').write_text('private-canary unknown compiler failure')
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').write_text('  42 | // permission denied or EACCES may occur\n> 43 | throw new Error("permission denied");\n')
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').write_text('Error: EACCES: permission denied, open private-path\n')
 assert m.compiler_failure_signals(output) == ['permission-denied']
 (output/'build.private').unlink(); (output/'build.private').symlink_to(state)
 assert m.compiler_failure_signals(output) == []
 (output/'build.private').unlink()
 assert m.compiler_failure_signals(output) == []
 assert artifact['stage'] == 'build' and artifact['signal'] == 9 and artifact['exitCode'] is None
 assert artifact['sourceCommit'] == m.COMMIT and artifact['nodeSha256'] == m.NODE_SHA and artifact['sourceArchiveSha256'] == m.ARCHIVE_SHA
 assert artifact['trackedInputsSha256'] == m.sha(json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode())
 assert m.failure_class(m.CandidateFailed(42)) == 'CalledProcessError' and m.failure_code(m.CandidateFailed(42)) == 42
 assert m.failure_class(RuntimeError('private-canary /path token')) == 'RuntimeError'
 assert 'private-canary' not in json.dumps(artifact) and '/path' not in json.dumps(artifact)
 for bad in ({'stage':'private-canary','exceptionClass':'RuntimeError','returnCode':1}, {'stage':'build','exceptionClass':'RuntimeError','returnCode':True}, {'stage':'build','exceptionClass':'private-canary','returnCode':1}):
  state.write_text(json.dumps(bad)); assert m.worker_failure_state(output) == ('preflight',None,None)
 try: m.write_failure(output, hashes, 'build', 'RuntimeError', 1)
 except FileExistsError: pass
 else: raise AssertionError('existing artifact overwritten')
 (root/'failure.json').unlink(); hashes['changed'] = 'b'*64
 try: m.write_failure(output, {'tracked':'a'*64}, 'export', 'RuntimeError', None)
 except RuntimeError: pass
 else: raise AssertionError('changed source accepted')
 assert not (root/'failure.json').exists()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("ingress export rejects incomplete and contradictory observations and never copies private fields", () => {
  const code = String.raw`
import importlib.util, io, json, pathlib, sys, tarfile, tempfile
s = importlib.util.spec_from_file_location('ingress', sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 p = pathlib.Path(temp); (p / 'data').mkdir()
 def put(name, value): (p / name).write_text(json.dumps(value))
 hashes = m.input_hashes()
 fixture = p/'fixture'; (fixture/'backend').mkdir(parents=True)
 core = b'const db = {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n};\n'
 settings = b'export const fixture = true;\n'
 (fixture/'backend/core.ts').write_bytes(core); (fixture/'backend/settings.ts').write_bytes(settings)
 for name, data in [('backend/core.ts',core),('backend/settings.ts',settings)]: hashes['test/fixtures/pinned-ingress/'+name] = m.sha(data)
 declaration = b'export function pingDb(): boolean {\n  return true;\n}'
 aliases = json.loads((m.FIXTURE/'alias-map.json').read_text())['aliases']
 names = set(m.ROUTES) | set(m.POLICY_SOURCES) | set(m.READ_CLOSURES) | {'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts','src/proxy.ts'} | {a['source'] for a in aliases}
 sources = {name: ('source:'+name).encode() for name in names}; sources['src/lib/db/core.ts'] = b'// source\n'+declaration+b'\n'
 m.READ_CLOSURES = {name:m.sha(sources[name]) for name in m.READ_CLOSURES}
 m.read_closures = lambda app, manifest: {name:(app/name).read_bytes()+b':executed' for name in m.READ_CLOSURES}
 for alias in aliases:
  alias['sourceSha256'] = m.sha(sources[alias['source']]); alias['replacementSha256'] = hashes['test/fixtures/pinned-ingress/'+alias['replacement']]
 map_bytes = json.dumps({'aliases':aliases}).encode(); (fixture/'alias-map.json').write_bytes(map_bytes)
 hashes['test/fixtures/pinned-ingress/alias-map.json'] = m.sha(map_bytes)
 archive_path = p/'source.tar.gz'
 with tarfile.open(archive_path, 'w:gz') as archive:
  for name, data in sources.items():
   member = tarfile.TarInfo('OmniRoute-v3.8.53/'+name); member.size = len(data); archive.addfile(member, io.BytesIO(data))
 m.SOURCE = archive_path; m.ARCHIVE_SHA = m.sha(archive_path.read_bytes()); m.FIXTURE = fixture
 manifest = {'selectedFiles':{'src/proxy.ts':{'sha256':m.sha(sources['src/proxy.ts'])}}}
 manifest_bytes = json.dumps(manifest).encode(); (fixture/'source-manifest.json').write_bytes(manifest_bytes)
 hashes['test/fixtures/pinned-ingress/source-manifest.json'] = m.sha(manifest_bytes)
 expected_core = (b'import { DatabaseSync } from "node:sqlite";\nimport path from "node:path";\nlet sqlite: DatabaseSync | undefined;\n'
  b'const db = {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n'
  b'      if (normalized === "SELECT 1 AS ok" || (/^SELECT /i.test(normalized) && /\\bFROM usage_history\\b/i.test(normalized))) {\n'
  b'        event("sqlite:read");\n        sqlite ??= new DatabaseSync("/work/data/metrics.sqlite");\n'
  b'        return sqlite.prepare(sql);\n      }\n};\n\nexport const DB_BACKUPS_DIR = isCloud ? null : path.join(DATA_DIR, "db_backups");\n'+declaration+b'\n')
 expected_settings = settings+b'\nexport { getCacheMetrics, resetCacheMetrics } from "@/lib/db/settings/cacheMetrics";\n'
 material = {'archiveSha256': m.ARCHIVE_SHA, 'webpackDeviation': False, 'bundler':'next-default', 'selectedSourceFiles': 509, 'configSupportSha256':{'src/proxy.ts':m.sha(sources['src/proxy.ts'])}}
 put('result.json', {'status':'research-observed', 'qualification':False, 'materialization':material})
 put('materialization.json', material)
 put('host-namespaces.json', {k:'host' for k in ('user','mnt','net','pid')})
 put('preflight.json', {'namespaces':{k:'sandbox' for k in ('user','mnt','net','pid')}, 'memoryMax':m.MEMORY, 'cpuAffinity':[0], 'network':'private-loopback-only', 'nodeSha256':m.NODE_SHA, 'environmentKeys':['PATH'], 'mountInfo':'private-canary'})
 identity_names = set(m.ROUTES) | set(m.POLICY_SOURCES) | {'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts'}
 identity = {'sourceCommit':m.COMMIT,'sourceVersion':'3.8.53','archiveSha256':m.ARCHIVE_SHA,'nodeSha256':m.NODE_SHA,'runtime':{'node':'24.17.0','next':'16.4.2','react':'19.2.8','react-dom':'19.2.8'},'addedSourceSha256':{k:m.sha(sources[k]) for k in identity_names},'pingDeclarationSha256':m.sha(declaration),'runtimeInputSha256':{n:hashes['test/fixtures/pinned-ingress/'+n] for n in ('source-manifest.json','dependencies.json','runtime.json')}}
 for name in ('src/app/api/health/degradation/route.ts','src/domain/degradation.ts'):
  data = sources[name]; executed = b'import "./fixture-control";\n'+data if name.endswith('/route.ts') else data
  identity['addedSourceSha256'][name] = {'originalSha256':m.sha(data),'executedSha256':m.sha(executed)}
 identity['addedSourceSha256'].update({name:{'originalSha256':sha,'executedSha256':m.sha(sources[name]+b':executed')} for name,sha in m.READ_CLOSURES.items()})
 identity['fixtureSha256'] = {k.removeprefix('test/fixtures/pinned-ingress/'):v for k,v in hashes.items() if k.startswith('test/fixtures/pinned-ingress/')}
 identity['fixtureSha256']['pinned-ingress-driver.mjs'] = hashes['scripts/pinned-ingress-driver.mjs']
 identity['fixtureSha256']['backend/core.ts'] = m.sha(expected_core)
 identity['fixtureSha256']['backend/settings.ts'] = m.sha(expected_settings)
 effective = {'backend/core.ts':m.sha(expected_core),'backend/settings.ts':m.sha(expected_settings)}
 identity['sourceOverlaySha256'] = {a['source']:{'originalSha256':a['sourceSha256'],'replacement':a['replacement'],'executedSha256':effective.get(a['replacement'],a['replacementSha256'])} for a in aliases}
 auth = {'fixture':'research-only','results':[]}
 for name, bypass, path, credential, status in m.AUTH_CASES:
  route = 'PUBLIC' if path == '/api/health' else 'MANAGEMENT'
  auth['results'].append({'name':name,'stateSha256':m.auth_state_sha(name,bypass),'response':{'status':status,'routeClass':route,'body': ('"status":"ok"' if route == 'PUBLIC' else 'management-handler-reached') if status == 200 else 'private-canary'},'events':[{'event':'access-token:usage-stamp','private':'private-canary'}] if name == 'access-allowed' else []})
 public = next(row for row in auth['results'] if row['name'] == 'disabled-bypass-health')
 public['requestEvents'] = [{'event':'ip-filter:read','private':'private-canary'}]
 def public_response(origin=None):
  return {'status':200,'routeClass':'PUBLIC','body':'{"status":"ok","timestamp":"2026-01-01T00:00:00.000Z"}','contentType':'application/json','cacheControl':'no-store, no-cache, must-revalidate','requestIdUuid':True,'started':1767225600000,'ended':1767225600001,'allowOrigin':origin,'vary':'Origin' if origin else None,'allowMethods':'GET, POST, PUT, DELETE, PATCH, OPTIONS','allowHeaders':'Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, X-OmniRoute-Lease-Owner, X-OmniRoute-Lease-Generation, x-internal-test, accept','allowCredentials':None}
 public['response'] = public_response()
 public['draining'] = {'during':{'status':503,'routeClass':'PUBLIC','contentType':'application/json','retryAfter':'5','requestIdUuid':True,'correlationMatchesRequestId':True,'body':json.dumps({'error':{'code':'SERVICE_UNAVAILABLE','message':'Server is shutting down','correlation_id_present':True},'errorKeys':['code','correlation_id','message'],'bodyKeys':['error']})},'after':public_response()}
 public['cors'] = {'allowed':public_response('https://allowed.example'),'unlisted':public_response()}
 public['forwardedIp'] = {'denied':{**public_response('https://allowed.example'),'status':403,'body':'{"error":"IP blacklisted"}'},'recovered':public_response('https://allowed.example')}
 health = lambda ping: {'status':200,'cacheControl':'no-store','body':{'status':'ok','timestamp':'2026-01-01T00:00:00.000Z',**({'latencyMs':1} if ping else {})}}
 totals = {'totalRequests':3,'requestsWithCacheControl':2,'totalInputTokens':300,'totalCachedTokens':150,'totalCacheCreationTokens':10,'byProvider':{'alpha':{'totalRequests':2}},'byStrategy':{'direct':{'cachedTokens':50}},'extra':'private-canary'}
 metrics = lambda method: {'case':method+' /api/settings/cache-metrics','denied':{'status':401},'invalid':{'status':403},'allowed':{'status':200,'body':totals},'usageRowsAfter':3}
 rows = [{'case':'public GET /api/health','response':health(False)},{'case':'public GET /api/health/ping','response':health(True)},metrics('GET'),metrics('DELETE'),{'case':'GET cache-metrics missing usage_history','response':{'status':200,'body':{'totalRequests':0,'totalCachedTokens':0,'byProvider':{}}}},{'case':'drain-transition GET /api/health','draining':{'status':503},'recovered':{'status':200}}]
 timestamp = '2026-01-01T00:00:00.000Z'
 empty_summary = {'full':0,'reduced':0,'minimal':0,'default':0}
 populated_summary = {'full':1,'reduced':1,'minimal':0,'default':1}
 features = [{'feature':name,'level':level,'capability':capability,'reason':reason,'since':timestamp} for name,level,capability,reason in [('fixture-default','default','Safe default','Error: primary unavailable → Error: fallback unavailable'),('fixture-reduced','reduced','Reduced capability','primary unavailable'),('fixture-full','full','Full capability','')]]
 body = {'active':True,'summary':populated_summary,'features':features}
 response = lambda value: {'status':200,'routeClass':'MANAGEMENT','body':value}
 recovered_features = [{'feature':name,'level':'full','capability':'Full capability','reason':'','since':timestamp} for name in ('fixture-full','fixture-reduced','fixture-default')]
 degradation = {'case':'GET /api/health/degradation','denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'empty':response({'active':False,'summary':empty_summary,'features':[]}),'populated':response(body),'summary':response({'summary':populated_summary,'isDegraded':True}),'falseSummary':response(body),'capitalSummary':response(body),'recovery':response({'active':False,'summary':{'full':3,'reduced':0,'minimal':0,'default':0},'features':recovered_features})}
 rows.append(degradation)
 skill = {'id':'config-codex-cli','category':'config','area':'config-codex-cli','rawUrl':'https://raw.githubusercontent.com/cheaper-inference/OmniRoute/refs/heads/main/skills/config-codex-cli/SKILL.md','githubUrl':'https://github.com/cheaper-inference/OmniRoute/blob/main/skills/config-codex-cli/SKILL.md'}
 skills = {'case':'GET /api/agent-skills','denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'count':1,'skills':[skill]})}
 rows.append(skills)
 for path,value in [('/api/agent-skills/config-codex-cli',skill),('/api/agent-skills/coverage',{'api':{'have':0,'total':23},'cli':{'have':0,'total':21},'config':{'have':0,'total':1},'totalSkills':0})]:
  rows.append({'case':'GET '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response(value)})
 for method,path in [('GET','/api/model-combo-mappings'),('POST','/api/model-combo-mappings'),('GET','/api/model-combo-mappings/fixture-id'),('PUT','/api/model-combo-mappings/fixture-id'),('DELETE','/api/model-combo-mappings/fixture-id')]:
  rows.append({'case':method+' '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'fixture':'management-handler-reached'})})
 for method,path in [('GET','/api/combos'),('GET','/api/combos/fixture-id'),('GET','/api/combos/auto'),('GET','/api/combos/builder/options'),('GET','/api/combos/metrics'),('DELETE','/api/combos/metrics')]:
  rows.append({'case':method+' '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'fixture':'management-handler-reached'})})
 rows.append({'case':'GET /api/model-capability-overrides','denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'fixture':'management-handler-reached'})})
 for path in ('/api/fallback/chains','/api/providers/fixture-id/cc-alias','/api/provider-nodes'):
  rows.append({'case':'GET '+path,'denied':{'status':401,'routeClass':'MANAGEMENT'},'invalid':{'status':401,'routeClass':'MANAGEMENT'},'allowed':response({'fixture':'management-handler-reached'})})
 ingress = {'identity':identity,'results':rows,'events':[{'event':'sqlite:read','extra':'private-canary'},{'event':'degradation:populate'},{'event':'degradation:recover'}]}
 put('data/observations.json',auth); put('data/pinned-ingress-observations.json',ingress)
 m.export_observations(p, hashes)
 exported = json.loads((p/'export/observed-outcomes.json').read_text())
 assert 'private-canary' not in json.dumps(exported) and len(exported['sharedAuthentication']) == 12
 assert exported['health'][0]['bodyKeys'] == ['status','timestamp'] and exported['drain']['statuses'] == [503,200]
 assert exported['publicHealthHttp']['drain']['correlationMatchesRequestId'] is True and exported['publicHealthHttp']['cors']['unlistedOriginOmitted'] is True
 assert exported['publicHealthIpFilter'] == {'enabled':True,'mode':'blacklist','configReadObserved':True,'forwardedAddressFallback':{'deniedStatus':403,'error':'IP blacklisted','recoveryStatus':200,'routeClass':'PUBLIC','requestIdUuid':True,'allowedOriginEchoed':True}}
 assert exported['degradation']['handlerFailure'] == 'unobserved' and exported['degradation']['populated']['levels'] == ['default','reduced','full']
 assert exported['agentSkills']['ids'] == ['config-codex-cli'] and exported['agentSkills']['invalidCredentialStatus'] == 401
 assert [item['path'] for item in exported['agentSkillsReads']] == ['/api/agent-skills/config-codex-cli','/api/agent-skills/coverage']
 assert len(exported['modelComboMappingPolicy']) == 5 and exported['modelComboMappingPolicy'][1]['method'] == 'POST'
 assert [(item['method'],item['path']) for item in exported['comboPolicy']] == [('GET','/api/combos'),('GET','/api/combos/fixture-id'),('GET','/api/combos/auto'),('GET','/api/combos/builder/options'),('GET','/api/combos/metrics'),('DELETE','/api/combos/metrics')]
 assert exported['modelCapabilityOverridesPolicy'] == {'method':'GET','path':'/api/model-capability-overrides','routeClass':'MANAGEMENT','anonymousStatus':401,'invalidCredentialStatus':401,'authorizedStatus':200}
 assert [item['path'] for item in exported['readPolicy']] == ['/api/fallback/chains','/api/providers/fixture-id/cc-alias','/api/provider-nodes']
 assert all(item == {'method':'GET','path':item['path'],'routeClass':'MANAGEMENT','anonymousStatus':401,'invalidCredentialStatus':401,'authorizedStatus':200} for item in exported['readPolicy'])
 assert any('not the pinned handlers or their semantics' in limitation for limitation in exported['limitations'])
 assert any('does not execute the capability overrides handler' in limitation for limitation in exported['limitations'])
 assert any('does not execute combo handlers' in limitation for limitation in exported['limitations'])
 assert '198.51.100.' not in json.dumps(exported)
 assert 'started' not in json.dumps(exported['publicHealthHttp']) and 'correlation_id' not in json.dumps(exported['publicHealthHttp'])
 assert exported['inputs']['executedOverlaySha256'] == {'backend/core.ts':m.sha(expected_core),'backend/settings.ts':m.sha(expected_settings)}
 assert exported['inputs']['sourceOverlaySha256'] == identity['sourceOverlaySha256']
 (p/'export/observed-outcomes.json').unlink(); (p/'export').rmdir()
 def rejected():
  try: m.export_observations(p, hashes)
  except (RuntimeError, KeyError, ValueError, TypeError): return
  raise AssertionError('invalid evidence accepted')
 source_name = m.ROUTES[0]; original = identity['addedSourceSha256'][source_name]
 identity['addedSourceSha256'][source_name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected()
 identity['addedSourceSha256'][source_name] = original
 original = identity['pingDeclarationSha256']; identity['pingDeclarationSha256'] = 'b'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['pingDeclarationSha256'] = original
 for name in ('backend/core.ts','backend/settings.ts'):
  original = identity['fixtureSha256'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected()
  identity['fixtureSha256'][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['fixtureSha256'][name] = original
 for name in list(identity['sourceOverlaySha256']):
  original = identity['sourceOverlaySha256'].pop(name); put('data/pinned-ingress-observations.json',ingress); rejected()
  identity['sourceOverlaySha256'][name] = {**original, 'executedSha256':'a'*64}; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['sourceOverlaySha256'][name] = original
 put('data/pinned-ingress-observations.json',ingress)
 for name in ('access-invalid','access-expired','access-revoked'):
  row = next(row for row in auth['results'] if row['name'] == name)
  row['events'].append({'event':'access-token:usage-stamp'}); put('data/observations.json',auth); rejected(); row['events'].clear()
  row['response']['body'] = 'management-handler-reached'; put('data/observations.json',auth); rejected(); row['response']['body'] = 'private-canary'
 put('data/observations.json',auth)
 for bad in ([], [{'event':'ip-filter:wrong'}]):
  original = public['requestEvents']; public['requestEvents'] = bad; put('data/observations.json',auth); rejected(); public['requestEvents'] = original
 original = public.pop('requestEvents'); put('data/observations.json',auth); rejected(); public['requestEvents'] = original
 original = public['stateSha256']; public['stateSha256'] = 'a'*64; put('data/observations.json',auth); rejected(); public['stateSha256'] = original
 during = public['draining']['during']
 for key, bad in [('body','{"error":{"code":"wrong"}}'),('retryAfter','4'),('contentType','text/plain'),('routeClass','MANAGEMENT'),('correlationMatchesRequestId',False),('requestIdUuid',False)]:
  original = during[key]; during[key] = bad; put('data/observations.json',auth); rejected(); during[key] = original
 for key, bad in [('body','{"status":"ok","timestamp":"2025-01-01T00:00:00.000Z"}'),('cacheControl','public'),('contentType','text/plain')]:
  original = public['response'][key]; public['response'][key] = bad; put('data/observations.json',auth); rejected(); public['response'][key] = original
 original = public['cors']['unlisted']['allowOrigin']; public['cors']['unlisted']['allowOrigin'] = 'https://unlisted.example'; put('data/observations.json',auth); rejected(); public['cors']['unlisted']['allowOrigin'] = original
 original = public['cors'].pop('allowed'); put('data/observations.json',auth); rejected(); public['cors']['allowed'] = original
 forwarded = public['forwardedIp']
 for name in ('denied','recovered'):
  original = forwarded.pop(name); put('data/observations.json',auth); rejected(); forwarded[name] = original
 for name, changes in [('denied',[('status',401),('body','{"error":"IP not in whitelist"}'),('body','{"error":"Access denied"}'),('body','{"error":"IP blacklisted","extra":true}'),('contentType','text/plain'),('routeClass','MANAGEMENT'),('requestIdUuid',False),('allowOrigin',None),('allowCredentials','true'),('vary',None)]),('recovered',[('status',403),('body','{"error":"IP blacklisted"}'),('routeClass','MANAGEMENT'),('requestIdUuid',False),('allowOrigin',None),('allowMethods','GET')])]:
  response = forwarded[name]
  for key, bad in changes:
   original = response[key]; response[key] = bad; put('data/observations.json',auth); rejected(); response[key] = original
   original = response.pop(key); put('data/observations.json',auth); rejected(); response[key] = original
 original = public.pop('forwardedIp'); put('data/observations.json',auth); rejected(); public['forwardedIp'] = original
 put('data/observations.json',auth)
 ingress['results'] = rows[:-1]; put('data/pinned-ingress-observations.json',ingress); rejected()
 ingress['results'] = rows; rows[5]['recovered']['status'] = 503; put('data/pinned-ingress-observations.json',ingress); rejected()
 rows[5]['recovered']['status'] = 200
 rows[14], rows[15] = rows[15], rows[14]; put('data/pinned-ingress-observations.json',ingress); rejected(); rows[14], rows[15] = rows[15], rows[14]
 rows.append(rows[-1]); put('data/pinned-ingress-observations.json',ingress); rejected(); rows.pop()
 for mapping in rows[8:]:
  for endpoint,key,bad in [('denied','status',200),('invalid','status',200),('allowed','status',403),('denied','routeClass','PUBLIC'),('invalid','routeClass','PUBLIC'),('allowed','routeClass','PUBLIC')]:
   original = mapping[endpoint][key]; mapping[endpoint][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); mapping[endpoint][key] = original
  original = mapping['case']; mapping['case'] = 'GET /api/wrong'; put('data/pinned-ingress-observations.json',ingress); rejected(); mapping['case'] = original
 for row in rows[10:]:
  original = row['allowed']['body']; row['allowed']['body'] = {'fixture':'wrong'}; put('data/pinned-ingress-observations.json',ingress); rejected(); row['allowed']['body'] = original
 for name in m.POLICY_SOURCES:
  original = identity['addedSourceSha256'][name]; identity['addedSourceSha256'][name] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); identity['addedSourceSha256'][name] = original
 original = degradation['summary']['body']; degradation['summary']['body'] = body; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['summary']['body'] = original
 for name in ('falseSummary','capitalSummary'):
  original = degradation[name]['body']; degradation[name]['body'] = {'summary':populated_summary,'isDegraded':True}; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation[name]['body'] = original
 original = ingress['events']; ingress['events'] = original[:-1]; put('data/pinned-ingress-observations.json',ingress); rejected(); ingress['events'] = original
 original = degradation['invalid']['status']; degradation['invalid']['status'] = 200; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['invalid']['status'] = original
 original = degradation['denied']['routeClass']; degradation['denied']['routeClass'] = 'PUBLIC'; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['denied']['routeClass'] = original
 original = degradation['recovery']['body']['features'][1]['level']; degradation['recovery']['body']['features'][1]['level'] = 'reduced'; put('data/pinned-ingress-observations.json',ingress); rejected(); degradation['recovery']['body']['features'][1]['level'] = original
 for endpoint, key, bad in [('denied','status',200),('invalid','status',200),('allowed','routeClass','PUBLIC')]:
  original = skills[endpoint][key]; skills[endpoint][key] = bad; put('data/pinned-ingress-observations.json',ingress); rejected(); skills[endpoint][key] = original
 original = skill['id']; skill['id'] = 'wrong'; put('data/pinned-ingress-observations.json',ingress); rejected(); skill['id'] = original
 route_identity = identity['addedSourceSha256']['src/app/api/health/degradation/route.ts']
 for key in ('originalSha256','executedSha256'):
  original = route_identity[key]; route_identity[key] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); route_identity[key] = original
 domain_identity = identity['addedSourceSha256']['src/domain/degradation.ts']
 for key in ('originalSha256','executedSha256'):
  original = domain_identity[key]; domain_identity[key] = 'a'*64; put('data/pinned-ingress-observations.json',ingress); rejected(); domain_identity[key] = original
 put('data/pinned-ingress-observations.json',ingress)
 auth['results'][0]['response']['status'] = 500; put('data/observations.json',auth); rejected()
 (p/'data/observations.json').write_text('{'); rejected()
 (p/'data/observations.json').unlink(); rejected()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}, 120_000);

test("real-core export validates lifecycle and excludes private database values", () => {
  const code = String.raw`
import importlib.util,json,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location('ingress',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d); h='a'*64
 source={f'src/lib/db/migrations/{i:03}_fixture.sql':h for i in range(222)}
 source.update({'src/lib/db/healthCheckWorker.ts':h,'scripts/build/colocate-standalone.mjs':h,'src/lib/db/core.ts':h})
 migrations={k:v for k,v in source.items() if k.endswith('.sql')}
 identity={'sourceArchiveSha256':m.ARCHIVE_SHA,'nodeSha256':m.NODE_SHA,'sourceFilesSha256':source,'migrationSqlSha256':migrations,'workerSourceSha256':h,'productionRecipeSha256':h,'workerBuildArguments':['--bundle','--platform=node','--packages=external','--format=esm'],'workerOutputSha256':h,'runnerSourceSha256':h,'runnerOutputSha256':h,'private':'private-canary'}
 db={'name':'storage.sqlite','kind':'file','size':1}
 base={'driver':'node:sqlite','ping':True,'healthWorker':True,'healthy':True,'settingsMarker':'cold-written','tables':['_omniroute_migrations','db_meta'],'migrations':[{'version':'001','name':'initial_schema'}],'after':[db], 'meta':[{'key':'secret','value':'private-canary'}]}
 cold={**base,'phase':'cold','before':[]}; warm={**base,'phase':'warm','before':[db]}
 def put(name,value): (p/name).write_text(json.dumps(value))
 def reject():
  try: m.export_core_lifecycle(p,{})
  except (RuntimeError,ValueError,KeyError,TypeError): return
  raise AssertionError('invalid lifecycle accepted')
 put('cold-lifecycle.json',cold); put('warm-lifecycle.json',warm); put('core-identity.json',identity)
 warm['migrations']=[{'version':'002','name':'other'}]; put('warm-lifecycle.json',warm); reject()
 warm['migrations']=cold['migrations']; warm['healthWorker']=False; put('warm-lifecycle.json',warm); reject()
 warm['healthWorker']=True; warm['before']=[]; put('warm-lifecycle.json',warm); reject()
 warm['before']=[db]; put('warm-lifecycle.json',warm)
 identity['workerOutputSha256']='private-canary'; put('core-identity.json',identity); reject()
 identity['workerOutputSha256']=h; put('core-identity.json',identity)
 m.export_core_lifecycle(p,{})
 result=json.loads((p/'export/core-lifecycle.json').read_text())
 assert 'private-canary' not in json.dumps(result) and result['qualification'] is False
 assert result['cold']['databaseExistedBefore'] is False and result['warm']['databaseExistedBefore'] is True
 assert result['identity']['migrationSqlCount']==222 and result['cold']['migrationCount']==1
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
