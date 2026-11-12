import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveQualificationSource, verifyQualificationSource } from "../scripts/route-source-store.ts";

test("clean source preparation verifies archives and rejects tampering and links", () => {
  const temporary = mkdtempSync(join(tmpdir(), "cruxomni-upstream-test-"));
  const script = resolve(import.meta.dir, "../scripts/prepare-upstream.py");
  try {
    const setup = `
import hashlib,io,json,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]);(root/'provenance').mkdir()
state=root/'.agents/state/omp-provider-release/upstream';state.mkdir(parents=True)
archive=state/('omniroute-v4.5.6-'+('a'*40)+'.tar.gz')
with tarfile.open(archive,'w:gz') as bundle:
 data=b'{"version":"4.5.6"}'
 member=tarfile.TarInfo('source/package.json');member.size=len(data);bundle.addfile(member,io.BytesIO(data))
 if sys.argv[2]=='link':
  link=tarfile.TarInfo('source/escape');link.type=tarfile.SYMTYPE;link.linkname='/outside';bundle.addfile(link)
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(root/'provenance/upstreams.json').write_text(json.dumps({'upstreams':[{'id':'omniroute','repository':'diegosouzapw/OmniRoute','release':{'version':'4.5.6','tag':'v4.5.6','peeled_commit':'a'*40},'artifact_integrity':{'source_archive_sha256':digest,'source_archive_url':'https://github.com/diegosouzapw/OmniRoute/releases/download/v4.5.6/OmniRoute-v4.5.6.source.tar.gz'}}]}))
if sys.argv[2]=='tamper':archive.write_bytes(b'tampered')
`;
    const run = `
import importlib.util,pathlib,sys,io
spec=importlib.util.spec_from_file_location('prepare',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.ROOT=pathlib.Path(sys.argv[2])
if sys.argv[3]=='download':
 archive=next((module.ROOT/'.agents/state/omp-provider-release/upstream').glob('*.tar.gz')); payload=archive.read_bytes(); archive.unlink()
 module.urllib.request.urlopen=lambda *args,**kwargs:io.BytesIO(payload)
 real_temporary=module.tempfile.NamedTemporaryFile; handles=[]
 def temporary(*args,**kwargs):
  handle=real_temporary(*args,**kwargs);handles.append(handle);return handle
 module.tempfile.NamedTemporaryFile=temporary
 real_rename=pathlib.Path.rename
 def rename(path,target):
  if any(not handle.closed and pathlib.Path(handle.name)==path for handle in handles):raise PermissionError('Windows open-file rename denied')
  return real_rename(path,target)
 pathlib.Path.rename=rename
module.prepare()
`;
    for (const mode of ["clean", "download", "tamper", "link"]) {
      const root = join(temporary, mode);
      execFileSync("python3", ["-c", "from pathlib import Path; import sys; Path(sys.argv[1]).mkdir()", root]);
      execFileSync("python3", ["-c", setup, root, mode]);
      const result = spawnSync("python3", ["-c", run, script, root, mode], { encoding: "utf8" });
      if (mode === "clean" || mode === "download") {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"status": "prepared"');
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(mode === "tamper" ? "digest mismatch" : "links or special entries");
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test("signed qualification verification refuses missing and modified effective trees", () => {
  const packageRoot = resolve(import.meta.dir, "..");
  const source = resolveQualificationSource(packageRoot);
  if (!source.derivation) throw new Error("This regression requires the configured signed derivation");
  const provenance = JSON.parse(readFileSync(join(packageRoot, "provenance/upstreams.json"), "utf8")) as { upstreams: Array<{ id: string; release: { version: string; peeled_commit: string } }> };
  const release = provenance.upstreams.find(item => item.id === "omniroute")!.release;
  const archiveName = `omniroute-v${release.version}-${release.peeled_commit}.tar.gz`;
  const root = mkdtempSync(join(realpathSync(tmpdir()), "qualified-source-"));
  try {
    for (const directory of ["scripts", "provenance", ".github", ".agents/state/omp-provider-release/upstream"]) mkdirSync(join(root, directory), { recursive: true });
    for (const path of ["scripts/prepare-upstream.py", "provenance/upstreams.json", ".github/crux-experts-release-signing-key.asc", "provenance/derivations", `.agents/state/omp-provider-release/upstream/${archiveName}`]) {
      cpSync(join(packageRoot, path), join(root, path), { recursive: true });
    }
    expect(() => verifyQualificationSource(root)).toThrow();
    const target = resolveQualificationSource(root).root;
    cpSync(source.root, target, { recursive: true });
    cpSync(`${source.root}.receipt.json`, `${target}.receipt.json`);
    const verified = verifyQualificationSource(root);
    expect(verified.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    const modified = join(target, "src/lib/db/core.ts");
    const original = readFileSync(modified);
    writeFileSync(modified, "tampered");
    expect(() => verifyQualificationSource(root)).toThrow();
    const receiptPath = `${target}.receipt.json`;
    const originalReceipt = readFileSync(receiptPath);
    const forged = JSON.parse(originalReceipt.toString("utf8")) as { files: Array<{ path: string; sha256: string }>; treeSha256: string };
    forged.files.find(entry => entry.path === "src/lib/db/core.ts")!.sha256 = createHash("sha256").update("tampered").digest("hex");
    forged.treeSha256 = createHash("sha256").update(JSON.stringify(forged.files)).digest("hex");
    writeFileSync(receiptPath, JSON.stringify(forged));
    expect(() => verifyQualificationSource(root)).toThrow();
    writeFileSync(receiptPath, originalReceipt);
    writeFileSync(modified, original);
    const extra = join(target, "unexpected-file");
    writeFileSync(extra, "extra");
    expect(() => verifyQualificationSource(root)).toThrow();
    rmSync(extra);
    rmSync(modified);
    expect(() => verifyQualificationSource(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 300_000);
