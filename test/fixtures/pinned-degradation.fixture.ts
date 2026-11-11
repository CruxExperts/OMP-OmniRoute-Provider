import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedFixtureDate, loadPinnedModule, type PinnedExports } from "./pinned-handler.fixture.ts";

export const DEGRADATION_ID = "GET /api/health/degradation" as const;
export const DEGRADATION_TIME = "2026-01-01T00:00:00.000Z";
const ROUTE = "src/app/api/health/degradation/route.ts";
const DOMAIN = "src/domain/degradation.ts";

type Options = { fullCapability?: string; reducedCapability?: string; defaultCapability?: string };
type Domain = PinnedExports & {
  withDegradation<T>(feature: string, primary: () => T | Promise<T>, fallback: () => T | Promise<T>, safeDefault: T, options?: Options): Promise<unknown>;
  withDegradationSync<T>(feature: string, primary: () => T, fallback: () => T, safeDefault: T, options?: Options): unknown;
  resetDegradationRegistry(): void;
};

/** Receipt-verified route and actual isolated registry; only NextResponse is substituted. */
export class PinnedDegradationFixture {
  readonly domain: Domain;
  readonly #get: (request: Request) => Promise<Response>;
  failNextJson = false;
  constructor() {
    this.domain = loadPinnedModule(DOMAIN, specifier => { throw new Error(`Unexpected degradation domain dependency: ${specifier}`); }, { date: createPinnedFixtureDate(DEGRADATION_TIME) }) as Domain;
    const route = loadPinnedModule(ROUTE, specifier => {
      if (specifier === "@/domain/degradation") return this.domain;
      if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => {
        if (this.failNextJson) { this.failNextJson = false; throw new Error("fixture-private-json-error"); }
        return Response.json(body, init);
      } } };
      throw new Error(`Unexpected degradation route dependency: ${specifier}`);
    });
    this.#get = route.GET as (request: Request) => Promise<Response>;
  }
  handle(query = ""): Promise<Response> {
    return this.#get(new Request(`http://fixture.invalid/api/health/degradation${query}`));
  }
}

const count: JsonSchema = { type: "integer", minimum: 0 };
const summary: JsonSchema = { type: "object", properties: { full: count, reduced: count, minimal: count, default: count }, required: ["full", "reduced", "minimal", "default"], additionalProperties: false };
const feature: JsonSchema = { type: "object", properties: { level: { type: "string", enum: ["full", "reduced", "minimal", "default"] }, feature: { type: "string" }, capability: { type: "string" }, reason: { type: "string" }, since: { type: "string", format: "date-time" } }, required: ["level", "feature", "capability", "reason", "since"], additionalProperties: false };
const report: JsonSchema = { type: "object", properties: { active: { type: "boolean" }, summary, features: { type: "array", items: feature } }, required: ["active", "summary", "features"], additionalProperties: false };
const compact: JsonSchema = { type: "object", properties: { summary, isDegraded: { type: "boolean" } }, required: ["summary", "isDegraded"], additionalProperties: false };
const error: JsonSchema = { type: "object", properties: { error: { type: "string", const: "Failed to fetch degradation report." } }, required: ["error"], additionalProperties: false };

/** Review-only candidate: no claim that the unbounded registry is a complete safe output. */
export function degradationContract(): OperationSourceContract {
  const template = operationContractTemplate(DEGRADATION_ID) as unknown as OperationSourceContract;
  const success: JsonSchema = { oneOf: [report, compact] };
  return {
    ...template,
    request: { ...template.request, querySchema: { type: "object", properties: { summary: { type: "string" } }, additionalProperties: false }, parameters: [{ name: "summary", in: "query", required: false, style: "form", explode: true, allowReserved: false, schema: { type: "string" }, inputAllowed: true, sourceFile: ROUTE }] },
    auth: { ...template.auth, domain: "management", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", bootstrap: "none", alternatives: [{ kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: "read" }] } },
    response: { ...template.response, mediaType: "application/json", schema: { oneOf: [report, compact, error] }, variants: template.response.variants.map(variant => variant.statusCode === "200" || variant.statusCode === "500" ? { ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode === "200" ? success : error })) } : variant) },
    secrets: { inputFields: [], outputFields: ["reason"] }, sideEffect: "read", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" }, confirmation: { required: false, reason: "The route reads the in-memory degradation registry." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export function degradationDescriptor(): OperationDescriptor {
  const original = getOperation(DEGRADATION_ID);
  if (!original) throw new Error(`Missing pinned operation ${DEGRADATION_ID}`);
  return { ...original, ...degradationContract() };
}
