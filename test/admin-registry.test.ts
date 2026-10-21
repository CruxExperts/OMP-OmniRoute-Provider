import { expect, test } from "bun:test";
import { getOperation, getOperationRegistry, OperationRegistry, projectResponse, type JsonSchema, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";

const EMPTY: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
function fixtureOperation(body: JsonSchema | null = null): OperationDescriptor {
  const source = getOperation("GET /api/health");
  if (!source) throw new Error("fixture source identity is missing");
  return {
    ...source,
    operationId: "POST /fixture/registry",
    method: "POST",
    pathTemplate: "/fixture/registry",
    request: {
      pathSchema: EMPTY, querySchema: EMPTY, pathParameters: [], parameters: [], specificationDocumented: false,
      body: body === null ? null : { required: true, mediaType: "application/json", schema: body, contentVariants: [{ mediaType: "application/json", schema: body }] },
    },
    response: { statusCodes: ["200"], mediaType: "application/json", schema: { type: "object", properties: {}, required: [], additionalProperties: false }, variants: [] },
    mediaType: { request: body === null ? null : "application/json", response: "application/json" },
    auth: {
      domain: "public",
      specificationAlternatives: [],
      sourcePolicy: { status: "qualified", source: "omniroute-v3.8.52", routeClass: "public", alternatives: [{ kind: "anonymous" }] },
    },
    secrets: { inputFields: [], outputFields: [] },
    sideEffect: "mutation", confirmation: { required: true, reason: "Synthetic fixture mutation." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    coverage: { status: "invokable", adapterId: "typed.fixture.registry", reason: null },
  };
}

test("closed operation inputs reject undeclared sections, query fields and bodies", () => {
  const descriptor = fixtureOperation();
  const adapter = new OperationRegistry([descriptor], { records: [] }).require(descriptor.operationId);
  expect(() => adapter.validate({ unexpected: true })).toThrow();
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(() => adapter.validate({ query: { undeclared: true } })).toThrow();
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
});

test("schema unions retain sibling constraints and exact intersection semantics", () => {
  const descriptor = fixtureOperation({ oneOf: [{ type: "integer" }, { type: "number" }], minimum: 1 });
  const adapter = new OperationRegistry([descriptor], { records: [] }).require(descriptor.operationId);
  expect(adapter.validate({ body: 1.5 }).body).toBe(1.5);
  expect(() => adapter.validate({ body: 0.5 })).toThrow();
  expect(() => adapter.validate({ body: 1 })).toThrow();
  const intersection = fixtureOperation({ allOf: [{ type: "number", minimum: 0 }, { type: "number", maximum: 0 }] });
  const intersecting = new OperationRegistry([intersection], { records: [] }).require(intersection.operationId);
  expect(intersecting.validate({ body: 0 }).body).toBe(0);
  expect(() => intersecting.validate({ body: 1 })).toThrow();
  expect(() => intersecting.validate({ body: -1 })).toThrow();
});

test("recursive projections expose only typed fields and explicit data-map values", () => {
  const descriptor = fixtureOperation();
  const projected: OperationDescriptor = {
    ...descriptor,
    response: { ...descriptor.response, schema: {
      type: "object", required: ["connections"], additionalProperties: false,
      properties: {
        connections: { type: "array", items: {
          type: "object", required: ["id", "isActive", "latency"], additionalProperties: false,
          properties: { id: { type: "string" }, isActive: { type: "boolean" }, latency: { type: ["number", "null"] }, apiKey: { type: "string" } },
        } },
        aliases: { type: "object", "x-key-role": "identifier", additionalProperties: { type: "string", enum: ["on", "off"] } },
      },
    } },
  };
  expect(projectResponse(projected, {
    connections: [{ id: "provider/one", isActive: false, latency: null, apiKey: "withheld", unknown: "withheld" }],
    aliases: { "model/token-name": "on", "模型": "off" }, unknown: "withheld",
  })).toEqual({ connections: [{ id: "provider/one", isActive: false, latency: null }], aliases: { "model/token-name": "on", "模型": "off" } });
  expect(() => projectResponse(projected, { connections: [{ id: "one", isActive: "false", latency: 1 }] })).toThrow();
  expect(() => projectResponse(projected, { connections: [{ id: "one", isActive: false }] })).toThrow();
  expect(() => projectResponse(projected, { connections: [], aliases: { model: "arbitrary" } })).toThrow();
});

test("structural map keys redact credentials while identifier maps still redact nested credentials", () => {
  const source = fixtureOperation();
  const descriptor: OperationDescriptor = { ...source, response: { ...source.response, schema: {
    type: "object", additionalProperties: false, properties: {
      fields: { type: "object", additionalProperties: { type: "string" } },
      models: { type: "object", "x-key-role": "identifier", additionalProperties: {
        type: "object", additionalProperties: false, properties: { name: { type: "string" }, apiKey: { type: "string" } },
      } },
    },
  } } };
  expect(projectResponse(descriptor, {
    fields: { apiKey: "fixture-secret", accessToken: "fixture-token", ordinary: "visible" },
    models: { "model/token-name": { name: "model", apiKey: "fixture-nested-secret" } },
  })).toEqual({ fields: { ordinary: "visible" }, models: { "model/token-name": { name: "model" } } });
  expect(() => projectResponse({ ...descriptor, response: { ...descriptor.response, schema: {
    type: "object", "x-key-role": "identifier", additionalProperties: true,
  } } }, { apiKey: "fixture-secret" })).toThrow();
});

test("path-scoped secrets redact through arrays while typed token metadata remains visible", () => {
  const source = fixtureOperation();
  const descriptor: OperationDescriptor = {
    ...source,
    secrets: { inputFields: [], outputFields: [
      "providers.connections.lastError",
      "config.reasoningTokenBufferEnabled",
      "config.apiKey",
    ] },
    response: { ...source.response, schema: {
      type: "object", additionalProperties: false, properties: {
        providers: { type: "array", items: { type: "object", additionalProperties: false, properties: {
          connections: { type: "array", items: { type: "object", additionalProperties: false, properties: {
            id: { type: "string" }, lastError: { type: ["string", "null"] },
            max_output_tokens: { type: "integer", minimum: 0 }, outputTokenLimit: { type: "integer", minimum: 0 },
            reasoningTokenBufferEnabled: { type: "boolean" }, accessToken: { type: "string" },
          } } },
        } } },
        config: { type: "object", additionalProperties: false, properties: {
          reasoningTokenBufferEnabled: { type: "boolean" }, apiKey: { type: "string" },
        } },
        lookalikes: { type: "object", additionalProperties: false, properties: {
          max_output_tokens: { type: "string" }, outputTokenLimit: { type: "number" },
          reasoningTokenBufferEnabled: { type: "string" }, accessToken: { type: "string" },
        } },
        aliases: { type: "object", "x-key-role": "identifier", additionalProperties: { type: "string" } },
      },
    } },
  };
  const adapter = new OperationRegistry([descriptor], { records: [] }).require(descriptor.operationId);
  const response = {
    providers: [{ connections: [{ id: "fixture-connection", lastError: "fixture-provider-secret", max_output_tokens: 8192,
      outputTokenLimit: 4096, reasoningTokenBufferEnabled: true, accessToken: "fixture-access-token" }] }],
    config: { reasoningTokenBufferEnabled: false, apiKey: "fixture-api-key" },
    lookalikes: { max_output_tokens: "not-a-capacity", outputTokenLimit: 1.5,
      reasoningTokenBufferEnabled: "false", accessToken: "fixture-access-token" },
    aliases: { "model/token-name": "fixture/model" },
  };

  expect(adapter.project(response)).toEqual({
    providers: [{ connections: [{ id: "fixture-connection", max_output_tokens: 8192,
      outputTokenLimit: 4096, reasoningTokenBufferEnabled: true }] }],
    config: {},
    lookalikes: {},
    aliases: { "model/token-name": "fixture/model" },
  });
  expect(adapter.projectTarget(response)).toEqual(response);
});

test("response union branches preserve identifier roles without promoting structural maps", () => {
  const source = fixtureOperation();
  const descriptor: OperationDescriptor = { ...source, response: { ...source.response, schema: {
    anyOf: [
      { type: "object", "x-key-role": "identifier", additionalProperties: { type: "integer" } },
      { type: "object", additionalProperties: { type: "string" } },
    ],
  } } };
  expect(projectResponse(descriptor, { "model/token-name": 1 })).toEqual({ "model/token-name": 1 });
  expect(projectResponse(descriptor, { apiKey: "fixture-secret", ordinary: "visible" })).toEqual({ ordinary: "visible" });
});

test("empty-body operations do not accept missing declared JSON responses", () => {
  const descriptor = fixtureOperation();
  expect(projectResponse({ ...descriptor, response: { ...descriptor.response, schema: null } }, undefined)).toBeUndefined();
  expect(() => projectResponse(descriptor, undefined)).toThrow();
});

test("unknown and source-justified non-invokable IDs fail closed", () => {
  expect(() => getOperationRegistry().require("GET /not-in-inventory")).toThrow();
  expect(() => getOperationRegistry().require("POST /api/openapi/try")).toThrow();
  expect(() => new OperationRegistry([fixtureOperation(), fixtureOperation()], { records: [] })).toThrow();
});

test("source-only approvals and changed authentication or reconciliation contracts cannot grant execution", () => {
  const descriptor = fixtureOperation();
  const qualified = fixtureRegistry([descriptor]);
  const baked = qualified.getOperation(descriptor.operationId)!;
  const proof = qualified.getEligibility(descriptor.operationId);
  expect(proof.status).toBe("verified");
  const changedAuth: OperationDescriptor = { ...baked, auth: {
    ...baked.auth,
    domain: "management",
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "none",
      bootstrap: "none",
      alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }],
    },
  } };
  expect(new OperationRegistry([changedAuth], { records: [proof] }).getEligibility(descriptor.operationId).status).toBe("unavailable");
  const changedRelation: OperationDescriptor = { ...baked, reconciliation: {
    targetRead: { operationId: "GET /different-resource", inputs: [], snapshot: { kind: "resource", identity: [], state: [] } },
    reconcile: { operationId: "GET /different-resource", inputs: [], outcome: { kind: "matches", identityFields: [], stateFields: [] } },
  } };
  expect(new OperationRegistry([changedRelation], { records: [proof] }).getEligibility(descriptor.operationId).status).toBe("unavailable");
  expect(new OperationRegistry([descriptor], { records: [{ operationId: descriptor.operationId, status: "verified", reason: "Source-only prose cannot qualify execution.", source: descriptor.source, evidence: [{ kind: "source", detail: "No observed case/outcome receipt." }] }] }).getEligibility(descriptor.operationId).status).toBe("unavailable");
});

