import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPackage } from "../scripts/verify-package.ts";

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

function archivePackageFiles(repository: string, destination: string): string {
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== "object" || parsed[0] === null
    || !("filename" in parsed[0]) || typeof parsed[0].filename !== "string") {
    throw new Error("npm pack did not return one safe archive filename");
  }
  const filename = parsed[0].filename;
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
      expect(verified.entries.some(path => path.split("/").some(component => component.toLowerCase() === "__pycache__")
        || /\.py[co]$/i.test(path))).toBe(false);
    } finally {
      if (verified) await rm(join(verified.extractedRoot, "..", ".."), { recursive: true, force: true });
    }
  });
});
