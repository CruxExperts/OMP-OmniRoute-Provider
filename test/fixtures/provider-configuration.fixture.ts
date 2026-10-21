import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import type { JsonValue } from "../../src/admin/types.ts";
import { sourceNormalizationBinding, sourceStateViewBinding, type SourceStateViewId } from "../../src/admin/source-normalization.ts";

export const PROVIDER_CONFIGURATION_OPERATION_IDS = [
  "GET /api/providers/{id}/interception-rules",
  "PUT /api/providers/{id}/interception-rules",
  "DELETE /api/providers/{id}/interception-rules",
  "GET /api/providers/{id}/param-filters",
  "PUT /api/providers/{id}/param-filters",
  "DELETE /api/providers/{id}/param-filters",
] as const;

export type ProviderConfigurationOperationId = typeof PROVIDER_CONFIGURATION_OPERATION_IDS[number];
type ConfigFamily = "interception-rules" | "param-filters";
type RecordValue = { [key: string]: JsonValue };
type ProviderConfigurationContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation">;


const BACKENDS = ["firecrawl", "jina", "tavily"] as const;
const ERROR_SCHEMA = { type: "object" } as const;
const SUCCESS_SCHEMA = {
  type: "object",
  required: ["success"],
  properties: { success: { type: "boolean", const: true } },
  additionalProperties: false,
} as const;

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, additionalProperties: false };
}

const MODEL_INTERCEPTION_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
});
const INTERCEPTION_CONFIG_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
  models: { type: "object", "x-key-role": "identifier", additionalProperties: MODEL_INTERCEPTION_SCHEMA },
});
const INTERCEPTION_REQUEST_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
  models: { type: "object", additionalProperties: MODEL_INTERCEPTION_SCHEMA },
});
const PARAMETER_LIST_SCHEMA = { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 500 };
const MODEL_PARAM_FILTER_SCHEMA = objectSchema({
  block: PARAMETER_LIST_SCHEMA,
  allow: PARAMETER_LIST_SCHEMA,
});
const PARAM_FILTERS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["block", "allow", "autoLearn"],
  properties: {
    block: PARAMETER_LIST_SCHEMA,
    allow: PARAMETER_LIST_SCHEMA,
    models: { type: "object", "x-key-role": "identifier", additionalProperties: MODEL_PARAM_FILTER_SCHEMA },
    autoLearn: { type: "boolean" },
  },
  additionalProperties: false,
};
const PARAM_FILTERS_REQUEST_SCHEMA = objectSchema({
  block: PARAMETER_LIST_SCHEMA,
  allow: PARAMETER_LIST_SCHEMA,
  models: { type: "object", additionalProperties: MODEL_PARAM_FILTER_SCHEMA },
  autoLearn: { type: "boolean" },
});

function familyFor(operationId: ProviderConfigurationOperationId): ConfigFamily {
  return operationId.includes("interception-rules") ? "interception-rules" : "param-filters";
}

function normalizationId(family: ConfigFamily): SourceStateViewId {
  return family === "interception-rules"
    ? "omniroute-v3.8.52.provider-interception-rules"
    : "omniroute-v3.8.52.provider-param-filters";
}

function handlerFor(operationId: ProviderConfigurationOperationId): string {
  const path = operationId.slice(operationId.indexOf(" ") + 1);
  const binding = sourceNormalizationBinding(normalizationId(familyFor(operationId)));
  if (!binding || path !== binding.pathTemplate) throw new Error("provider configuration operation has no pinned source binding");
  return `src/app${binding.pathTemplate.replace("{id}", "[id]")}/route.ts`;
}


