import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = resolve(import.meta.dir, "../scripts/pinned-ingress.py");

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
 core = b'export function getDbInstance() {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n}\n'
 settings = b'export const fixture = true;\n'
 (fixture/'backend/core.ts').write_bytes(core); (fixture/'backend/settings.ts').write_bytes(settings)
 for name, data in [('backend/core.ts',core),('backend/settings.ts',settings)]: hashes['test/fixtures/pinned-ingress/'+name] = m.sha(data)
 declaration = b'export function pingDb(): boolean {\n  return true;\n}'
 aliases = json.loads((m.FIXTURE/'alias-map.json').read_text())['aliases']
 names = set(m.ROUTES) | {'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts','src/proxy.ts'} | {a['source'] for a in aliases}
 sources = {name: ('source:'+name).encode() for name in names}; sources['src/lib/db/core.ts'] = b'// source\n'+declaration+b'\n'
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
 expected_core = (b'import { DatabaseSync } from "node:sqlite";\nlet sqlite: DatabaseSync | undefined;\n'
  b'export function getDbInstance() {\n      const normalized = sql.replace(/\\s+/g, " ").trim();\n'
  b'      if (normalized === "SELECT 1 AS ok" || (/^SELECT /i.test(normalized) && /\\bFROM usage_history\\b/i.test(normalized))) {\n'
  b'        event("sqlite:read");\n        sqlite ??= new DatabaseSync("/work/data/metrics.sqlite");\n'
  b'        return sqlite.prepare(sql);\n      }\n}\n\n'+declaration+b'\n')
 expected_settings = settings+b'\nexport { getCacheMetrics, resetCacheMetrics } from "@/lib/db/settings/cacheMetrics";\n'
 material = {'archiveSha256': m.ARCHIVE_SHA, 'webpackDeviation': False, 'bundler':'next-default', 'selectedSourceFiles': 509, 'configSupportSha256':{'src/proxy.ts':m.sha(sources['src/proxy.ts'])}}
 put('result.json', {'status':'research-observed', 'qualification':False, 'materialization':material})
 put('materialization.json', material)
 put('host-namespaces.json', {k:'host' for k in ('user','mnt','net','pid')})
 put('preflight.json', {'namespaces':{k:'sandbox' for k in ('user','mnt','net','pid')}, 'memoryMax':m.MEMORY, 'cpuAffinity':[0], 'network':'private-loopback-only', 'nodeSha256':m.NODE_SHA, 'environmentKeys':['PATH'], 'mountInfo':'private-canary'})
 identity_names = set(m.ROUTES) | {'src/lib/db/core.ts','src/lib/api/requireManagementAuth.ts','src/app/api/health/route.ts'}
 identity = {'sourceCommit':m.COMMIT,'sourceVersion':'3.8.53','archiveSha256':m.ARCHIVE_SHA,'nodeSha256':m.NODE_SHA,'runtime':{'node':'24.17.0','next':'16.4.2','react':'19.2.8','react-dom':'19.2.8'},'addedSourceSha256':{k:m.sha(sources[k]) for k in identity_names},'pingDeclarationSha256':m.sha(declaration),'runtimeInputSha256':{n:hashes['test/fixtures/pinned-ingress/'+n] for n in ('source-manifest.json','dependencies.json','runtime.json')}}
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
 ingress = {'identity':identity,'results':rows,'events':[{'event':'sqlite:read','extra':'private-canary'}]}
 put('data/observations.json',auth); put('data/pinned-ingress-observations.json',ingress)
 m.export_observations(p, hashes)
 exported = json.loads((p/'export/observed-outcomes.json').read_text())
 assert 'private-canary' not in json.dumps(exported) and len(exported['sharedAuthentication']) == 12
 assert exported['health'][0]['bodyKeys'] == ['status','timestamp'] and exported['drain']['statuses'] == [503,200]
 assert exported['publicHealthHttp']['drain']['correlationMatchesRequestId'] is True and exported['publicHealthHttp']['cors']['unlistedOriginOmitted'] is True
 assert exported['publicHealthIpFilter'] == {'enabled':True,'mode':'blacklist','configReadObserved':True,'forwardedAddressFallback':{'deniedStatus':403,'error':'IP blacklisted','recoveryStatus':200,'routeClass':'PUBLIC','requestIdUuid':True,'allowedOriginEchoed':True}}
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
 ingress['results'] = rows; rows[-1]['recovered']['status'] = 503; put('data/pinned-ingress-observations.json',ingress); rejected()
 rows[-1]['recovered']['status'] = 200; put('data/pinned-ingress-observations.json',ingress)
 auth['results'][0]['response']['status'] = 500; put('data/observations.json',auth); rejected()
 (p/'data/observations.json').write_text('{'); rejected()
 (p/'data/observations.json').unlink(); rejected()
`;
  const result = spawnSync("python3", ["-c", code, runner], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
