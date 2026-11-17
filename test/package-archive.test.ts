import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExtractedPackageRoot, verifyPackage } from "../scripts/verify-package.ts";

const helper = join(import.meta.dir, "../scripts/package-archive.py");
const roots: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function makeTar(path: string, members: Array<{ name: string; content?: string; kind?: "file" | "directory" | "symlink" }>): void {
  const script = [
    "import io, sys, tarfile",
    "path = sys.argv[1]",
    "entries = __import__('json').loads(sys.argv[2])",
    "with tarfile.open(path, 'w:gz') as archive:",
    "    for entry in entries:",
    "        member = tarfile.TarInfo(entry['name'])",
    "        kind = entry.get('kind', 'file')",
    "        if kind == 'directory':",
    "            member.type = tarfile.DIRTYPE; member.size = 0; archive.addfile(member)",
    "        elif kind == 'symlink':",
    "            member.type = tarfile.SYMTYPE; member.linkname = entry.get('content', 'outside'); archive.addfile(member)",
    "        else:",
    "            data = entry.get('content', '').encode(); member.size = len(data); archive.addfile(member, io.BytesIO(data))",
  ].join("\n");
  execFileSync("python3", ["-c", script, path, JSON.stringify(members)], { stdio: "pipe" });
}

function extract(path: string, destination: string): string {
  return execFileSync("python3", [helper, "extract", path, destination], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Override the pin only inside this test subprocess so malformed archives reach
// the same preflight and post-extraction checks as the approved archive.
function extractTestFixture(path: string, destination: string): string {
  const script = [
    "import base64, hashlib, importlib.util, json, pathlib, sys, tempfile",
    "spec = importlib.util.spec_from_file_location('archive_helper', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
    "archive = pathlib.Path(sys.argv[2]); data = archive.read_bytes()",
    "module.FIXTURE_BYTES = len(data); module.FIXTURE_SHA256 = hashlib.sha256(data).hexdigest()",
    "module.FIXTURE_INTEGRITY = 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode()",
    "entry = {'location': 'node_modules/bottleneck', 'name': module.FIXTURE_NAME, 'version': module.FIXTURE_VERSION, 'bytes': module.FIXTURE_BYTES, 'sha256': module.FIXTURE_SHA256, 'integrity': module.FIXTURE_INTEGRITY}",
    "with tempfile.TemporaryDirectory() as tmp:",
    "    module.FIXTURE_MANIFEST = pathlib.Path(tmp) / 'manifest.json'",
    "    module.FIXTURE_MANIFEST.write_text(json.dumps({'packages': [entry]}))",
    "    print(json.dumps(module.extract_fixture(archive, pathlib.Path(sys.argv[3]))))",
  ].join("\n");
  return execFileSync("python3", ["-c", script, helper, path, destination], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function extractApprovedFixture(path: string, destination: string): string {
  return execFileSync("python3", [helper, "extract-approved-fixture", path, destination], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function archivePackageFiles(repository: string, destination: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== "NODE_OPTIONS"));
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: repository,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed: unknown = JSON.parse(output);
  // npm versions may return either an array or a keyed object, as the verifier accepts.
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
  const metadata: unknown = entries.length === 1 ? entries[0] : undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)
    || !("filename" in metadata) || typeof metadata.filename !== "string") {
    throw new Error("npm pack did not return one safe archive filename");
  }
  const filename = metadata.filename;
  if (filename.length === 0 || filename !== filename.split(/[\\/]/).at(-1)) {
    throw new Error("npm pack returned an unsafe archive filename");
  }
  return join(destination, filename);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("portable npm archive preflight", () => {
  it("extracts only regular allowlisted package members and reports the exact file inventory", async () => {
    const root = await temporary("cruxomni-safe-archive-");
    const archive = join(root, "valid.tgz");
    const destination = join(root, "extract");
    makeTar(archive, [
      { name: "package/", kind: "directory" },
      { name: "package/src/", kind: "directory" },
      { name: "package/package.json", content: '{"name":"fixture"}\n' },
      { name: "package/src/index.ts", content: "export {};\n" },
    ]);
    const result = JSON.parse(extract(archive, destination)) as { root: string; entries: string[] };
    expect(result.entries).toEqual(["package.json", "src/index.ts"]);
    expect(await readFile(join(result.root, "src/index.ts"), "utf8")).toBe("export {};\n");
  });

  it("accepts the helper's canonical root through a symlinked destination ancestor", async () => {
    if (process.platform === "win32") return; // Creating directory symlinks requires extra privileges on Windows.
    const root = await temporary("cruxomni-archive-ancestor-");
    const ancestor = join(root, "real");
    const alias = join(root, "alias");
    await mkdir(ancestor);
    await symlink(ancestor, alias, "dir");
    const archive = join(root, "valid.tgz");
    const destination = join(alias, "extract");
    makeTar(archive, [{ name: "package/package.json", content: "{}" }]);
    const result = JSON.parse(extract(archive, destination)) as { root: string };
    expect(result.root).not.toBe(join(destination, "package"));
    expect(await validateExtractedPackageRoot(result.root, destination)).toBe(await realpath(join(destination, "package")));
  });

  it("accepts native Windows separator and case variants of the same directory", async () => {
    if (process.platform !== "win32") return;
    const root = await temporary("cruxomni-archive-case-");
    const destination = join(root, "extract");
    const expected = join(destination, "package");
    await mkdir(expected, { recursive: true });
    const alternate = expected.replace(/[a-zA-Z]/g, character =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()).replaceAll("\\", "/");
    expect(await validateExtractedPackageRoot(alternate, destination)).toBe(await realpath(expected));
  });

  it("rejects a different existing extraction directory", async () => {
    const root = await temporary("cruxomni-archive-wrong-root-");
    const destination = join(root, "extract");
    const expected = join(destination, "package");
    const outside = join(root, "outside");
    await mkdir(expected, { recursive: true });
    await mkdir(outside);
    await expect(validateExtractedPackageRoot(outside, destination)).rejects.toThrow("unexpected extraction directory");
    if (process.platform !== "win32") {
      const link = join(root, "package-link");
      await symlink(expected, link, "dir");
      await expect(validateExtractedPackageRoot(link, destination)).rejects.toThrow("ordinary package directory");
    }
  });

  it("rejects traversal, links, duplicates, Windows ambiguity, and unallowlisted files before writing", async () => {
    const cases: Array<{ label: string; members: Array<{ name: string; content?: string; kind?: "file" | "directory" | "symlink" }> }> = [
      { label: "traversal", members: [{ name: "package/package.json", content: "{}" }, { name: "package/../outside", content: "escape" }] },
      { label: "link", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/escape", content: "../../outside", kind: "symlink" }] },
      { label: "duplicate", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/a.ts", content: "one" }, { name: "package/src/a.ts", content: "two" }] },
      { label: "case-collision", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/a.ts", content: "one" }, { name: "package/SRC/b.ts", content: "two" }] },
      { label: "device-name", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/CON.ts", content: "reserved" }] },
      { label: "allowlist", members: [{ name: "package/package.json", content: "{}" }, { name: "package/.env", content: "private" }] },
      { label: "python-cache-directory", members: [{ name: "package/package.json", content: "{}" }, { name: "package/scripts/__pycache__/", kind: "directory" }] },
      { label: "python-bytecode", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/cache.pyc", content: "bytecode" }] },
      { label: "python-optimized-bytecode", members: [{ name: "package/package.json", content: "{}" }, { name: "package/src/cache.PYO", content: "bytecode" }] },
    ];
    const root = await temporary("cruxomni-malicious-archive-");
    for (const item of cases) {
      const archive = join(root, `${item.label}.tgz`);
      const destination = join(root, `${item.label}-extract`);
      makeTar(archive, item.members);
      if (item.label.startsWith("python-")) {
        expect(() => extract(archive, destination)).toThrow("Python bytecode/cache paths are not allowed in package archives");
      } else {
        expect(() => extract(archive, destination)).toThrow();
      }
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("approved isolated fixture archive", () => {
  const identity = JSON.stringify({ name: "bottleneck", version: "2.19.5", license: "MIT", dependencies: {} });
  it("reports independently checkable file digests and preserves the license", async () => {
    const root = await temporary("fixture-archive-");
    const archive = join(root, "fixture.tgz");
    makeTar(archive, [
      { name: "package/package.json", content: identity },
      { name: "package/LICENSE", content: "MIT license" },
      { name: "package/lib/index.js", content: "module.exports = 1;" },
    ]);
    const result = JSON.parse(extractTestFixture(archive, join(root, "extract"))) as {
      root: string; entries: string[]; archiveSha256: string; inventory: Array<{ path: string; bytes: number; sha256: string }>;
    };
    expect(result.entries).toEqual(["LICENSE", "lib/index.js", "package.json"]);
    expect(result.archiveSha256).toBe(createHash("sha256").update(await readFile(archive)).digest("hex"));
    for (const item of result.inventory) {
      const data = await readFile(join(result.root, item.path));
      expect(item.bytes).toBe(data.length);
      expect(item.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    }
    expect(result.inventory.map(item => item.path)).toEqual(result.entries);
    expect(await readFile(join(result.root, "LICENSE"), "utf8")).toBe("MIT license");
  });

  it("rejects unapproved bytes and existing destinations without modifying them", async () => {
    const root = await temporary("fixture-unapproved-");
    const archive = join(root, "fixture.tgz");
    makeTar(archive, [{ name: "package/package.json", content: identity }, { name: "package/LICENSE", content: "MIT" }]);
    expect(() => extractApprovedFixture(archive, join(root, "unapproved"))).toThrow();
    await expect(lstat(join(root, "unapproved"))).rejects.toMatchObject({ code: "ENOENT" });
    const destination = join(root, "existing");
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "untouched");
    expect(() => extractTestFixture(archive, destination)).toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("untouched");
    if (process.platform !== "win32") {
      const alias = join(root, "archive-link.tgz");
      await symlink(archive, alias);
      expect(() => extractApprovedFixture(alias, join(root, "link-extract"))).toThrow();
      await expect(lstat(join(root, "link-extract"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects unsafe entries and identity changes and cleans its owned destination", async () => {
    const root = await temporary("fixture-invalid-");
    const base = [{ name: "package/package.json", content: identity }, { name: "package/LICENSE", content: "MIT" }];
    const cases = [
      [...base, { name: "package/../outside", content: "escape" }],
      [...base, { name: "package/link", kind: "symlink" as const }],
      [...base, { name: "package/lib/A", content: "a" }, { name: "package/lib/a", content: "b" }],
      [{ name: "package/package.json", content: '{"name":"other","version":"2.19.5","license":"MIT"}' }, { name: "package/LICENSE", content: "MIT" }],
      [{ name: "package/package.json", content: identity }],
      [...base, ...Array.from({ length: 1000 }, (_, index) => ({ name: `package/files/${index}`, content: "x" }))],
    ];
    for (const [index, members] of cases.entries()) {
      const archive = join(root, `${index}.tgz`);
      const destination = join(root, `${index}-extract`);
      makeTar(archive, members);
      expect(() => extractTestFixture(archive, destination)).toThrow();
      await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("caller-supplied package archive verification", () => {
  it("requires a matching digest pair, verifies copied bytes, and preserves the caller archive", async () => {
    const source = await temporary("cruxomni-package-input-");
    const callerArchive = join(source, "caller.tgz");
    let verified: Awaited<ReturnType<typeof verifyPackage>> | undefined;
    try {
      await expect(verifyPackage({ archivePath: callerArchive })).rejects.toThrow("must be provided together");
      await writeFile(callerArchive, "not a valid archive\n");
      const badDigest = createHash("sha256").update("different bytes").digest("hex");
      await expect(verifyPackage({ archivePath: callerArchive, expectedArchiveSha256: badDigest })).rejects.toThrow("does not match expectedArchiveSha256");
      if (process.platform !== "win32") {
        const link = join(source, "caller-link.tgz");
        await symlink(callerArchive, link);
        const callerDigest = createHash("sha256").update(await readFile(callerArchive)).digest("hex");
        await expect(verifyPackage({ archivePath: link, expectedArchiveSha256: callerDigest })).rejects.toThrow("regular non-symlink file");
      }

      const packedArchive = archivePackageFiles(join(import.meta.dir, ".."), source);
      const bytes = await readFile(packedArchive);
      const expected = createHash("sha256").update(bytes).digest("hex");
      verified = await verifyPackage({ archivePath: packedArchive, expectedArchiveSha256: expected, keepTemporary: true });
      expect(verified.status).toBe("verified");
      expect(verified.archiveSha256).toBe(expected);
      expect((await readFile(packedArchive)).equals(bytes)).toBe(true);
      expect((await readdir(verified.extractedRoot)).length).toBeGreaterThan(0);
      expect(verified.entries).toContain("scripts/verify-package.ts");
      expect(verified.entries).toContain("scripts/package-archive.py");
      expect(verified.entries).toContain(".github/crux-experts-release-signing-key.asc");
      expect(verified.entries).not.toContain(".github/workflows/qualification.yml");
      expect(verified.entries.filter(path => path.startsWith(".github/"))).toEqual([".github/crux-experts-release-signing-key.asc"]);
      expect(verified.entries.some(path => path.split("/").some(component => component.toLowerCase() === "__pycache__")
        || /\.py[co]$/i.test(path))).toBe(false);
    } finally {
      if (verified) await rm(join(verified.extractedRoot, "..", ".."), { recursive: true, force: true });
    }
  }, 120_000);
});
