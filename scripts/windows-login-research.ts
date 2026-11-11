import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { runWindowsLoginResearch } from "./smoke.ts";

const args = process.argv.slice(2);
if (args.length !== 4 || !["baseline", "instrumented"].includes(args[0]!)) {
  throw new Error("Usage: bun scripts/windows-login-research.ts baseline|instrumented BINARY SHA256 OUTPUT");
}
const [variant, binary, sha256, output] = args as [string, string, string, string];
if (variant === "instrumented") {
  const baseline: unknown = JSON.parse(await readFile(resolve(output, "..", "baseline.json"), "utf8"));
  if (typeof baseline !== "object" || baseline === null || !("researchOnly" in baseline) || baseline.researchOnly !== true
    || !("instrumented" in baseline) || baseline.instrumented !== false
    || !("packageArchiveSha256" in baseline) || baseline.packageArchiveSha256 !== process.env.OMP_SMOKE_PACKAGE_SHA256) {
    throw new Error("Instrumented research requires the matching unmodified baseline");
  }
  const observations = "observations" in baseline && typeof baseline.observations === "object" && baseline.observations !== null ? baseline.observations : {};
  const setup = "setup" in observations && typeof observations.setup === "object" && observations.setup !== null ? observations.setup : {};
  const setupFailure = "completed" in setup && setup.completed === false && "timedOut" in setup && setup.timedOut === true
    && "dialogueCompleted" in setup && setup.dialogueCompleted === 7 && "setupEffects" in setup
    && JSON.stringify(setup.setupEffects) === JSON.stringify([
      { route: "key-verification", finished: true, closed: true, status: 200 },
      { route: "models", finished: true, closed: true, status: 200 },
    ]);
  if (!("reproducedSubmissionFailure" in baseline && baseline.reproducedSubmissionFailure === true) && !setupFailure) {
    throw new Error("Instrumented research requires the unmodified baseline to reproduce first");
  }
}
const result = await runWindowsLoginResearch({ binary: resolve(binary), sha256, instrumented: variant === "instrumented", output: resolve(output) });
process.stdout.write(`${JSON.stringify({ researchOnly: true, officialQualification: false, reproducedSubmissionFailure: result.reproducedSubmissionFailure })}\n`);
