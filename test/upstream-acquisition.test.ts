import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
(root/'provenance/upstreams.json').write_text(json.dumps({'upstreams':[{'id':'omniroute','repository':'diegosouzapw/OmniRoute','release':{'version':'4.5.6','tag':'v4.5.6','peeled_commit':'a'*40},'artifact_integrity':{'source_archive_sha256':digest,'source_archive_url':'https://github.com/diegosouzapw/OmniRoute/archive/'+('a'*40)+'.tar.gz'}}]}))
if sys.argv[2]=='tamper':archive.write_bytes(b'tampered')
`;
    const run = `import importlib.util,pathlib,sys; spec=importlib.util.spec_from_file_location('prepare',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.ROOT=pathlib.Path(sys.argv[2]); module.prepare()`;
    for (const mode of ["clean", "tamper", "link"]) {
      const root = join(temporary, mode);
      execFileSync("python3", ["-c", "from pathlib import Path; import sys; Path(sys.argv[1]).mkdir()", root]);
      execFileSync("python3", ["-c", setup, root, mode]);
      const result = spawnSync("python3", ["-c", run, script, root], { encoding: "utf8" });
      if (mode === "clean") {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('"status": "prepared"');
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(mode === "tamper" ? "digest mismatch" : "links or special entries");
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
