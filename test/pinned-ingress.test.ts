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
