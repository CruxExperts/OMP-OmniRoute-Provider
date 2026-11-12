import { Database } from "bun:sqlite";
import ts from "typescript";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import * as perfHooks from "node:perf_hooks";
import { loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";

export const LIVENESS_TEST_ID = "test/admin-json-health-source.test.ts";
export const LIVENESS_ID = "GET /api/health" as const;

type Lifecycle = PinnedExports & {
  markServerStarting(): void;
  markServerReady(): void;
  markServerStopping(): void;
};
type Probe = PinnedExports & { GET(): Response; HEAD(): Response };

/** Executes receipt-verified upstream handlers and their actual lifecycle and lag modules.
 * This fixture exercises handlers directly; it does not establish Next's ingress policy.
 */
export function createPinnedHealthFixture() {
  const lifecycle = loadPinnedModule("src/lib/serverLifecycle.ts", specifier => {
    throw new Error(`Unexpected lifecycle dependency: ${specifier}`);
  }) as Lifecycle;
  const lag = loadPinnedModule("src/lib/healthzLag.ts", specifier => {
    if (specifier === "node:perf_hooks") return perfHooks;
    throw new Error(`Unexpected health-lag dependency: ${specifier}`);
  });
  const health = loadPinnedModule("src/app/healthz/route.ts", specifier => {
    if (specifier === "@/lib/serverLifecycle") return lifecycle;
    if (specifier === "@/lib/healthzLag") return lag;
    throw new Error(`Unexpected health dependency: ${specifier}`);
  }) as Probe;
  const live = loadPinnedModule("src/app/livez/route.ts", specifier => {
    throw new Error(`Unexpected liveness dependency: ${specifier}`);
  }) as Probe;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const probe = path === "/healthz" ? health : path === "/livez" ? live : undefined;
    if (!probe || (request.method !== "GET" && request.method !== "HEAD")) return new Response(null, { status: 404 });
    return probe[request.method]();
  } });
  return { lifecycle, live, endpoint: server.url.origin, stop: () => server.stop(true) };
}

export const LIVEZ_IDS = ["GET /livez", "HEAD /livez"] as const;
export type LivezId = (typeof LIVEZ_IDS)[number];

