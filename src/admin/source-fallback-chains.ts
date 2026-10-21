/*
 * Source behavior: OmniRoute v3.8.52, commit ad6f33f66bda34eba98645d3bfdabbde294bc843.
 * Source SHA-256 bindings:
 * - src/app/api/fallback/chains/route.ts: 2fc08aa36a836012d0c3c1c18e0e8b0f71a3396b14caaffa7d1acf4d96c5a43d
 * - src/domain/fallbackPolicy.ts: 0db12e742adb789209966d5ce677a83f4d3e49d266ed238cbece93b545869b8a
 * - src/lib/db/domainState.ts: 94760ab093e3d1f57cfd8a0d661fe7afa8b32d0e1b56e8ca8fc8f70587d9d4f4
 * - src/shared/validation/schemas/routing.ts: e23abacb53658d3466e17fff2a854c581efc5a14777c21be5716aeb03ff7492f
 * - src/shared/validation/schemas/misc.ts: a718f14bfbe1b08d5265393277cb61310445809ef03a01a90e163eecb1b62d93
 * - src/shared/validation/helpers.ts: 4c0ce67959151549033102b7ac1f8367c2be82560002ba1ab5a53d3c4e930d5c
 *
 * MIT License
 * Copyright (c) 2026 diegosouzapw
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { OperationDescriptor, ValidatedOperationInput } from "./registry.ts";
import type { JsonObject, JsonValue } from "./types.ts";

export const FALLBACK_CHAIN_GET = "GET /api/fallback/chains" as const;
export const FALLBACK_CHAIN_POST = "POST /api/fallback/chains" as const;
export const FALLBACK_CHAIN_DELETE = "DELETE /api/fallback/chains" as const;
export const FALLBACK_CHAIN_ROUTE = "/api/fallback/chains" as const;

export type FallbackChainMutationOperation = typeof FALLBACK_CHAIN_POST | typeof FALLBACK_CHAIN_DELETE;
export type FallbackChainOperation = typeof FALLBACK_CHAIN_GET | FallbackChainMutationOperation;
export type FallbackChainRequestValidatorId =
  | "omniroute-v3.8.52.fallback-chains.register"
  | "omniroute-v3.8.52.fallback-chains.remove";
export type FallbackChainRelationViewId = "omniroute-v3.8.52.fallback-chains.reconciliation";

export interface FallbackChainEntry {
  readonly provider: string;
  readonly priority: number;
  readonly enabled: boolean;
}

export interface FallbackChainEntryInput {
  readonly provider: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly [field: string]: unknown;
}

export interface FallbackChainMutationData {
  readonly model: string;
  readonly chain?: readonly FallbackChainEntryInput[];
}

export interface FallbackChainValidationIssue {
  readonly field: string;
  readonly message: string;
}

export type FallbackChainValidationResult =
  | { readonly success: true; readonly data: FallbackChainMutationData }
  | { readonly success: false; readonly error: { readonly message: "Invalid request"; readonly details: readonly FallbackChainValidationIssue[] } };

export interface FallbackChainHookBinding {
  readonly id: string;
  readonly operations: readonly string[];
  readonly methods: readonly ("POST" | "DELETE")[];
  readonly pathTemplate: typeof FALLBACK_CHAIN_ROUTE;
}

export const FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS: Readonly<Record<FallbackChainRequestValidatorId, FallbackChainHookBinding>> = Object.freeze({
  "omniroute-v3.8.52.fallback-chains.register": Object.freeze({
    id: "omniroute-v3.8.52.fallback-chains.register",
    operations: Object.freeze([FALLBACK_CHAIN_POST]),
    methods: Object.freeze(["POST"] as const),
    pathTemplate: FALLBACK_CHAIN_ROUTE,
  }),
  "omniroute-v3.8.52.fallback-chains.remove": Object.freeze({
    id: "omniroute-v3.8.52.fallback-chains.remove",
    operations: Object.freeze([FALLBACK_CHAIN_DELETE]),
    methods: Object.freeze(["DELETE"] as const),
    pathTemplate: FALLBACK_CHAIN_ROUTE,
  }),
});

/**
 * Parent integration hook: call after the exact GET collection response is projected,
 * and for POST/DELETE target reads and reconciliation expectations. It selects the
 * mutation's body.model as the only resource key and applies source normalization.
 */
