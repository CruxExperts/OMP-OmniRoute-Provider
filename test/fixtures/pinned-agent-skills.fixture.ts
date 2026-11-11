import * as fs from "node:fs";
import * as path from "node:path";
import * as zod from "zod";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedFixtureDate, loadExtractedPinnedDeclarations, loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";

export const SKILLS_ID = "GET /api/agent-skills" as const;
export const SKILLS_TEST_ID = "test/admin-agent-skills-source.test.ts";
export const SKILLS_TIME = "2026-01-01T00:00:00.000Z";
const ROUTE = "src/app/api/agent-skills/route.ts";

/** Full error module with its pinned dependencies; log projection is an unused extracted boundary. */
function pinnedErrors(): PinnedExports {
  const leaf = (name: string) => loadPinnedModule(name, specifier => { throw new Error(`Unexpected ${name} import: ${specifier}`); });
  const flags = leaf("open-sse/utils/registeredFeatureFlag.ts");
  const safety = loadPinnedModule("open-sse/utils/providerSafety.ts", s => { if (s === "./registeredFeatureFlag.ts") return flags; throw new Error(`Unexpected safety import: ${s}`); });
  const paths = leaf("open-sse/utils/errorPathRedaction.ts");
  const credentials = leaf("open-sse/utils/credentialPatterns.ts");
  const sanitation = loadPinnedModule("open-sse/utils/errorSanitization.ts", s => {
    if (s === "./errorPathRedaction.ts") return paths;
    if (s === "./credentialPatterns.ts") return credentials;
    if (s === "./providerSafety.ts") return safety;
    throw new Error(`Unexpected sanitization import: ${s}`);
  });
  const passthrough = loadPinnedModule("open-sse/utils/upstreamErrorPassthrough.ts", s => { if (s === "./errorSanitization.ts") return sanitation; throw new Error(`Unexpected passthrough import: ${s}`); });
  const tencent = loadPinnedModule("open-sse/utils/tencentEnvelope.ts", s => { if (s === "./providerSafety.ts") return safety; throw new Error(`Unexpected Tencent import: ${s}`); });
  const identifiers = loadPinnedModule("open-sse/utils/publicErrorIdentifiers.ts", s => { if (s === "./providerSafety.ts") return safety; throw new Error(`Unexpected identifier import: ${s}`); });
  const modules: Record<string, PinnedExports> = {
    "./cors.ts": leaf("open-sse/utils/cors.ts"),
    "./clinepassEnvelope.ts": leaf("open-sse/utils/clinepassEnvelope.ts"),
    "./tencentEnvelope.ts": tencent,
    "./providerSafety.ts": safety,
    "./errorSanitization.ts": sanitation,
    "../config/errorConfig.ts": leaf("open-sse/config/errorConfig.ts"),
    "@/lib/logPayloads": loadExtractedPinnedDeclarations(["src/lib/logPayloads.ts"], ["normalizePayloadForLog"], s => { throw new Error(`Unexpected log import: ${s}`); }),
    "./upstreamErrorPassthrough.ts": passthrough,
    "./registeredFeatureFlag.ts": flags,
    "./publicErrorIdentifiers.ts": identifiers,
    "./retryAfterInstant.ts": leaf("open-sse/utils/retryAfterInstant.ts"),
    "./proseRetryDelay.ts": leaf("open-sse/utils/proseRetryDelay.ts"),
    "../services/retryAfterJson.ts": leaf("open-sse/services/retryAfterJson.ts"),
  };
  return loadPinnedModule("open-sse/utils/error.ts", s => { if (modules[s]) return modules[s]; throw new Error(`Unexpected error import: ${s}`); });
}