test("private target projection binds exact sensitive state without exposing it in model output", () => {
  const source = fixtureOperation();
  const descriptor: OperationDescriptor = {
    ...source,
    secrets: { inputFields: [], outputFields: ["fetchProxyUrl"] },
    response: { ...source.response, schema: {
      type: "object",
      properties: { id: { type: "string" }, fetchProxyUrl: { type: "string" }, note: { type: "string" } },
      required: ["id", "fetchProxyUrl", "note"],
      additionalProperties: false,
    } },
  };
  const adapter = new OperationRegistry([descriptor], { records: [] }).require(descriptor.operationId);
  const response = { id: "fixture-provider", fetchProxyUrl: "https://fixture-user:fixture-pass@proxy.example/?secret=fixture", note: "first\nsecond", unknown: "not allowlisted" };
  const publicOutput = adapter.project(response);
  if (!publicOutput || typeof publicOutput !== "object" || !("note" in publicOutput) || typeof publicOutput.note !== "string") throw new Error("projected note missing");
  expect(publicOutput).toMatchObject({ id: response.id });
  expect(publicOutput).not.toHaveProperty("fetchProxyUrl");
  expect(publicOutput).not.toHaveProperty("unknown");
  expect(publicOutput.note).not.toContain("\n");
  expect(adapter.projectTarget(response)).toEqual({ id: response.id, fetchProxyUrl: response.fetchProxyUrl, note: response.note });
  expect(adapter.projectTarget(response)).not.toEqual(adapter.projectTarget({ ...response, note: publicOutput.note }));
  expect(response.note).toBe("first\nsecond");
});

