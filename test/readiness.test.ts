import { expect, test } from "bun:test";
import { formatReadiness, type ReadinessFacts } from "../src/readiness.ts";

const base: ReadinessFacts = {
  source: "native", environmentUrl: false, environmentKey: false, profileConfigured: true,
  pending: false, recoveryBlocked: false, credential: "present",
  health: { state: "ready", modelCount: 2, rawModelCount: 3, stale: false },
};

test("readiness distinguishes model discovery from credential verification", () => {
  expect(formatReadiness(base)).toContain("catalog ready; chat models=2; live rows=3");
  expect(formatReadiness(base)).toContain("does not independently verify the runtime key");
  for (const [health, expected] of [
    [{ state: "checking", modelCount: 0, rawModelCount: 0, stale: false }, "checking live model catalog"],
    [{ state: "no-models", modelCount: 0, rawModelCount: 0, stale: false }, "no chat-compatible models"],
    [{ state: "unauthorized", modelCount: 0, rawModelCount: 0, stale: false }, "catalog request unauthorized"],
    [{ state: "offline", modelCount: 2, rawModelCount: 3, stale: true }, "stale same-connection models=2"],
    [{ state: "offline", modelCount: 0, rawModelCount: 0, stale: false }, "catalog offline"],
    [{ state: "degraded", modelCount: 0, rawModelCount: 0, stale: false }, "catalog unavailable or invalid"],
  ] as const) expect(formatReadiness({ ...base, health })).toContain(expected);
});

test("readiness explains source precedence, pending recovery and failures", () => {
  expect(formatReadiness({ ...base, environmentUrl: true, environmentKey: true })).toContain("native source never falls back");
  expect(formatReadiness({ ...base, source: "environment", environmentUrl: true, environmentKey: true })).toContain("environment overrides the saved profile connection");
  expect(formatReadiness({ ...base, source: "environment", environmentUrl: true, issue: "environment-partial" })).toContain("requires both base URL and API key");
  expect(formatReadiness({ ...base, source: "legacy" })).toContain("source=legacy profile");
  expect(formatReadiness({ ...base, pending: true })).toContain("/omniroute recover");
  expect(formatReadiness({ ...base, recoveryBlocked: true })).toContain("activation unconfirmed");
  expect(formatReadiness({ ...base, credential: "multiple" })).toContain("recovery requires exactly one");
  expect(formatReadiness({ ...base, credential: "missing" })).toContain("runtime key missing");
  expect(formatReadiness({ ...base, credential: "unsupported" })).toContain("not an eligible API key");
  expect(formatReadiness({ ...base, issue: "config" })).toContain("configuration unavailable or invalid");
  expect(formatReadiness({ ...base, issue: "credential-lookup" })).toContain("credential lookup failed");
});