function managementAuth(template: ProviderConfigurationContract, minimumScope: "read" | "admin"): ProviderConfigurationContract["auth"] {
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

function responseContract(
  base: ProviderConfigurationContract["response"],
  operationId: ProviderConfigurationOperationId,
  successSchema: ProviderConfigurationContract["response"]["schema"],
): ProviderConfigurationContract["response"] {
  const handler = handlerFor(operationId);
  const statuses = operationId.startsWith("PUT ")
    ? ["200", "400", "401", "403", "500", "503"]
    : ["200", "401", "403", "500", "503"];
  const variants = statuses.map(statusCode => {
    const documented = base.variants.find(variant => variant.statusCode === statusCode);
    if (statusCode === "401" || statusCode === "403" || statusCode === "503") {
      if (!documented) throw new Error(`pinned route is missing shared auth/error variant ${statusCode}: ${operationId}`);
      return documented;
    }
    const content = documented?.content.length
      ? documented.content.map(item => statusCode === "200" ? { ...item, schema: successSchema } : item)
      : [{ mediaType: "application/json", schema: statusCode === "200" ? successSchema : ERROR_SCHEMA, sourceFile: handler }];
    const sourceFiles = [...new Set([...(documented?.sourceFiles ?? []), handler])];
    return { statusCode, content, headers: documented?.headers ?? {}, sourceFiles };
  });
  return { statusCodes: statuses, mediaType: "application/json", schema: successSchema, variants };
}

function putRequest(template: ProviderConfigurationContract["request"], family: ConfigFamily): ProviderConfigurationContract["request"] {
  const schema = family === "interception-rules" ? INTERCEPTION_REQUEST_SCHEMA : PARAM_FILTERS_REQUEST_SCHEMA;
  const sourceNormalizer = normalizationId(family);
  return {
    ...template,
    body: {
      required: true,
      mediaType: "application/json",
      schema,
      contentVariants: [{ mediaType: "application/json", schema }],
    },
    sourceNormalizer,
  };
}

function pathInputMapping() {
  return [{
    target: { section: "path" as const, field: "id" },
    source: { section: "path" as const, path: ["id"] },
  }];
}

function updateRelation(family: ConfigFamily) {
  const view = normalizationId(family);
  const binding = sourceStateViewBinding(view);
  if (!binding) throw new Error("provider configuration normalization has no pinned source binding");
  const getOperationId = `${binding.readMethod} ${binding.pathTemplate}`;
  return {
    targetRead: {
      operationId: getOperationId,
      inputs: pathInputMapping(),
      snapshot: {
        kind: "resource" as const,
        identity: [],
        state: [{ name: "config", path: [], sourceView: view }],
      },
    },
    reconcile: {
      operationId: getOperationId,
      inputs: pathInputMapping(),
      outcome: {
        kind: "matches" as const,
        identityFields: [],
        stateFields: ["config"],
        expectedFromInput: [{
          name: "config",
          source: { section: "body" as const, path: [] },
          sourceView: view,
        }],
      },
    },
  };
}

function sourceContract(operationId: ProviderConfigurationOperationId): ProviderConfigurationContract {
  const template = operationContractTemplate(operationId) as unknown as ProviderConfigurationContract;
  const family = familyFor(operationId);
  const method = operationId.slice(0, operationId.indexOf(" "));
  const read = method === "GET";
  const write = method === "PUT";
  const successSchema = read
    ? family === "interception-rules" ? INTERCEPTION_CONFIG_SCHEMA : PARAM_FILTERS_SCHEMA
    : SUCCESS_SCHEMA;
  const confirmation = read
    ? { required: false, reason: "Source-defined provider configuration read; management authentication is required." }
    : !write
      ? { required: true, reason: "Deletes only this provider's configuration row. The matching GET returns defaults for both an absent row and a persisted empty row, so deletion cannot be reconciled from the public response; one human-approved attempt is allowed, and an ambiguous result remains unknown without replay." }
      : { required: true, reason: "Upserts this provider's complete configuration row after source validation; apply requires human confirmation and target-state revalidation." };
  const request = write ? putRequest(template.request, family) : template.request;
  const reconciliation = write ? updateRelation(family) : null;
  return {
    request,
    auth: managementAuth(template, read ? "read" : "admin"),
    response: responseContract(template.response, operationId, successSchema),
    secrets: family === "interception-rules"
      ? { inputFields: write ? ["fetchProxyUrl"] : [], outputFields: read ? ["fetchProxyUrl"] : [] }
      : { inputFields: [], outputFields: [] },
    sideEffect: read ? "read" : "mutation",
    pagination: { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation,
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation,
  };
}

export const PROVIDER_CONFIGURATION_SOURCE_CONTRACTS = Object.fromEntries(
  PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => [operationId, sourceContract(operationId)]),
) as Record<ProviderConfigurationOperationId, OperationSourceContract>;

export function providerConfigurationDescriptor(operationId: ProviderConfigurationOperationId): OperationDescriptor {
  const template = getOperation(operationId);
  if (!template) throw new Error(`pinned provider configuration operation is absent: ${operationId}`);
  const contract = PROVIDER_CONFIGURATION_SOURCE_CONTRACTS[operationId];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBody(): never {
  throw new Error("source body validation failed");
}

function parseOptionalBoolean(source: Record<string, unknown>, field: string, output: RecordValue): void {
  if (!Object.hasOwn(source, field)) return;
  if (typeof source[field] !== "boolean") invalidBody();
  output[field] = source[field] as boolean;
}

function parseOptionalBackend(source: Record<string, unknown>, output: RecordValue): void {
  if (!Object.hasOwn(source, "fetchBackend")) return;
  if (typeof source.fetchBackend !== "string" || !BACKENDS.includes(source.fetchBackend as typeof BACKENDS[number])) invalidBody();
  output.fetchBackend = source.fetchBackend;
}

function parseOptionalUrl(source: Record<string, unknown>, output: RecordValue): void {
  if (!Object.hasOwn(source, "fetchProxyUrl")) return;
  if (typeof source.fetchProxyUrl !== "string") invalidBody();
  const value = source.fetchProxyUrl.trim();
  if (value.length > 2000) invalidBody();
  try { new URL(value); } catch { invalidBody(); }
  output.fetchProxyUrl = value;
}

function parseInterceptionRule(value: unknown): RecordValue {
  if (!isRecord(value)) invalidBody();
  const output: RecordValue = {};
  parseOptionalBoolean(value, "interceptSearch", output);
  parseOptionalBoolean(value, "interceptFetch", output);
  parseOptionalBackend(value, output);
  parseOptionalUrl(value, output);
  return output;
}

function parseInterceptionBody(value: unknown): RecordValue {
  if (!isRecord(value)) invalidBody();
  const output: RecordValue = {};
  parseOptionalBoolean(value, "interceptSearch", output);
  parseOptionalBoolean(value, "interceptFetch", output);
  parseOptionalBackend(value, output);
  parseOptionalUrl(value, output);
  if (Object.hasOwn(value, "models")) {
    if (!isRecord(value.models)) invalidBody();
    const entries = new Map<string, JsonValue>();
    for (const [sourceKey, sourceRule] of Object.entries(value.models)) {
      const key = sourceKey.trim();
      if (key.length < 1 || key.length > 200) invalidBody();
      const rule = parseInterceptionRule(sourceRule);
      entries.set(key, rule);
    }
    if (entries.size > 0) output.models = Object.fromEntries(entries);
  }
  return output;
}

function parseParamList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) invalidBody();
  return value.map(item => {
    if (typeof item !== "string") invalidBody();
    const trimmed = item.trim();
    if (trimmed.length < 1 || trimmed.length > 200) invalidBody();
    return trimmed;
  });
}

