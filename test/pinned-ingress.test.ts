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