/** Direct handler HTTP only; filesystem reads are confined to the supplied disposable root. */
export class PinnedAgentSkillsFixture {
  readonly #server: { readonly url: URL; stop(closeActiveConnections?: boolean): unknown };
  failNextJson = false;
  constructor(root: string) {
    readPinnedSource("src/lib/agentSkills/types.ts"); // erased type-only imports
    const constants = loadPinnedModule("src/shared/constants/agentSkills.ts", s => { throw new Error(`Unexpected constants import: ${s}`); });
    const schemas = loadPinnedModule("src/lib/agentSkills/schemas.ts", s => { if (s === "zod") return zod; throw new Error(`Unexpected schema import: ${s}`); });
    const skillsDir = path.resolve(root, "skills");
    const sandboxPath = { ...path, resolve: (...parts: string[]) => parts.length === 2 && parts[1] === "skills" ? skillsDir : path.resolve(...parts) };
    const readOnlyFs = { readdirSync: fs.readdirSync, existsSync: fs.existsSync };
    const catalog = loadPinnedModule("src/lib/agentSkills/catalog.ts", s => {
      if (s === "node:fs") return readOnlyFs;
      if (s === "node:path") return sandboxPath;
      if (s === "@/shared/constants/agentSkills") return constants;
      throw new Error(`Unexpected catalog import: ${s}`);
    }, { date: createPinnedFixtureDate(SKILLS_TIME) });
    const errors = pinnedErrors();
    const route = loadPinnedModule(ROUTE, s => {
      if (s === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => {
        if (this.failNextJson) { this.failNextJson = false; throw new Error("fixture-private-json-failure"); }
        return Response.json(body, init);
      } } };
      if (s === "@omniroute/open-sse/utils/error.ts") return errors;
      if (s === "@/lib/agentSkills/schemas") return schemas;
      if (s === "@/lib/agentSkills/catalog") return catalog;
      throw new Error(`Unexpected route import: ${s}`);
    });
    const get = route.GET as (request: Request) => Promise<Response>;
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => request.method === "GET" && new URL(request.url).pathname === "/api/agent-skills" ? get(request) : new Response(null, { status: 404 }) });
  }
  handle(query = ""): Promise<Response> { return fetch(`${this.#server.url.origin}/api/agent-skills${query}`); }
  close(): void { this.#server.stop(true); }
}

const text: JsonSchema = { type: "string" };
const count: JsonSchema = { type: "integer", minimum: 0 };
const skill: JsonSchema = { type: "object", properties: { id: text, name: text, description: text, category: { type: "string", enum: ["api", "cli", "config", "external"] }, area: text, endpoints: { type: "array", items: text }, cliCommands: { type: "array", items: text }, icon: text, isEntry: { type: "boolean" }, isNew: { type: "boolean" }, rawUrl: text, githubUrl: text }, required: ["id", "name", "description", "category", "area", "rawUrl", "githubUrl"], additionalProperties: false };
const coveragePart: JsonSchema = { type: "object", properties: { have: count, total: count }, required: ["have", "total"], additionalProperties: false };
const coverage: JsonSchema = { type: "object", properties: { api: coveragePart, cli: coveragePart, config: coveragePart, totalSkills: count, generatedAt: { type: "string", format: "date-time" } }, required: ["api", "cli", "config", "totalSkills", "generatedAt"], additionalProperties: false };
const success: JsonSchema = { type: "object", properties: { skills: { type: "array", items: skill }, count, coverage }, required: ["skills", "count", "coverage"], additionalProperties: false };
const error: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { message: text, type: text, code: text }, required: ["message", "type", "code"], additionalProperties: false } }, required: ["error"], additionalProperties: false };

/** Candidate only. Shared Next ingress is not established by this fixture. */
export function agentSkillsContract(): OperationSourceContract {
  const template = operationContractTemplate(SKILLS_ID) as unknown as OperationSourceContract;
  const category: JsonSchema = { type: "string", enum: ["api", "cli", "config"] };
  return { ...template,
    request: { ...template.request, querySchema: { type: "object", properties: { category, area: text }, additionalProperties: false } },
    auth: { ...template.auth, domain: "management", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", bootstrap: "none", alternatives: [{ kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: "read" }] } },
    response: { ...template.response, mediaType: "application/json", schema: { oneOf: [success, error] }, variants: template.response.variants.map(variant => ["200", "400", "500"].includes(variant.statusCode) ? { ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode === "200" ? success : error })) } : variant) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "read", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" }, confirmation: { required: false, reason: "The handler reads a static catalog and checks skill files without writing." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}
export function agentSkillsDescriptor(): OperationDescriptor {
  const original = getOperation(SKILLS_ID);
  if (!original) throw new Error(`Missing pinned operation ${SKILLS_ID}`);
  return { ...original, ...agentSkillsContract() };
}