test("typed data-map keys remain literal data rather than changing object inheritance", () => {
  const source = fixtureOperation();
  const descriptor: OperationDescriptor = { ...source, response: { ...source.response, schema: {
    type: "object", properties: { aliases: { type: "object", additionalProperties: {
      type: "object", properties: { polluted: { type: "boolean" } }, required: ["polluted"], additionalProperties: false,
    } } }, required: ["aliases"], additionalProperties: false,
  } } };
  const adapter = new OperationRegistry([descriptor], { records: [] }).require(descriptor.operationId);
  const input = JSON.parse('{"aliases":{"__proto__":{"polluted":true}}}');
  for (const output of [adapter.project(input), adapter.projectTarget(input)]) {
    if (!output || typeof output !== "object" || !("aliases" in output)) throw new Error("projected data map missing");
    const aliases = output.aliases;
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) throw new Error("projected data map malformed");
    expect(Object.hasOwn(aliases, "__proto__")).toBe(true);
    expect(Reflect.get(aliases, "__proto__")).toEqual({ polluted: true });
    expect(Reflect.has(aliases, "polluted")).toBe(false);
  }
});

// Exercise the packaged runtime reader, rather than synthetic fixture authority.
test("reviewed public qualification references enable their exact generated operations", () => {
  const operationId = "GET /api/model-capability-overrides";
  const registry = getOperationRegistry();
  expect(registry.getEligibility(operationId).status).toBe("verified");
  expect(registry.require(operationId).descriptor.operationId).toBe(operationId);
  expect(registry.getEligibility("GET /api/providers").status).toBe("unavailable");
});
