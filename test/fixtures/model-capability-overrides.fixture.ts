import * as zod from "zod";
import { getOperation, type OperationDescriptor, type JsonSchema } from "../../src/admin/registry.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import type { CompatibleProviderNode, ReasoningEffortOverrideValue } from "../../src/admin/source-model-capability-overrides.ts";
import { MODEL_CAPABILITY_OVERRIDE_PATCH_NORMALIZER } from "../../src/admin/source-model-capability-overrides.ts";
import { createPinnedManagementAuthorization, loadPinnedAccessTokenAuth, loadPinnedModule, providerAliasFromPinnedRegistry } from "./pinned-handler.fixture.ts";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";

export const MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS = [
  "GET /api/model-capability-overrides",
  "PATCH /api/model-capability-overrides",
  "DELETE /api/model-capability-overrides",
] as const;
export type ModelCapabilityOverrideOperationId = (typeof MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS)[number];

export interface ModelCapabilityNodeFixture extends CompatibleProviderNode {
  readonly id: string;
  readonly type: "openai-compatible" | "anthropic-compatible" | "other";
  readonly prefix?: string | null;
}
export interface StoredCapabilityOverrideFixture {
  readonly provider: string;
  readonly modelId: string;
  readonly key: "max_input_tokens" | "max_output_tokens" | "max_token" | "reasoning_efforts";
  readonly value: number | readonly ReasoningEffortOverrideValue[];
  readonly refreshedAt: string;
}
export interface StoredContextOverrideFixture {
  readonly provider: string;
  readonly modelId: string;
  readonly realContext: number;
  readonly source: "manual" | "auto:discovery";
  readonly refreshedAt: string;
}
export interface ModelCapabilityOverrideAuthKeyFixture {
  readonly key: string;
  readonly scopes: readonly string[];
}
export interface ModelCapabilityOverrideOmaFixture {
  readonly token: string;
  readonly scope: "read" | "write" | "admin";
}

export interface ModelCapabilityOverridesFixtureOptions {
  readonly nodes?: readonly ModelCapabilityNodeFixture[];
  readonly reservedPrefixes?: readonly string[];
  readonly capabilities?: readonly StoredCapabilityOverrideFixture[];
  readonly contexts?: readonly StoredContextOverrideFixture[];
  readonly apiKeys?: readonly ModelCapabilityOverrideAuthKeyFixture[];
  readonly omaTokens?: readonly ModelCapabilityOverrideOmaFixture[];
  readonly dashboardCookies?: readonly string[];
  /** True while the central authorization policy requires an authenticated request. */
  readonly centralAuthRequired?: boolean;
  /** True while the route's requireManagementAuth guard requires an authenticated request. */
  readonly authRequired?: boolean;
  readonly clock?: () => string;
}

export interface PublicModelCapabilityOverrideFixture {
  readonly provider: string;
  readonly modelId: string;
  readonly target: string;
  readonly key: string;
  readonly value: number | readonly string[];
  readonly refreshedAt: string;
}

const SOURCE_FILE = "src/app/api/model-capability-overrides/route.ts";
const MANAGEMENT_AUTH_FILE = "src/lib/api/requireManagementAuth.ts";
const ERROR_RESPONSE_FILE = "src/lib/api/errorResponse.ts";
const PUBLIC_OVERRIDE_KEYS = [
  "context_length",
  "max_input_tokens",
  "max_output_tokens",
  "reasoning_efforts",
] as const;
const LISTED_OVERRIDE_KEYS = [
  "context_length",
  "max_input_tokens",
  "max_output_tokens",
  "max_token",
  "reasoning_efforts",
] as const;
const VALUE_SCHEMA: JsonSchema = {
  anyOf: [
    { type: "integer", minimum: 1 },
    { type: "array", minItems: 1, items: { type: "string", enum: ["none", "low", "medium", "high", "xhigh", "max", "ultra"] } },
  ],
};
const OVERRIDE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["provider", "modelId", "target", "key", "value", "refreshedAt"],
  properties: {
    provider: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 3 },
    key: { type: "string", enum: LISTED_OVERRIDE_KEYS },
    value: VALUE_SCHEMA,
    refreshedAt: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};
const SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["overrides"],
  properties: { overrides: { type: "array", items: OVERRIDE_SCHEMA } },
  additionalProperties: false,
};
const ISSUE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["code", "message", "path"],
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string" },
    path: { type: "array", items: { type: ["string", "integer"] } },
    expected: { type: "string" },
    received: { type: "string" },
  },
  // Zod versions can add nested issue metadata; model-visible projection keeps
  // only the explicitly listed, non-input-bearing fields above.
  additionalProperties: true,
};
const ROUTE_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      anyOf: [
        { type: "string" },
        { type: "array", items: ISSUE_SCHEMA },
      ],
    },
  },
  additionalProperties: true,
};
const AUTH_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      required: ["message", "type"],
      properties: {
        message: { type: "string" },
        type: { type: "string", enum: ["invalid_request", "server_error"] },
      },
      additionalProperties: true,
    },
    requestId: { type: "string", format: "uuid" },
  },
  additionalProperties: true,
};
const CENTRAL_AUTH_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "correlation_id"],
      properties: {
        code: { type: "string", minLength: 1 },
        message: { type: "string" },
        correlation_id: { type: "string", format: "uuid" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
const AUTH_RESPONSE_SCHEMA: JsonSchema = { oneOf: [AUTH_ERROR_SCHEMA, CENTRAL_AUTH_ERROR_SCHEMA] };
const COMPLETE_RESPONSE_SCHEMA: JsonSchema = {
  oneOf: [SUCCESS_SCHEMA, ROUTE_ERROR_SCHEMA, AUTH_ERROR_SCHEMA, CENTRAL_AUTH_ERROR_SCHEMA],
};
const PATCH_BODY_SCHEMA: JsonSchema = {
  type: "object",
  required: ["target", "key", "value"],
  properties: {
    target: { type: "string", minLength: 3 },
    key: { type: "string", enum: PUBLIC_OVERRIDE_KEYS },
    // The route's z.coerce.number and reasoning parser accept more than JSON
    // numbers; source-bound normalization below narrows this value exactly.
    value: {},
  },
  // Zod's default object behavior strips unknown properties rather than rejecting
  // them. The source normalizer returns only the declared fields.
  additionalProperties: true,
};
const PATCH_REQUEST: OperationSourceContract["request"] = {
  pathSchema: { type: "object", properties: {}, additionalProperties: false },
  querySchema: { type: "object", properties: {}, additionalProperties: false },
  pathParameters: [],
  parameters: [],
  body: {
    required: true,
    mediaType: "application/json",
    schema: PATCH_BODY_SCHEMA,
    contentVariants: [{ mediaType: "application/json", schema: PATCH_BODY_SCHEMA }],
  },
  sourceNormalizer: MODEL_CAPABILITY_OVERRIDE_PATCH_NORMALIZER,
  specificationDocumented: true,
};
const DELETE_QUERY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    target: { type: "string" },
    key: { type: "string", enum: PUBLIC_OVERRIDE_KEYS },
  },
  additionalProperties: false,
};
const DELETE_REQUEST: OperationSourceContract["request"] = {
  pathSchema: { type: "object", properties: {}, additionalProperties: false },
  querySchema: DELETE_QUERY_SCHEMA,
  pathParameters: [],
  parameters: [
    { name: "target", in: "query", required: false, style: "form", explode: true, allowReserved: false, schema: { type: "string" }, inputAllowed: true, sourceFile: SOURCE_FILE },
    { name: "key", in: "query", required: false, style: "form", explode: true, allowReserved: false, schema: { type: "string", enum: PUBLIC_OVERRIDE_KEYS }, inputAllowed: true, sourceFile: SOURCE_FILE },
  ],
  body: null,
  specificationDocumented: true,
};

const pinnedScopeInference = loadPinnedAccessTokenAuth(() => null);

function responseContract(
  template: OperationSourceContract["response"],
  operationId: ModelCapabilityOverrideOperationId,
): OperationSourceContract["response"] {
  const expectedStatuses = operationId.startsWith("GET ")
    ? ["200", "401", "403", "503"]
    : ["200", "400", "401", "403", "503"];
  const variants = expectedStatuses.map(statusCode => {
    const existing = template.variants.find(variant => variant.statusCode === statusCode);
    if (!existing) throw new Error(`model capability response status is not source-bound: ${operationId} ${statusCode}`);
    const schema = statusCode === "200"
      ? SUCCESS_SCHEMA
      : statusCode === "400"
        ? ROUTE_ERROR_SCHEMA
        : AUTH_RESPONSE_SCHEMA;
    return {
      ...existing,
      content: existing.content.map(content => ({ ...content, schema })),
    };
  });
  return {
    ...template,
    statusCodes: expectedStatuses,
    mediaType: "application/json",
    schema: COMPLETE_RESPONSE_SCHEMA,
    variants,
  };
}

