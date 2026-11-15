import * as zod from "zod";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { loadPinnedModule, readPinnedSource, withPinnedSourceSnapshot } from "./pinned-handler.fixture.ts";

export const WELL_KNOWN_CARD_IDS = ["GET /.well-known/agent-card.json", "GET /.well-known/agent.json"] as const;
export type WellKnownCardId = (typeof WELL_KNOWN_CARD_IDS)[number];
const hashes = ["6dec4e641f952837884e55b1e3c1c2fadd65651c692b98441de4d45e70cd89fb", "b3a6898d06386799c03a06d06abbc8f4a4c0d636c78db972212cef7c193ebdf8"] as const;
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
// Deliberately exclude URL and all skills: hub-controlled strings are unbounded and
// can contain private data. This is a client projection, not the full wire shape.
const view: JsonSchema = { type: "object", properties: {
  name: { type: "string", enum: ["OmniRoute AI Gateway"] },
  version: { type: "string", maxLength: 128 },
  capabilities: { type: "object", properties: { streaming: { type: "boolean" }, pushNotifications: { type: "boolean" } }, required: ["streaming", "pushNotifications"], additionalProperties: false },
}, required: ["name", "version", "capabilities"], additionalProperties: false };

/** Anonymous access is independently bound to the pinned Next ingress observation. */
export function wellKnownCardContract(id: WellKnownCardId): OperationSourceContract {
  const template = operationContractTemplate(id) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "public", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] } },
    response: { ...template.response, mediaType: "application/json", schema: view,
      variants: template.response.variants.map(variant => ({ ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode === "200" ? view : content.schema })) })) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "read",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: false, reason: "The source reads a configured external runner registry and maintains a process-local cache; external server effects are not observed." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

/** Descriptor for projection tests only; does not confer release eligibility. */
export function wellKnownCardDescriptor(id: WellKnownCardId): OperationDescriptor {
  const index = WELL_KNOWN_CARD_IDS.indexOf(id);
  const original = getOperation(id);
  if (index < 0 || !original || original.source.sha256 !== hashes[index]) throw new Error(`Unexpected card source identity: ${id}`);
  return { ...original, ...wellKnownCardContract(id) };
}

type CardRequest = { nextUrl: { origin: string } };
type Handler = (request?: CardRequest) => Promise<Response>;

/** Receipt-verified source graph; HTTP ingress, Next matcher and hub effects are not exercised. */
export class WellKnownAgentCardsFixture {
  now = 1_000_000;
  readonly #handlers: readonly Handler[];
  readonly #clear: () => void;
  constructor() {
    const graph = withPinnedSourceSnapshot(() => {
      const noImports = (s: string): never => { throw new Error(`Unexpected pinned import: ${s}`); };
      const clock = new Proxy(Date, { get: (target, property, receiver) => property === "now" ? () => this.now : Reflect.get(target, property, receiver) });
      const fleet = loadPinnedModule("src/lib/conductor/fleetSkills.ts", s => {
        if (s === "zod") return zod;
        return noImports(s);
      }, { date: clock });
      const config = loadPinnedModule("src/shared/constants/appConfig.ts", s => {
        if (s === "../../../package.json") return JSON.parse(readPinnedSource("package.json"));
        return noImports(s);
      });
      const metadata = loadPinnedModule("src/lib/a2a/agentCardMetadata.ts", s => {
        if (s === "@/shared/constants/appConfig") return config;
        return noImports(s);
      });
      const urls = loadPinnedModule("src/lib/wellKnown.ts", noImports);
      const handlers = ["src/app/.well-known/agent-card.json/route.ts", "src/app/.well-known/agent.json/route.ts"].map(path => {
        const route = loadPinnedModule(path, s => {
          if (s === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
          if (s === "@/lib/a2a/agentCardMetadata") return metadata;
          if (s === "@/lib/conductor/fleetSkills") return fleet;
          if (s === "@/lib/wellKnown") return urls;
          return noImports(s);
        });
        return route.GET as Handler;
      });
      return { handlers, clear: fleet.clearFleetSkillsCache as () => void };
    });
    this.#handlers = graph.handlers;
    this.#clear = graph.clear;
  }
  reset(): void { this.#clear(); }
  get(id: WellKnownCardId, origin?: string): Promise<Response> {
    const index = WELL_KNOWN_CARD_IDS.indexOf(id);
    if (index < 0) throw new Error(`Unexpected card operation: ${id}`);
    return this.#handlers[index]!(origin === undefined ? undefined : { nextUrl: { origin } });
  }
}