function parseParamRule(value: unknown): RecordValue {
  if (!isRecord(value)) invalidBody();
  const output: RecordValue = {};
  if (Object.hasOwn(value, "block")) output.block = parseParamList(value.block);
  if (Object.hasOwn(value, "allow")) output.allow = parseParamList(value.allow);
  return output;
}

function parseParamBody(value: unknown): RecordValue {
  if (!isRecord(value)) invalidBody();
  const output: RecordValue = {};
  if (Object.hasOwn(value, "block")) output.block = parseParamList(value.block);
  if (Object.hasOwn(value, "allow")) output.allow = parseParamList(value.allow);
  if (Object.hasOwn(value, "autoLearn")) {
    if (typeof value.autoLearn !== "boolean") invalidBody();
    output.autoLearn = value.autoLearn;
  }
  if (Object.hasOwn(value, "models")) {
    if (!isRecord(value.models)) invalidBody();
    const entries = new Map<string, JsonValue>();
    for (const [sourceKey, sourceRule] of Object.entries(value.models)) {
      const key = sourceKey.trim();
      if (key.length < 1 || key.length > 200) invalidBody();
      const rule = parseParamRule(sourceRule);
      entries.set(key, rule);
    }
    if (entries.size > 0) output.models = Object.fromEntries(entries);
  }
  return output;
}

