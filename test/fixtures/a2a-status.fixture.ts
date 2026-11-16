import { randomUUID } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadPinnedModule, withPinnedSourceSnapshot } from "./pinned-handler.fixture.ts";
import { WellKnownAgentCardsFixture } from "./well-known-agent-cards.fixture.ts";

export const A2A_STATUS_ID = "GET /api/a2a/status";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const count: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const counts: JsonSchema = { type: "object", properties: { submitted: count, working: count, completed: count, failed: count, cancelled: count }, required: ["submitted", "working", "completed", "failed", "cancelled"], additionalProperties: false };
const tasks: JsonSchema = { type: "object", properties: { counts, total: count, activeStreams: count }, required: ["counts", "total", "activeStreams"], additionalProperties: false };
const nullable = (value: JsonSchema): JsonSchema => ({ oneOf: [{ type: "null" }, value] });
const agent: JsonSchema = { type: "object", properties: { name: { type: "string", enum: ["OmniRoute AI Gateway"] }, version: { type: "string", maxLength: 128 } }, required: ["name", "version"], additionalProperties: true };
const capabilities: JsonSchema = { type: "object", properties: { streaming: { type: "boolean" }, pushNotifications: { type: "boolean" } }, required: ["streaming", "pushNotifications"], additionalProperties: true };
export const a2aStatusView: JsonSchema = { type: "object", properties: { status: { type: "string", enum: ["ok", "disabled"] }, online: { type: "boolean" }, enabled: { type: "boolean" }, tasks, agent: nullable(agent), capabilities: nullable(capabilities) }, required: ["status", "online", "enabled", "tasks", "agent", "capabilities"], additionalProperties: false };

/** Proposal only; central authorization and cold lifecycle require independent evidence. */
export function a2aStatusContract(): OperationSourceContract {
  const template = operationContractTemplate(A2A_STATUS_ID) as unknown as OperationSourceContract;
  return { ...template, request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "management", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", bootstrap: "none", alternatives: [{ kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: "read" }] } },
    response: { ...template.response, mediaType: "application/json", schema: a2aStatusView, variants: template.response.variants.map(variant => variant.statusCode === "200" ? { ...variant, content: [{ mediaType: "application/json", schema: a2aStatusView, sourceFile: "src/app/api/a2a/status/route.ts" }] } : variant) },
    secrets: { inputFields: [], outputFields: ["url", "description", "skills", "error", "lastTaskAt"] }, sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Cold settings initialization can write; the process-local task manager also schedules cleanup and history purging. The response cannot settle effects." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization and scheduled effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } } };
}
export function a2aStatusDescriptor(): OperationDescriptor {
  const original = getOperation(A2A_STATUS_ID);
  if (!original || original.source.sha256 !== "d230afbd417035cd919d25853cf03e165392f83b1774739b780dd0000c8f6dc2" || original.source.gitBlobSha !== "4072255a115bd068918763682203c8f909d986df") throw new Error("Unexpected A2A status source identity");
  const contract = a2aStatusContract();
  return { ...original, ...contract, databaseInitializationRequired: true, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.a2a-status", reason: null } };
}

type Manager = { createTask(input: { skill: string; messages: Array<{ role: string; content: string }> }, owner?: string): { id: string }; updateTask(id: string, state: string): void; beginStream(): void; getStats(): { counts: { submitted: number; working: number; completed: number; failed: number; cancelled: number }; total: number; activeStreams: number; lastTaskAt: string | null }; destroy(): void };
/** Actual handler, cache and task manager; settings storage and persistence are controlled edges. */
export class A2aStatusFixture {
  enabled: unknown = false; failSettings = false; failCard = false; reads = 0; cardCalls = 0; now = Date.now();
  readonly cards = new WellKnownAgentCardsFixture();
  readonly manager: Manager;
  readonly #get: (request?: { nextUrl: { origin: string } }) => Promise<Response>;
  readonly #invalidate: (scope: "settings") => void;
  readonly #getManager: () => Manager;
  readonly #savedManager: unknown;
  readonly auth = createPinnedManagementAuthorization({ isDashboardSession: token => token === "fixture-session", verifyAccessToken: token => { const scope = ({ oma_read: "read", oma_write: "write", oma_admin: "admin" } as Record<string, string>)[token]; return scope ? { id: "fixture", name: "fixture", scope } : null; }, validateApiKey: key => ["fixture-manage", "fixture-read-key"].includes(key), getApiKeyMetadata: key => key === "fixture-manage" ? { id: "fixture", scopes: ["manage"] } : key === "fixture-read-key" ? { id: "fixture", scopes: ["read"] } : null });
  constructor() {
    const global = globalThis as typeof globalThis & { _a2aTaskManager?: unknown };
    this.#savedManager = global._a2aTaskManager; delete global._a2aTaskManager;
    const graph = withPinnedSourceSnapshot(() => {
      const deny = (s: string): never => { throw new Error(`Unexpected A2A status import: ${s}`); };
      const clock = new Proxy(Date, { get: (target, key, receiver) => key === "now" ? () => this.now : Reflect.get(target, key, receiver) });
      const cache = loadPinnedModule("src/lib/db/readCache.ts", s => s === "@/lib/db/settings" ? { getSettings: async () => { this.reads++; if (this.failSettings) throw new Error("fixture-private-settings-error"); return { a2aEnabled: this.enabled }; } } : deny(s), { date: clock });
      const manager = loadPinnedModule("src/lib/a2a/taskManager.ts", s => {
        if (s === "crypto") return { randomUUID };
        if (s === "@/lib/events/eventBus") return { emit: () => {} };
        if (s === "@/lib/db/a2aTasks") return { upsertA2ATask: () => {}, appendA2ATaskEvent: () => {}, purgeA2AHistory: () => {} };
        if (s === "@omniroute/open-sse/utils/logger") return { logger: () => ({ warn: () => {} }) };
        return deny(s);
      });
      const route = loadPinnedModule("src/app/api/a2a/status/route.ts", s => {
        if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
        if (s === "@/lib/a2a/taskManager") return manager;
        if (s === "@/lib/db/settings") return cache;
        if (s === "@/app/.well-known/agent.json/route") return { GET: (request?: { nextUrl: { origin: string } }) => { this.cardCalls++; if (this.failCard) throw new Error("fixture-private-card-error"); return this.cards.get("GET /.well-known/agent.json", request?.nextUrl.origin); } };
        return deny(s);
      });
      return { get: route.GET as (request?: { nextUrl: { origin: string } }) => Promise<Response>, invalidate: cache.invalidateDbCache as (scope: "settings") => void, getManager: manager.getTaskManager as () => Manager };
    });
    this.#get = graph.get; this.#invalidate = graph.invalidate; this.#getManager = graph.getManager; this.manager = this.#getManager();
  }
  invalidate(): void { this.#invalidate("settings"); }
  handle(): Promise<Response> { return this.#get({ nextUrl: { origin: "http://fixture.invalid" } }); }
  close(): void { this.manager.destroy(); const global = globalThis as typeof globalThis & { _a2aTaskManager?: unknown }; if (this.#savedManager === undefined) delete global._a2aTaskManager; else global._a2aTaskManager = this.#savedManager; this.cards.reset(); }
}
