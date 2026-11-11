import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { DEGRADATION_ID, DEGRADATION_TEST_ID, DEGRADATION_TIME, degradationContract, degradationDescriptor, PinnedDegradationFixture } from "./fixtures/pinned-degradation.fixture.ts";

const zero = { full: 0, reduced: 0, minimal: 0, default: 0 };
const fail = (message: string): never => { throw new Error(message); };

let observation: { before: null; after: null; result: { status: number; body: unknown } } | undefined;
let transitionsObserved = false;
let handlerFailureObserved = false;
let projectionLimitsObserved = false;

afterAll(async () => {
  if (!observation || !transitionsObserved || !handlerFailureObserved || !projectionLimitsObserved) return;
  const contract = degradationContract();
  const binding = operationEvidenceBinding(DEGRADATION_ID, contract);
  const caseSha256 = testCaseSourceHash(DEGRADATION_TEST_ID);
  const artifactPath = outcomeArtifactPath(DEGRADATION_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: DEGRADATION_ID, testId: DEGRADATION_TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(DEGRADATION_ID, DEGRADATION_TEST_ID, caseSha256, binding, contract, artifactPath);
});

async function read(fixture: PinnedDegradationFixture, query = ""): Promise<unknown> {
  const response = await fixture.handle(query);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  return response.json();
}

test("pinned degradation handler HTTP observes real registry transitions in both response branches", async () => {
  const fixture = new PinnedDegradationFixture();
  try {
  const descriptor = degradationDescriptor();
  expect(await read(fixture)).toEqual({ active: false, summary: zero, features: [] });
  expect(await read(fixture, "?summary=true")).toEqual({ summary: zero, isDegraded: false });

  fixture.domain.withDegradationSync("healthy", () => "primary", () => "fallback", "default", { fullCapability: "Primary available" });
  await fixture.domain.withDegradation("fallback", () => fail("fixture-private-primary"), () => "fallback", "default", { reducedCapability: "Fallback available" });
  await fixture.domain.withDegradation("offline", () => fail("primary unavailable"), () => fail("fallback unavailable"), "default", { defaultCapability: "Safe result" });
  const counts = { full: 1, reduced: 1, minimal: 0, default: 1 };
  const response = await fixture.handle();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  const body: unknown = await response.json();
  expect(body).toEqual({ active: true, summary: counts, features: [
    { level: "default", feature: "offline", capability: "Safe result", reason: "primary unavailable → fallback unavailable", since: DEGRADATION_TIME },
    { level: "reduced", feature: "fallback", capability: "Fallback available", reason: "fixture-private-primary", since: DEGRADATION_TIME },
    { level: "full", feature: "healthy", capability: "Primary available", reason: "", since: DEGRADATION_TIME },
  ] });
  const projected = projectResponse(descriptor, body);
  expect(projected).toEqual({ active: true, summary: counts, features: [
    { level: "default", feature: "offline", capability: "Safe result", since: DEGRADATION_TIME },
    { level: "reduced", feature: "fallback", capability: "Fallback available", since: DEGRADATION_TIME },
    { level: "full", feature: "healthy", capability: "Primary available", since: DEGRADATION_TIME },
  ] });
  const observed = { before: null, after: null, result: { status: response.status, body: projected } };
  const compact = await read(fixture, "?summary=true");
  expect(compact).toEqual({ summary: counts, isDegraded: true });
  expect(projectResponse(descriptor, compact)).toEqual(compact);
  expect(await read(fixture, "?summary=false")).toEqual(body);
  expect(await read(fixture, "?summary=True")).toEqual(body);
  expect(await read(fixture, "?summary=true&summary=false")).toEqual(compact);
  expect(await read(fixture, "?summary=false&summary=true")).toEqual(body);

  fixture.domain.withDegradationSync("fallback", () => "recovered", () => "fallback", "default");
  fixture.domain.withDegradationSync("offline", () => "recovered", () => "fallback", "default");
  expect(await read(fixture, "?summary=true")).toEqual({ summary: { full: 3, reduced: 0, minimal: 0, default: 0 }, isDegraded: false });
  expect(await read(fixture)).toEqual({ active: false, summary: { full: 3, reduced: 0, minimal: 0, default: 0 }, features: [
    { level: "full", feature: "healthy", capability: "Primary available", reason: "", since: DEGRADATION_TIME },
    { level: "full", feature: "fallback", capability: "Full capability", reason: "", since: DEGRADATION_TIME },
    { level: "full", feature: "offline", capability: "Full capability", reason: "", since: DEGRADATION_TIME },
  ] });
  fixture.domain.resetDegradationRegistry();
  expect(await read(fixture)).toEqual({ active: false, summary: zero, features: [] });
  observation = observed;
  } finally {
    fixture.close();
  }
  transitionsObserved = true;
});

test("pinned handler HTTP catches a response failure without returning the private error", async () => {
  const fixture = new PinnedDegradationFixture();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    fixture.failNextJson = true;
    const response = await fixture.handle();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: "Failed to fetch degradation report." });
    expect(JSON.stringify(body)).not.toContain("fixture-private-json-error");
    expect(projectResponse(degradationDescriptor(), body)).toEqual(body);
  } finally {
    fixture.close();
    log.mockRestore();
  }
  handlerFailureObserved = true;
});

test("pinned handler HTTP preserves dynamic registry cardinality and escapes control characters", async () => {
  const fixture = new PinnedDegradationFixture();
  try {
    for (let index = 0; index < 128; index++) {
      fixture.domain.withDegradationSync(`feature-${index}`, () => "ok", () => "fallback", "default", { fullCapability: "Available\nnow" });
    }
    const body = await read(fixture);
    const projected = projectResponse(degradationDescriptor(), body);
    expect(projected).toEqual({ active: false, summary: { full: 128, reduced: 0, minimal: 0, default: 0 }, features: Array.from({ length: 128 }, (_, index) => ({ level: "full", feature: `feature-${index}`, capability: "Available\\u000anow", since: DEGRADATION_TIME })) });
    fixture.domain.withDegradationSync("x".repeat(8 * 1024 * 1024), () => "ok", () => "fallback", "default");
    const oversized = await read(fixture);
    expect(() => projectResponse(degradationDescriptor(), oversized)).toThrow("response size limit exceeded");
  } finally {
    fixture.close();
  }
  projectionLimitsObserved = true;
});