function readInterception(value: JsonValue | undefined): JsonValue {
  if (!isRecord(value)) return {};
  const output: RecordValue = {};
  if (typeof value.interceptSearch === "boolean") output.interceptSearch = value.interceptSearch;
  if (typeof value.interceptFetch === "boolean") output.interceptFetch = value.interceptFetch;
  if (typeof value.fetchBackend === "string" && BACKENDS.includes(value.fetchBackend as typeof BACKENDS[number])) output.fetchBackend = value.fetchBackend;
  if (typeof value.fetchProxyUrl === "string" && value.fetchProxyUrl.trim().length > 0) output.fetchProxyUrl = value.fetchProxyUrl.trim();
  if (isRecord(value.models)) {
    const models: RecordValue = {};
    for (const [modelId, candidate] of Object.entries(value.models)) {
      if (!isRecord(candidate)) continue;
      const rule: RecordValue = {};
      if (typeof candidate.interceptSearch === "boolean") rule.interceptSearch = candidate.interceptSearch;
      if (typeof candidate.interceptFetch === "boolean") rule.interceptFetch = candidate.interceptFetch;
      if (typeof candidate.fetchBackend === "string" && BACKENDS.includes(candidate.fetchBackend as typeof BACKENDS[number])) rule.fetchBackend = candidate.fetchBackend;
      if (typeof candidate.fetchProxyUrl === "string" && candidate.fetchProxyUrl.trim().length > 0) rule.fetchProxyUrl = candidate.fetchProxyUrl.trim();
      if (Object.keys(rule).length > 0) models[modelId] = rule;
    }
    if (Object.keys(models).length > 0) output.models = models;
  }
  return output;
}

function readParamFilters(value: JsonValue | undefined): JsonValue {
  if (!isRecord(value)) return { block: [], allow: [], autoLearn: false };
  const block = Array.isArray(value.block) ? value.block.filter((item): item is string => typeof item === "string") : [];
  const allow = Array.isArray(value.allow) ? value.allow.filter((item): item is string => typeof item === "string") : [];
  const output: RecordValue = {
    block: [...block],
    allow: [...allow],
    autoLearn: typeof value.autoLearn === "boolean" ? value.autoLearn : false,
  };
  if (isRecord(value.models)) {
    const models: RecordValue = {};
    for (const [modelId, candidate] of Object.entries(value.models)) {
      if (!isRecord(candidate)) continue;
      const modelBlock = Array.isArray(candidate.block) ? candidate.block.filter((item): item is string => typeof item === "string") : [];
      const modelAllow = Array.isArray(candidate.allow) ? candidate.allow.filter((item): item is string => typeof item === "string") : [];
      if (modelBlock.length > 0 || modelAllow.length > 0) {
        const rule: RecordValue = {};
        if (modelBlock.length > 0) rule.block = [...modelBlock];
        if (modelAllow.length > 0) rule.allow = [...modelAllow];
        models[modelId] = rule;
      }
    }
    if (Object.keys(models).length > 0) output.models = models;
  }
  return output;
}

export interface ProviderConfigurationFixtureSeed {
  readonly interception?: Readonly<Record<string, JsonValue>>;
  readonly paramFilters?: Readonly<Record<string, JsonValue>>;
}

interface DeleteHold {
  readonly received: Promise<void>;
  readonly wait: Promise<void>;
  release(): void;
  notifyReceived(): void;
}

/** Faithful loopback-only route/DB fixture for the six pinned management handlers. */
export class ProviderConfigurationFixture {
  readonly #interception = new Map<string, JsonValue>();
  readonly #paramFilters = new Map<string, JsonValue>();
  readonly #counts = new Map<string, number>();
  readonly #server: ReturnType<typeof Bun.serve>;
  #failNextRead = false;
  #failNextWrite = false;
  #nextDeleteHold: DeleteHold | undefined;
  authRequired = true;

