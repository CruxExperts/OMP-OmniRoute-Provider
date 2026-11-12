import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { createPinnedHealthFixture, LIVEZ_IDS, livezContract, type LivezId } from "./fixtures/pinned-health.fixture.ts";
import { readPinnedSource } from "./fixtures/pinned-handler.fixture.ts";

const TEST_ID = "test/admin-health-source.test.ts";
type Observation = { before: null; after: null; result: { status: number; body: string } };
let observations: Partial<Record<LivezId, Observation>> = {};
let matcherObserved = false;

afterAll(async () => {
  if (!matcherObserved) return;
  const caseSha256 = testCaseSourceHash(TEST_ID);
  for (const id of LIVEZ_IDS) {
    const observation = observations[id];
    if (!observation) continue;
    const contract = livezContract(id);
    // Binding validates the complete contract before any observation is written.
    const binding = operationEvidenceBinding(id, contract);
    const artifactPath = outcomeArtifactPath(id);
    await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: id, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
    testOutcomeHash(id, TEST_ID, caseSha256, binding, contract, artifactPath);
  }
});

test("pinned proxy matcher excludes the exact liveness route", () => {
  const source = ts.createSourceFile("src/proxy.ts", readPinnedSource("src/proxy.ts"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === "config");
  if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) throw new Error("Missing pinned proxy config");
  const matcher = declaration.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === "matcher");
  if (!matcher || !ts.isPropertyAssignment(matcher) || !ts.isArrayLiteralExpression(matcher.initializer)) throw new Error("Missing pinned matcher array");
  const entries = matcher.initializer.elements.map(element => {
    if (!ts.isStringLiteral(element)) throw new Error("Nonliteral pinned matcher");
    return element.text;
  });
  expect(entries).toEqual([
    "/", "/dashboard/:path*", "/home", "/home/:path*", "/api/:path*",
    "/:v1seg([vV]1)/:path*", "/:v1seg([vV]1)", "/:v1betaseg([vV]1[bB][eE][tT][aA])/:path*", "/:v1betaseg([vV]1[bB][eE][tT][aA])",
    "/:chatseg([cC][hH][aA][tT])/:path*", "/:respseg([rR][eE][sS][pP][oO][nN][sS][eE][sS])/:path*", "/:respseg([rR][eE][sS][pP][oO][nN][sS][eE][sS])",
    "/:codexseg([cC][oO][dD][eE][xX])/:path*", "/:codexseg([cC][oO][dD][eE][xX])", "/:modelsseg([mM][oO][dD][eE][lL][sS])", "/:v0seg([vV]0)/:path*",
  ]);
  matcherObserved = true;
});


test("pinned livez exports implement distinct GET and HEAD response contracts without handler authorization", async () => {
  const observed: Partial<Record<LivezId, Observation>> = {};
  const fixture = createPinnedHealthFixture();
  try {
    expect(fixture.live.dynamic).toBe("force-dynamic");
    for (const id of LIVEZ_IDS) {
      const contract = livezContract(id);
      const method = id === "GET /livez" ? "GET" : "HEAD";
      expect(contract.request.pathParameters).toEqual([]);
      expect(contract.request.parameters).toEqual([]);
      expect(contract.request.body).toBeNull();
      expect(contract.request.pathSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(contract.request.querySchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(contract.auth.sourcePolicy).toEqual({ status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] });
      expect(contract.auth.domain).toBe("public");
      expect(contract.sideEffect).toBe("read");
      expect(contract.confirmation.required).toBe(false);
      expect(contract.response.statusCodes).toEqual(["200"]);
      expect(contract.response.mediaType).toBe("text/plain");
      expect(contract.response.schema).toEqual(method === "GET" ? { type: "string", const: "ok\n" } : null);

      expect(contract.streaming).toEqual({ mode: "text", framing: "text/plain" });
      expect(contract.response.variants).toHaveLength(1);
      const variant = contract.response.variants[0];
      expect(variant?.statusCode).toBe("200");
      if (method === "HEAD") expect(variant?.body).toBe("empty");
      expect(variant?.content).toHaveLength(1);
      expect(variant?.content[0]).toMatchObject({ mediaType: "text/plain", schema: method === "GET" ? { type: "string", const: "ok\n" } : null });
      expect(variant?.headers).toEqual({
        "cache-control": { required: true, schema: { type: "string", enum: ["no-store"] } },
        "content-length": { required: true, schema: { type: "string", enum: ["3"] } },
        "content-type": { required: true, schema: { type: "string", enum: ["text/plain; charset=utf-8"] } },
      });
      // Invoke the source export itself: a transport can suppress a mistakenly populated HEAD body.
      const response = fixture.live[method]();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-length")).toBe("3");
      if (method === "HEAD") expect(response.body).toBeNull();
      const body = await response.text();
      expect(body).toBe(method === "GET" ? "ok\n" : "");
      observed[id] = { before: null, after: null, result: { status: response.status, body } };
    }
    observations = observed;
  } finally {
    fixture.stop();
  }
});

test("receipt-verified probes expose lifecycle status and body independently of method", async () => {
  const lifecycleGlobal = globalThis as typeof globalThis & { __omnirouteServerLifecycle?: "starting" | "ready" | "stopping" };
  const previous = lifecycleGlobal.__omnirouteServerLifecycle;
  const fixture = createPinnedHealthFixture();
  try {
    for (const [phase, setPhase, status, body] of [
      ["starting", fixture.lifecycle.markServerStarting, 503, "starting\n"],
      ["ready", fixture.lifecycle.markServerReady, 200, "ok\n"],
      ["stopping", fixture.lifecycle.markServerStopping, 503, "stopping\n"],
    ] as const) {
      setPhase();
      for (const method of ["GET", "HEAD"] as const) {
        for (const path of ["/healthz", "/livez"] as const) {
          const response = await fetch(`${fixture.endpoint}${path}`, { method });
          const expectedBody = path === "/livez" ? "ok\n" : body;
          expect(response.status).toBe(path === "/livez" ? 200 : status);
          expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("content-length")).toBe(String(expectedBody.length));
          expect(await response.text()).toBe(method === "HEAD" ? "" : expectedBody);
        }
      }
      expect(lifecycleGlobal.__omnirouteServerLifecycle).toBe(phase);
    }
    fixture.lifecycle.markServerReady();
    const stopped = await fetch(`${fixture.endpoint}/healthz`);
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toBe("stopping\n");
  } finally {
    fixture.stop();
    if (previous === undefined) delete lifecycleGlobal.__omnirouteServerLifecycle;
    else lifecycleGlobal.__omnirouteServerLifecycle = previous;
  }
});
