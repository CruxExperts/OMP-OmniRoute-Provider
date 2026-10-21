import { randomUUID } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";

export const WHOAMI_OPERATION_ID = "GET /api/cli/whoami";
export type FixtureAccessScope = "read" | "write" | "admin";

/**
 * Behavior references, all at OmniRoute v3.8.52 / ad6f33f66bda34eba98645d3bfdabbde294bc843:
 * - src/app/api/cli/whoami/route.ts:15-37 (identity and nullable scope)
 * - src/lib/api/requireManagementAuth.ts:49-164 (conditional guard and alternatives)
 * - src/server/authz/accessTokenAuth.ts:27-66 (header-only token and verdict)
 * - src/lib/db/accessTokens.ts:74-79,128-158 (expiry, revocation, usage stamp)
 * Seed records substitute for the source database and cryptographic key/session verification.
 * They are synthetic fixture credentials, not authority for any real server.
 */
export interface FixtureAccessRecord {
  readonly secret: string;
  readonly id: string;
  readonly name: string;
  scope: FixtureAccessScope;
  readonly createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function whoamiSourceContract(): OperationSourceContract {
  const template = operationContractTemplate(WHOAMI_OPERATION_ID) as unknown as OperationSourceContract;
  const schema = {
    type: "object",
    properties: {
      authenticated: { type: "boolean", const: true },
      viaAccessToken: { type: "boolean" },
      id: { type: "string", minLength: 1 },
      name: { type: "string" },
      createdAt: { type: ["string", "null"] },
      lastUsedAt: { type: ["string", "null"] },
      expiresAt: { type: ["string", "null"] },
      scope: { type: ["string", "null"], enum: ["read", "write", "admin", null] },
    },
    required: ["authenticated", "viaAccessToken", "scope"],
    additionalProperties: false,
  };
  return {
    ...template,
    auth: {
      domain: "management",
      specificationAlternatives: template.auth.specificationAlternatives,
      sourcePolicy: {
        status: "qualified",
        source: "omniroute-v3.8.52",
        routeClass: "management",
        localOnly: false,
        handlerGuard: "requireManagementAuth",
        alternatives: [
          { kind: "management-api-key", anyOf: ["manage", "admin"] },
          { kind: "dashboard-session" },
          { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
          { kind: "oma-whoami-bootstrap", operationId: WHOAMI_OPERATION_ID },
          { kind: "trusted-local", loopbackOnly: true },
        ],
        bootstrap: "oma-whoami",
      },
    },
    response: {
      ...template.response,
      mediaType: "application/json",
      schema,
      variants: template.response.variants.map(variant => variant.statusCode !== "200" ? variant : {
        ...variant,
        sourceFiles: ["src/app/api/cli/whoami/route.ts"],
        content: [{ mediaType: "application/json", schema, sourceFile: "src/app/api/cli/whoami/route.ts" }],
      }),
    },
    secrets: { inputFields: [], outputFields: ["viaAccessToken", "id", "name", "createdAt", "lastUsedAt", "expiresAt"] },
    sideEffect: "read",
    pagination: { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: false, reason: "Returns non-secret current-credential scope metadata; successful token verification may update its usage timestamp. A null scope is never evidence of full access." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation: null,
  };
}

export class ManagementAuthFixture {
  readonly #tokens = new Map<string, FixtureAccessRecord>();
  readonly #keys = new Map<string, readonly string[]>();
  readonly #cookies = new Set<string>();
  readonly #server: Bun.Server<undefined>;
  readonly #clock: () => string;
  authRequired = true;
  failVerification = false;
  requests = 0;

  constructor(options: { tokens?: readonly FixtureAccessRecord[]; keys?: Readonly<Record<string, readonly string[]>>; cookies?: readonly string[]; clock?: () => string } = {}) {
    this.#clock = options.clock ?? (() => "2026-10-19T12:00:00.000Z");
    for (const record of options.tokens ?? []) this.#tokens.set(record.secret, structuredClone(record));
    for (const [key, scopes] of Object.entries(options.keys ?? {})) this.#keys.set(key, [...scopes]);
    for (const cookie of options.cookies ?? []) this.#cookies.add(cookie);
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }
  stop(): void { this.#server.stop(true); }
  setScope(secret: string, scope: FixtureAccessScope): void {
    const record = this.#tokens.get(secret);
    if (!record) throw new Error("fixture identity missing");
    record.scope = scope;
  }
  revoke(secret: string): void {
    const record = this.#tokens.get(secret);
    if (!record) throw new Error("fixture identity missing");
    record.revokedAt = this.#clock();
  }
  snapshot(): { records: { id: string; scope: FixtureAccessScope; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }[] } {
    return { records: [...this.#tokens.values()].map(({ id, scope, lastUsedAt, expiresAt, revokedAt }) => ({ id, scope, lastUsedAt, expiresAt, revokedAt })).sort((a, b) => a.id.localeCompare(b.id)) };
  }

  #verify(secret: string): FixtureAccessRecord | undefined {
    if (this.failVerification) throw new Error("synthetic verification backend unavailable");
    const record = this.#tokens.get(secret);
    if (!record || record.revokedAt) return undefined;
    const expires = record.expiresAt ? new Date(record.expiresAt).getTime() : Number.NaN;
    if (Number.isFinite(expires) && expires <= new Date(this.#clock()).getTime()) return undefined;
    record.lastUsedAt = this.#clock();
    return record;
  }

  #error(status: number, message: string): Response {
    return Response.json({ error: { message, type: status >= 500 ? "server_error" : "invalid_request" }, requestId: randomUUID() }, { status });
  }

  authorize(request: Request): Response | undefined {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const bearer = match?.[1]?.trim();
    if (this.authRequired && !this.#cookies.has(request.headers.get("cookie") ?? "")) {
      if (bearer?.startsWith("oma_")) {
        try {
          const identity = this.#verify(bearer);
          if (!identity) return this.#error(401, "Invalid or expired access token");
          const path = new URL(request.url).pathname;
          const providerPath = path === "/api/providers" || path.startsWith("/api/providers/");
          const read = ["GET", "HEAD", "OPTIONS"].includes(request.method);
          const need = read ? "read" : providerPath ? "admin" : "write";
          const ranks = { read: 0, write: 1, admin: 2 };
          if (ranks[identity.scope] < ranks[need]) return this.#error(403, `Access token scope '${identity.scope}' is insufficient; '${need}' required.`);
        } catch { return this.#error(503, "Service temporarily unavailable"); }
      } else if (bearer) {
        const scopes = this.#keys.get(bearer);
        if (!scopes) return this.#error(403, "Invalid management token");
        if (!scopes.some(scope => scope === "manage" || scope === "admin")) return this.#error(403, "API key lacks 'manage' scope. Enable it in the API Keys dashboard.");
      } else return this.#error(401, "Authentication required");
    }
    return undefined;
  }

  handle(request: Request): Response {
    if (new URL(request.url).pathname !== "/api/cli/whoami" || request.method !== "GET") return this.#error(404, "Not found");
    this.requests++;
    const denied = this.authorize(request);
    if (denied) return denied;
    const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("authorization") ?? "").trim());
    const bearer = match?.[1]?.trim();
    if (bearer?.startsWith("oma_")) {
      const record = this.#verify(bearer);
      if (record) return Response.json({ authenticated: true, viaAccessToken: true, id: record.id, name: record.name, scope: record.scope,
        createdAt: record.createdAt, lastUsedAt: record.lastUsedAt, expiresAt: record.expiresAt });
    }
    return Response.json({ authenticated: true, viaAccessToken: false, scope: null });
  }
}
