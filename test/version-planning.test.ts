import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planVersion, setVersion } from "../scripts/version.ts";

test("a prepared batch does not increment twice after version synchronization", () => {
  const root = mkdtempSync(join(tmpdir(), "cruxomni-version-batch-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  const commit = (message: string) => { git("add", "."); git("-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "-m", message); };
  try {
    git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(root, ".omp-plugin"));
    writeFileSync(join(root, "VERSION"), "1.0.0\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    writeFileSync(join(root, ".omp-plugin/marketplace.json"), JSON.stringify({ version: "1.0.0" }));
    commit("chore: fixture baseline"); git("tag", "v1.0.0");
    writeFileSync(join(root, "feature.ts"), "export const enabled = true;\n"); commit("feat: ordinary patch-default feature");
    expect(planVersion(root).next).toBe("1.0.1");
    setVersion("1.0.1", root); commit("chore: synchronize version");
    expect(planVersion(root)).toMatchObject({ current: "1.0.1", next: "1.0.1", bump: "patch", excluded: { sync: 1 } });
    git("tag", "v1.0.1");
    writeFileSync(join(root, "feature.ts"), "export const enabled = false;\n"); commit("fix: follow-up correction");
    expect(planVersion(root).next).toBe("1.0.2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