export const FALLBACK_CHAIN_RELATION_VIEW_BINDING: FallbackChainHookBinding = Object.freeze({
  id: "omniroute-v3.8.52.fallback-chains.reconciliation",
  operations: Object.freeze([FALLBACK_CHAIN_POST, FALLBACK_CHAIN_DELETE]),
  methods: Object.freeze(["POST", "DELETE"] as const),
  pathTemplate: FALLBACK_CHAIN_ROUTE,
});

export function isFallbackChainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function received(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(field: string, message: string): FallbackChainValidationIssue {
  return { field, message };
}

function parseModel(value: unknown, details: FallbackChainValidationIssue[]): string | undefined {
  if (typeof value !== "string") {
    details.push(issue("model", `Expected string, received ${received(value)}`));
    return undefined;
  }
  const model = value.trim();
  if (model.length === 0) {
    details.push(issue("model", "Model is required"));
    return undefined;
  }
  // The pinned Zod schema's max() counts UTF-16 code units (String.length).
  if (model.length > 200) {
    details.push(issue("model", "Model must contain at most 200 characters"));
    return undefined;
  }
  return model;
}

function parseEntry(value: unknown, index: number, details: FallbackChainValidationIssue[]): FallbackChainEntryInput | undefined {
  const prefix = `chain.${index}`;
  if (!isFallbackChainObject(value)) {
    details.push(issue(prefix, `Expected object, received ${received(value)}`));
    return undefined;
  }

  let valid = true;
  let provider: string | undefined;
  if (typeof value.provider !== "string") {
    details.push(issue(`${prefix}.provider`, `Expected string, received ${received(value.provider)}`));
    valid = false;
  } else {
    provider = value.provider.trim();
    if (provider.length === 0) {
      details.push(issue(`${prefix}.provider`, "provider is required"));
      valid = false;
    }
  }

  let priority: number | undefined;
  if (Object.hasOwn(value, "priority")) {
    if (typeof value.priority !== "number" || !Number.isInteger(value.priority)) {
      details.push(issue(`${prefix}.priority`, "priority must be an integer"));
      valid = false;
    } else if (value.priority < 1 || value.priority > 100) {
      details.push(issue(`${prefix}.priority`, "priority must be between 1 and 100"));
      valid = false;
    } else {
      priority = value.priority;
    }
  }

  let enabled: boolean | undefined;
  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") {
      details.push(issue(`${prefix}.enabled`, "enabled must be a boolean"));
      valid = false;
    } else {
      enabled = value.enabled;
    }
  }

  if (!valid || provider === undefined) return undefined;
  return {
    ...value,
    provider,
    ...(priority === undefined ? {} : { priority }),
    ...(enabled === undefined ? {} : { enabled }),
  };
}

/** Validate/parse the request body at the source route boundary; entry catchall fields survive here. */
export function validateFallbackChainRequest(
  operationId: FallbackChainMutationOperation,
  value: unknown,
): FallbackChainValidationResult {
  const details: FallbackChainValidationIssue[] = [];
  if (!isFallbackChainObject(value)) {
    details.push(issue("", `Expected object, received ${received(value)}`));
    return { success: false, error: { message: "Invalid request", details } };
  }

  const model = parseModel(value.model, details);
  if (operationId === FALLBACK_CHAIN_POST) {
    let chain: FallbackChainEntryInput[] | undefined;
    if (!Array.isArray(value.chain)) {
      details.push(issue("chain", `Expected array, received ${received(value.chain)}`));
    } else {
      chain = [];
      for (let index = 0; index < value.chain.length; index += 1) {
        const entry = parseEntry(value.chain[index], index, details);
        if (entry) chain.push(entry);
      }
      if (value.chain.length === 0) details.push(issue("chain", "chain must contain at least one provider"));
    }
    if (details.length > 0 || model === undefined || chain === undefined) {
      return { success: false, error: { message: "Invalid request", details } };
    }
    return { success: true, data: { model, chain } };
  }

  if (details.length > 0 || model === undefined) {
    return { success: false, error: { message: "Invalid request", details } };
  }
  return { success: true, data: { model } };
}

