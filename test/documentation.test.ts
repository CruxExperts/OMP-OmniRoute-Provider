import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("commit documentation uses staged source and preserves unstaged source and generated edits", () => {
  const root = resolve(import.meta.dir, "..");
  const temporary = mkdtempSync(join(tmpdir(), "cruxomni-doc-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const put = (name: string, value: unknown) => {
    mkdirSync(join(temporary, name, ".."), { recursive: true });
    writeFileSync(join(temporary, name), typeof value === "string" ? value : JSON.stringify(value));
  };
  try {
    for (const path of ["scripts/generate-docs.ts", "scripts/refresh-staged-docs.py"]) {
      mkdirSync(join(temporary, "scripts"), { recursive: true });
      cpSync(join(root, path), join(temporary, path));
    }
    symlinkSync(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    put(".gitignore", "node_modules\n");
    put("VERSION", "1.0.0\n");
    put("package.json", { version: "1.0.0", omp: { compatibility: { host: ">=18.12.2 <19", tested: [] } } });
    put(".omp-plugin/marketplace.json", { version: "1.0.0", commands: ["/cruxomni"] });
    put("src/index.ts", 'api.registerCommand("cruxomni", {});\n');
    put("contracts/operations.json", { operations: [] });
    put("provenance/upstreams.json", { upstreams: [] });
    put("docs/index.yaml", "root: docs\ndocuments: []\n");
    put("docs/INDEX.md", "Old generated index\n");
    put("docs/reference/generated.md", "Old generated reference\n");
    git("init", "--quiet");
    git("add", ".");
    // The proposed commit is valid; unstaged source deliberately is not.
    put("src/index.ts", 'api.registerCommand("unstaged-only", {});\n');
    put("docs/INDEX.md", "User's uncommitted index notes\n");
    execFileSync("python3", ["scripts/refresh-staged-docs.py"], { cwd: temporary, stdio: "pipe" });
    expect(git("show", ":docs/reference/generated.md")).toContain("`/cruxomni`");
    expect(git("show", ":docs/reference/generated.md")).not.toContain("unstaged-only");
    expect(readFileSync(join(temporary, "src/index.ts"), "utf8")).toContain("unstaged-only");
    expect(readFileSync(join(temporary, "docs/INDEX.md"), "utf8")).toBe("User's uncommitted index notes\n");
    expect(git("show", ":docs/INDEX.md")).toContain("Generated from docs/index.yaml");
    expect(git("show", ":src/index.ts")).not.toContain("unstaged-only");
    // Stale documents are rejected by the read-only CI check.
    const check = Bun.spawnSync(["bun", "run", "scripts/generate-docs.ts", "--check"], { cwd: temporary });
    expect(check.exitCode).not.toBe(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