/** Handler-derived candidate only; neither ingress authorization nor generator acceptance is established here. */
export function livezContract(id: LivezId): OperationSourceContract {
  const template = operationContractTemplate(id) as unknown as OperationSourceContract;
  const schema: JsonSchema | null = id === "GET /livez" ? { type: "string", enum: ["ok\n"] } : null;
  return {
    ...template,
    auth: { ...template.auth, sourcePolicy: { status: "unknown" } },
    response: {
      statusCodes: ["200"], mediaType: "text/plain", schema,
      variants: [{ statusCode: "200", content: [{ mediaType: "text/plain", schema }], headers: {
        "cache-control": { required: true, schema: { type: "string", enum: ["no-store"] } },
        "content-length": { required: true, schema: { type: "string", enum: ["3"] } },
        "content-type": { required: true, schema: { type: "string", enum: ["text/plain; charset=utf-8"] } },
      } }],
    },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "read",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "text", framing: "text/plain" },
    confirmation: { required: false, reason: "The pinned handler only constructs a fixed process-alive response." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export const JSON_HEALTH_IDS = ["GET /api/health", "GET /api/health/ping"] as const;
export type JsonHealthId = (typeof JSON_HEALTH_IDS)[number];
const timestamp: JsonSchema = { type: "string", format: "date-time" };
const liveResponse: JsonSchema = { type: "object", properties: { status: { type: "string", enum: ["ok"] }, timestamp }, required: ["status", "timestamp"], additionalProperties: false };
const pingResponse: JsonSchema = { type: "object", properties: { status: { type: "string", enum: ["ok"] }, timestamp, latencyMs: { type: "number" } }, required: ["status", "timestamp", "latencyMs"], additionalProperties: false };
const pingError: JsonSchema = { type: "object", properties: { status: { type: "string", enum: ["error"] }, error: { type: "string", enum: ["db_query_failed", "ping_failed"] } }, required: ["status", "error"], additionalProperties: false };

/** Candidate contracts only: framework ingress is not established by this fixture. */
export function jsonHealthContract(id: JsonHealthId): OperationSourceContract {
  const template = operationContractTemplate(id) as unknown as OperationSourceContract;
  const ping = id === JSON_HEALTH_IDS[1];
  const success = ping ? pingResponse : liveResponse;
  return {
    ...template,
    auth: ping ? { ...template.auth, sourcePolicy: { status: "unknown" } } : { ...template.auth, domain: "public", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] } },
    response: { ...template.response, mediaType: "application/json", schema: ping ? { oneOf: [pingResponse, pingError] } : success,
      variants: template.response.variants.map(variant => ({ ...variant, content: variant.content.map(content => ({
        ...content, schema: variant.statusCode === "200" ? success : content.schema,
      })) })) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: ping ? "mutation" : "read",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: ping ? { required: true, reason: "The database probe can initialize or recover the database and run migrations when the singleton is cold." } : { required: false, reason: "The pinned handlers only report liveness and database responsiveness." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export function jsonHealthDescriptor(id: JsonHealthId): OperationDescriptor {
  const original = getOperation(id);
  if (!original) throw new Error(`Missing pinned operation ${id}`);
  return { ...original, ...jsonHealthContract(id) };
}

/** Synthetic adapter authority is confined to the fixture; ingress remains unqualified. */
export function buildLivenessFixtureRegistry() {
  const descriptor = jsonHealthDescriptor(LIVENESS_ID);
  return fixtureRegistry([{ ...descriptor,
    mediaType: { request: descriptor.request.body?.mediaType ?? null, response: descriptor.response.mediaType },
    coverage: { status: "invokable", adapterId: "typed.fixture.get.api.health", reason: null },
  }]);
}

/** HTTP transport for the pinned handler only, not the Next proxy or auth pipeline. */
export function startPinnedLivenessHttp() {
  const route = loadPinnedModule("src/app/api/health/route.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
    throw new Error(`Unexpected health route dependency: ${specifier}`);
  });
  const get = route.GET as () => Promise<Response>;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return request.method === "GET" && new URL(request.url).pathname === "/api/health"
      ? get() : new Response(null, { status: 404 });
  } });
  return { endpoint: server.url.origin, stop: () => server.stop(true) };
}

/** Extract the exact receipt-verified pingDb declaration, injecting only its database boundary. */
function sourcePingDb(getDbInstance: () => Database): () => boolean {
  const path = "src/lib/db/core.ts";
  const source = readPinnedSource(path);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = file.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "pingDb");
  if (declarations.length !== 1) throw new Error("Pinned core must contain exactly one pingDb declaration");
  const compiled = ts.transpileModule(declarations[0]!.getText(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { pingDb?: () => boolean } };
  new Function("getDbInstance", "module", "exports", compiled)(getDbInstance, module, module.exports);
  if (typeof module.exports.pingDb !== "function") throw new Error("Pinned pingDb export missing");
  return module.exports.pingDb;
}

/** Direct receipt-verified routes and pingDb on disposable SQLite, not Next ingress or durable storage. */
export class PinnedJsonHealthFixture {
  readonly db = new Database(":memory:");
  readonly #health: () => Promise<Response>;
  readonly #ping: () => Promise<Response>;
  failOpen = false;
  throwFromPing = false;
  constructor() {
    const pingDb = sourcePingDb(() => {
      if (this.failOpen) throw new Error("fixture-private-backend-error");
      return this.db;
    });
    const next = { NextResponse: { json: Response.json.bind(Response) } };
    const health = loadPinnedModule("src/app/api/health/route.ts", specifier => {
      if (specifier === "next/server") return next;
      throw new Error(`Unexpected health route dependency: ${specifier}`);
    });
    const ping = loadPinnedModule("src/app/api/health/ping/route.ts", specifier => {
      if (specifier === "next/server") return next;
      if (specifier === "@/lib/db/core") return { pingDb: () => {
        if (this.throwFromPing) throw new Error("fixture-private-backend-error");
        return pingDb();
      } };
      throw new Error(`Unexpected ping route dependency: ${specifier}`);
    });
    this.#health = health.GET as () => Promise<Response>;
    this.#ping = ping.GET as () => Promise<Response>;
  }
  handle(id: JsonHealthId): Promise<Response> { return id === JSON_HEALTH_IDS[0] ? this.#health() : this.#ping(); }
  close(): void { this.db.close(); }
}