/** Exact fallbackPolicy.registerFallback projection/defaults and stable ascending priority sort. */
export function normalizeFallbackChain(entries: readonly FallbackChainEntryInput[]): FallbackChainEntry[] {
  return entries
    .map(entry => ({
      provider: entry.provider,
      priority: entry.priority ?? 0,
      enabled: entry.enabled ?? true,
    }))
    .sort((left, right) => left.priority - right.priority);
}

/** Normalize only a mutation's source-owned semantic fields for relation matching. */
export function normalizeFallbackChainPayload(
  operationId: FallbackChainMutationOperation,
  payload: ValidatedOperationInput,
): ValidatedOperationInput {
  if (!isFallbackChainObject(payload.body)) throw new TypeError("fallback-chain relation requires a validated request body");
  const validation = validateFallbackChainRequest(operationId, payload.body);
  if (!validation.success) throw new TypeError("fallback-chain relation input does not match the pinned request schema");
  const body: JsonObject = { model: validation.data.model };
  if (operationId === FALLBACK_CHAIN_POST) {
    const chain = validation.data.chain;
    if (!chain) throw new TypeError("fallback-chain registration chain is missing");
    body.chain = normalizeFallbackChain(chain).map(entry => ({
      provider: entry.provider,
      priority: entry.priority,
      enabled: entry.enabled,
    }));
  }
  return { path: payload.path, query: payload.query, body };
}

function cloneJson(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new TypeError("fallback-chain source data exceeds the JSON depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => cloneJson(item, depth + 1));
  if (isFallbackChainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child, depth + 1)]));
  }
  throw new TypeError("fallback-chain source data is not JSON");
}

/**
 * Source relation projection for exact GET /api/fallback/chains snapshots. GET returns
 * an object map, not a list; the mutation's validated body supplies the selected model.
 */
export function fallbackChainTargetSnapshot(
  payload: ValidatedOperationInput,
  response: unknown,
): JsonValue {
  if (!isFallbackChainObject(payload.body) || typeof payload.body.model !== "string" || !isFallbackChainObject(response)) {
    throw new TypeError("fallback-chain target requires a source-shaped request and collection response");
  }
  const model = payload.body.model.trim();
  if (model.length === 0 || model.length > 200) throw new TypeError("fallback-chain target model is invalid");
  // Pinned GET assigns to an ordinary object; this name never becomes an own JSON key.
  if (model === "__proto__") throw new TypeError("fallback-chain target cannot be observed through the source GET");
  const found = Object.hasOwn(response, model);
  const selected = found ? response[model] : undefined;
  if (found && !Array.isArray(selected)) throw new TypeError("fallback-chain target row is not an array");
  const state: JsonObject = found ? { chain: cloneJson(selected) } : {};
  return {
    kind: "resource",
    entries: [{ identity: { model }, state, ...(found ? {} : { absent: true }) }],
  };
}

/** Verify hook IDs are paired only with their pinned exact route/method contracts. */
export function fallbackChainHookMatchesOperation(
  hookId: FallbackChainRequestValidatorId | FallbackChainRelationViewId,
  operation: Pick<OperationDescriptor, "method" | "operationId" | "pathTemplate">,
): boolean {
  const binding = hookId === "omniroute-v3.8.52.fallback-chains.reconciliation"
    ? FALLBACK_CHAIN_RELATION_VIEW_BINDING
    : hookId === "omniroute-v3.8.52.fallback-chains.register"
      ? FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS["omniroute-v3.8.52.fallback-chains.register"]
      : hookId === "omniroute-v3.8.52.fallback-chains.remove"
        ? FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS["omniroute-v3.8.52.fallback-chains.remove"]
        : undefined;
  return binding !== undefined
    && binding.operations.includes(operation.operationId)
    && binding.methods.some(method => operation.method === method)
    && operation.pathTemplate === binding.pathTemplate;
}