  constructor(seed: ProviderConfigurationFixtureSeed = {}) {
    for (const [id, config] of Object.entries(seed.interception ?? {})) this.#interception.set(id, structuredClone(config));
    for (const [id, config] of Object.entries(seed.paramFilters ?? {})) this.#paramFilters.set(id, structuredClone(config));
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => this.#handle(request),
    });
  }

  get endpoint(): string {
    return this.#server.url.origin;
  }

  count(operationId: string): number {
    return this.#counts.get(operationId) ?? 0;
  }


  failNextRead(): void { this.#failNextRead = true; }
  failNextWrite(): void { this.#failNextWrite = true; }

  holdNextDeleteResponse(): DeleteHold {
    let receivedResolve!: () => void;
    let releaseResolve!: () => void;
    const hold: DeleteHold = {
      received: new Promise<void>(resolve => { receivedResolve = resolve; }),
      wait: new Promise<void>(resolve => { releaseResolve = resolve; }),
      release: () => releaseResolve(),
      notifyReceived: () => receivedResolve(),
    };
    this.#nextDeleteHold = hold;
    return hold;
  }

  interception(providerId: string): JsonValue {
    return structuredClone(readInterception(this.#interception.get(providerId)));
  }

  paramFilters(providerId: string): JsonValue {
    return structuredClone(readParamFilters(this.#paramFilters.get(providerId)));
  }

  close(): void {
    this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/providers\/([^/]+)\/(interception-rules|param-filters)$/.exec(path);
    if (!match) return jsonResponse({ error: "Not found" }, 404);
    let providerId: string;
    try { providerId = decodeURIComponent(match[1]!); } catch { return jsonResponse({ error: "Invalid provider id" }, 400); }
    const family = match[2] as ConfigFamily;
    const operationId = `${request.method} /api/providers/{id}/${family}` as ProviderConfigurationOperationId;
    const count = this.count(operationId) + 1;
    this.#counts.set(operationId, count);

    if (!this.#authorized(request)) {
      const hasCredential = request.headers.has("authorization") || request.headers.has("cookie");
      return jsonResponse({ error: "Management authentication required" }, hasCredential ? 403 : 401);
    }
    if (request.method === "GET") {
      if (this.#failNextRead) {
        this.#failNextRead = false;
        return jsonResponse({ error: "Fixture database read failed" }, 500);
      }
      const value = family === "interception-rules"
        ? readInterception(this.#interception.get(providerId))
        : readParamFilters(this.#paramFilters.get(providerId));
      return jsonResponse(value, 200);
    }
    if (request.method === "PUT") {
      let raw: unknown;
      try { raw = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
      let parsed: RecordValue;
      try { parsed = family === "interception-rules" ? parseInterceptionBody(raw) : parseParamBody(raw); }
      catch { return jsonResponse({ error: "Invalid configuration body" }, 400); }
      if (this.#failNextWrite) {
        this.#failNextWrite = false;
        return jsonResponse({ error: "Fixture database write failed" }, 500);
      }
      if (family === "interception-rules") {
        const stored: RecordValue = {
          interceptSearch: parsed.interceptSearch ?? null,
          interceptFetch: parsed.interceptFetch ?? null,
          fetchBackend: parsed.fetchBackend ?? null,
          fetchProxyUrl: parsed.fetchProxyUrl ?? null,
        };
        // The upstream DB serializes undefined properties away and omits empty model maps.
        for (const field of ["interceptSearch", "interceptFetch", "fetchBackend", "fetchProxyUrl"] as const) {
          if (stored[field] === null) delete stored[field];
        }
        if (isRecord(parsed.models) && Object.keys(parsed.models).length > 0) stored.models = parsed.models;
        this.#interception.set(providerId.trim(), stored);
      } else {
        const stored: RecordValue = {
          block: parsed.block ?? [],
          allow: parsed.allow ?? [],
          autoLearn: parsed.autoLearn ?? false,
        };
        if (isRecord(parsed.models) && Object.keys(parsed.models).length > 0) stored.models = parsed.models;
        this.#paramFilters.set(providerId, stored);
      }
      return jsonResponse({ success: true }, 200);
    }
    if (request.method === "DELETE") {
      if (this.#failNextWrite) {
        this.#failNextWrite = false;
        return jsonResponse({ error: "Fixture database write failed" }, 500);
      }
      if (family === "interception-rules") this.#interception.delete(providerId.trim());
      else this.#paramFilters.delete(providerId);
      const hold = this.#nextDeleteHold;
      this.#nextDeleteHold = undefined;
      if (hold) {
        hold.notifyReceived();
        await hold.wait;
      }
      return jsonResponse({ success: true }, 200);
    }
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  #authorized(request: Request): boolean {
    if (!this.authRequired) return true;
    if (request.headers.get("authorization") === "Bearer fixture-management-key") return true;
    return request.headers.get("cookie") === "omniroute_session=fixture-dashboard-session";
  }
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
