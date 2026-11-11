// Disposable sandbox control; bundled with the real handler and source registry.
import { appendFileSync, readFileSync } from "node:fs";
import { resetDegradationRegistry, withDegradationSync } from "@/domain/degradation";

if (process.env.INGRESS_STATE_FILE !== "/work/data/state.json" || process.env.INGRESS_EVENT_FILE !== "/work/data/events.jsonl") throw new Error("INGRESS_SANDBOX_PATH_REQUIRED");
process.on("SIGUSR1", () => {
  const command = readFileSync("/work/data/degradation-control", "utf8");
  if (command === "populate") {
    resetDegradationRegistry();
    withDegradationSync("fixture-full", () => 1, () => 2, 3);
    withDegradationSync("fixture-reduced", () => { throw new Error("primary unavailable"); }, () => 2, 3);
    withDegradationSync("fixture-default", () => { throw new Error("primary unavailable"); }, () => { throw new Error("fallback unavailable"); }, 3);
  } else if (command === "recover") {
    for (const feature of ["fixture-full", "fixture-reduced", "fixture-default"]) {
      withDegradationSync(feature, () => 1, () => 2, 3);
    }
  } else throw new Error("INGRESS_INVALID_DEGRADATION_CONTROL");
  appendFileSync("/work/data/events.jsonl", JSON.stringify({ event: "degradation:" + command }) + "\n", { mode: 0o600 });
});