function managementAuth(
  template: OperationSourceContract,
  operationId: ModelCapabilityOverrideOperationId,
): OperationSourceContract["auth"] {
  const method = operationId.slice(0, operationId.indexOf(" "));
  const path = "/api/model-capability-overrides";
  const minimumScope = pinnedScopeInference.inferRequiredScope(method, path);
  return {
    domain: "management",
    specificationAlternatives: template.auth.specificationAlternatives,
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "requireManagementAuth",
      bootstrap: "none",
      alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function sourceContract(operationId: ModelCapabilityOverrideOperationId): OperationSourceContract {
  const template = operationContractTemplate(operationId) as unknown as OperationSourceContract;
  const method = operationId.slice(0, operationId.indexOf(" "));
  return {
    request: method === "PATCH" ? PATCH_REQUEST : method === "DELETE" ? DELETE_REQUEST : template.request,
    auth: managementAuth(template, operationId),
    response: responseContract(template.response, operationId),
    secrets: { inputFields: [], outputFields: [] },
    sideEffect: method === "GET" ? "read" : "mutation",
    pagination: { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: method === "GET"
      ? { required: false, reason: "Reads a bounded public-prefix projection of the two override tables." }
      : {
          required: true,
          reason: "Persistent override mutation requires explicit human confirmation. Provider-prefix and alias resolution is based on mutable server configuration, while GET exposes only public projections; no exact closed per-key target snapshot is available, so a lost response remains unknown after one attempt and is never replayed.",
        },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation: null,
    mutationSafety: method === "GET" ? null : {
      preflight: { kind: "unavailable", reason: "The public GET projects provider prefixes and suppresses mutable provider and alias resolution, so the exact write target and dependencies cannot be observed before dispatch." },
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
    },
  };
}

export const MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS: Readonly<Record<ModelCapabilityOverrideOperationId, OperationSourceContract>> = {
  "GET /api/model-capability-overrides": sourceContract("GET /api/model-capability-overrides"),
  "PATCH /api/model-capability-overrides": sourceContract("PATCH /api/model-capability-overrides"),
  "DELETE /api/model-capability-overrides": sourceContract("DELETE /api/model-capability-overrides"),
};

export function modelCapabilityOverrideDescriptor(operationId: ModelCapabilityOverrideOperationId): OperationDescriptor {
  const template = getOperation(operationId);
  if (!template) throw new Error(`pinned operation is absent: ${operationId}`);
  const contract = MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS[operationId];
  return {
    ...template,
    ...contract,
    mediaType: {
      request: contract.request.body?.mediaType ?? null,
      response: contract.response.mediaType,
    },
    coverage: { status: "invokable", adapterId: `typed.fixture.${operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`, reason: null },
  };
}

interface CapabilityRow {
  provider: string;
  modelId: string;
  key: StoredCapabilityOverrideFixture["key"];
  value: number | readonly ReasoningEffortOverrideValue[];
  refreshedAt: string;
}
interface ContextRow {
  provider: string;
  modelId: string;
  realContext: number;
  source: "manual" | "auto:discovery";
  refreshedAt: string;
}

const TRUSTED_LOCAL_SERVICE_TOKEN = "fixture-internal-service-token";

function compositeKey(provider: string, modelId: string, key: string): string {
  return JSON.stringify([provider, modelId, key]);
}

type RouteHandler = (request: Request) => Response | Promise<Response>;
interface PinnedCapabilityHandlers {
  readonly GET: RouteHandler;
  readonly PATCH: RouteHandler;
  readonly DELETE: RouteHandler;
}

function splitTarget(target: string): { provider: string; modelId: string } | undefined {
  const slashIndex = target.indexOf("/");
  if (slashIndex <= 0 || slashIndex === target.length - 1) return undefined;
  return { provider: target.slice(0, slashIndex), modelId: target.slice(slashIndex + 1) };
}

export class ModelCapabilityOverridesFixture {
  readonly #server: Bun.Server<undefined>;
  readonly #nodes: readonly ModelCapabilityNodeFixture[];
  readonly #reservedPrefixes: ReadonlySet<string>;
  readonly #capabilities = new Map<string, CapabilityRow>();
  readonly #contexts = new Map<string, ContextRow>();
  readonly #apiKeys = new Map<string, readonly string[]>();
  readonly #omaTokens = new Map<string, ModelCapabilityOverrideOmaFixture["scope"]>();
  readonly #dashboardCookies: ReadonlySet<string>;
  readonly #clock: () => string;
  readonly #requests = new Map<string, number>();
  readonly #handlers: PinnedCapabilityHandlers;
  readonly #authorization: ReturnType<typeof createPinnedManagementAuthorization>;
  #centralAuthRequired: boolean;
  #authRequired: boolean;
  #authBackendUnavailable = false;
  #invalidations = 0;
  #clockTick = 0;
  #lastPatchWireBody: unknown;

  constructor(options: ModelCapabilityOverridesFixtureOptions = {}) {
    this.#nodes = [...(options.nodes ?? [])].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    this.#reservedPrefixes = new Set(options.reservedPrefixes ?? []);
    this.#dashboardCookies = new Set(options.dashboardCookies ?? []);
    this.#clock = options.clock ?? (() => `2026-10-19T12:00:${String(this.#clockTick++).padStart(2, "0")}.000Z`);
    this.#centralAuthRequired = options.centralAuthRequired ?? true;
    this.#authRequired = options.authRequired ?? true;
    for (const row of options.capabilities ?? []) this.#capabilities.set(compositeKey(row.provider, row.modelId, row.key), structuredClone(row));
    for (const row of options.contexts ?? []) this.#contexts.set(compositeKey(row.provider, row.modelId, "context_length"), structuredClone(row));
    for (const entry of options.apiKeys ?? []) this.#apiKeys.set(entry.key, [...entry.scopes]);
    for (const entry of options.omaTokens ?? []) this.#omaTokens.set(entry.token, entry.scope);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: token => this.#dashboardCookies.has(token)
        || [...this.#dashboardCookies].some(cookie => cookie.split(";").some(segment => segment.trim() === `auth_token=${token}`)),
      verifyAccessToken: token => {
        if (this.#authBackendUnavailable) throw new Error("fixture access-token backend unavailable");
        const scope = this.#omaTokens.get(token);
        return scope ? { id: `fixture-${scope}`, name: `fixture ${scope}`, scope } : null;
      },
      validateApiKey: key => {
        if (this.#authBackendUnavailable) throw new Error("fixture API-key backend unavailable");
        return this.#apiKeys.has(key);
      },
      getApiKeyMetadata: key => {
        if (this.#authBackendUnavailable) throw new Error("fixture API-key backend unavailable");
        const scopes = this.#apiKeys.get(key);
        return scopes ? { id: "fixture-key", scopes: [...scopes] } : null;
      },
      internalServiceToken: TRUSTED_LOCAL_SERVICE_TOKEN,
    });
    this.#handlers = this.#createPinnedHandlers();
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }
  close(): void { this.#server.stop(true); }
  setAuthRequired(value: boolean): void { this.#authRequired = value; }
  setAuthBackendUnavailable(value: boolean): void { this.#authBackendUnavailable = value; }

  get requestCount(): number {
    return [...this.#requests.values()].reduce((sum, value) => sum + value, 0);
  }
  count(operationId: ModelCapabilityOverrideOperationId): number {
    return this.#requests.get(operationId) ?? 0;
  }
  get cacheInvalidations(): number { return this.#invalidations; }
  get lastPatchWireBody(): unknown { return structuredClone(this.#lastPatchWireBody); }

  capability(provider: string, modelId: string, key: StoredCapabilityOverrideFixture["key"]): CapabilityRow | undefined {
    const row = this.#capabilities.get(compositeKey(provider, modelId, key));
    return row === undefined ? undefined : structuredClone(row);
  }

  context(provider: string, modelId: string): ContextRow | undefined {
    const row = this.#contexts.get(compositeKey(provider, modelId, "context_length"));
    return row === undefined ? undefined : structuredClone(row);
  }

  /** Raw database-table snapshot for test state comparisons; it does not apply public projection rules. */
  publicState(): PublicModelCapabilityOverrideFixture[] {
    return structuredClone([
      ...[...this.#capabilities.values()].map(row => ({
        provider: row.provider, modelId: row.modelId, target: `${row.provider}/${row.modelId}`,
        key: row.key, value: row.value, refreshedAt: row.refreshedAt,
      })),
      ...[...this.#contexts.values()].map(row => ({
        provider: row.provider, modelId: row.modelId, target: `${row.provider}/${row.modelId}`,
        key: "context_length", value: row.realContext, refreshedAt: row.refreshedAt,
      })),
    ].sort((left, right) => `${left.refreshedAt}\u0000${left.provider}\u0000${left.modelId}\u0000${left.key}`.localeCompare(
      `${right.refreshedAt}\u0000${right.provider}\u0000${right.modelId}\u0000${right.key}`,
    )));
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/model-capability-overrides") return Response.json({ error: "Not found" }, { status: 404 });
    if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "DELETE") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const operationId = `${request.method} ${url.pathname}` as ModelCapabilityOverrideOperationId;
    this.#requests.set(operationId, (this.#requests.get(operationId) ?? 0) + 1);
    const handler = this.#handlers[request.method];
    if (!handler) return Response.json({ error: "Method not allowed" }, { status: 405 });
    return await this.#authorization.dispatch(request, {
      centralAuthRequired: this.#centralAuthRequired,
      handlerAuthRequired: this.#authRequired,
    }, async forwardedRequest => {
      if (request.method === "PATCH") {
        try { this.#lastPatchWireBody = await forwardedRequest.clone().json(); }
        catch { this.#lastPatchWireBody = undefined; }
      }
      return await handler(forwardedRequest);
    });
  }

  #createPinnedHandlers(): PinnedCapabilityHandlers {
    const aliases = providerAliasFromPinnedRegistry("open-sse/config/providers/registry/codex/index.ts", "codex");
    const aliasModule = loadPinnedModule("open-sse/services/providerAlias.ts", specifier => {
      if (specifier === "../config/providerModels.ts") return { PROVIDER_ID_TO_ALIAS: { [aliases.id]: aliases.alias } };
      throw new Error(`Unapproved pinned provider-alias import: ${specifier}`);
    });
    const reasoning = loadPinnedModule("src/shared/reasoning/reasoningEffortsOverride.ts", specifier => {
      throw new Error(`Unapproved pinned reasoning-parser import: ${specifier}`);
    });
    const prefixIndex = loadPinnedModule("src/lib/providerNodePrefixes.ts", specifier => {
      if (specifier === "@/lib/db/providers/nodes") return { getProviderNodes: async () => this.#nodes };
      if (specifier === "@/shared/constants/reservedProviderPrefixes") return {
        getReservedProviderPrefixes: () => this.#reservedPrefixes,
        isReservedProviderPrefix: (value: unknown) => typeof value === "string" && this.#reservedPrefixes.has(value),
      };
      throw new Error(`Unapproved pinned provider-prefix import: ${specifier}`);
    });
    const capabilityDatabase = {
      listModelCapabilityOverrides: () => [...this.#capabilities.values()].map(row => ({
        ...structuredClone(row), target: `${row.provider}/${row.modelId}`,
      })),
      setModelCapabilityOverride: (target: string, key: StoredCapabilityOverrideFixture["key"], value: number | readonly ReasoningEffortOverrideValue[]) => {
        const parts = splitTarget(target);
        if (!parts) return false;
        const row: CapabilityRow = {
          ...parts,
          key,
          value: structuredClone(value),
          refreshedAt: this.#clock(),
        };
        this.#capabilities.set(compositeKey(parts.provider, parts.modelId, key), row);
        this.#invalidations++;
        return true;
      },
      removeModelCapabilityOverride: (target: string, key: string) => {
        const parts = splitTarget(target);
        const removed = parts ? this.#capabilities.delete(compositeKey(parts.provider, parts.modelId, key)) : false;
        if (removed) this.#invalidations++;
        return removed;
      },
    };
    const contextDatabase = {
      listModelContextOverrides: () => [...this.#contexts.values()].map(row => structuredClone(row)),
      setModelContextOverride: (provider: string, modelId: string, realContext: number, source: "manual" | "auto:discovery") => {
        const row: ContextRow = { provider, modelId, realContext, source, refreshedAt: this.#clock() };
        this.#contexts.set(compositeKey(provider, modelId, "context_length"), row);
        this.#invalidations++;
        return true;
      },
      removeModelContextOverride: (provider: string, modelId: string) => {
        const removed = this.#contexts.delete(compositeKey(provider, modelId, "context_length"));
        if (removed) this.#invalidations++;
        return removed;
      },
    };
    const route = loadPinnedModule("src/app/api/model-capability-overrides/route.ts", specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "zod") return zod;
      if (specifier === "@omniroute/open-sse/services/model.ts") return aliasModule;
      if (specifier === "@/shared/reasoning/reasoningEffortsOverride") return reasoning;
      if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.#authorization.requireManagementAuth };
      if (specifier === "@/lib/db/modelCapabilityOverrides") return capabilityDatabase;
      if (specifier === "@/lib/db/modelContextOverrides") return contextDatabase;
      if (specifier === "@/lib/providerNodePrefixes") return prefixIndex;
      throw new Error(`Unapproved pinned model-capability route import: ${specifier}`);
    });
    const methods: PinnedCapabilityHandlers = {
      GET: route.GET as RouteHandler,
      PATCH: route.PATCH as RouteHandler,
      DELETE: route.DELETE as RouteHandler,
    };
    if (Object.values(methods).some(handler => typeof handler !== "function")) {
      throw new Error("Pinned model-capability route omitted an expected handler");
    }
    return methods;
  }

}
