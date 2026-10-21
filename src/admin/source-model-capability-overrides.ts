/*
 * Source behavior: OmniRoute v3.8.52, commit ad6f33f66bda34eba98645d3bfdabbde294bc843.
 * Pinned upstream files and SHA-256:
 * - src/app/api/model-capability-overrides/route.ts f81174fcde828e968d18f7f90402cef9959f7f0619d96fa6fd44d21db9095b9b
 * - src/lib/providerNodePrefixes.ts 1382fc6d2e116960e78dbd18ec178d995ee9220160157520bcd42fa7d4a82402
 * - src/lib/db/providers/nodes.ts 45cb5046754d4f7213be9988f51f32ba49b95a0ce081fb660549796654040832
 * - src/lib/db/modelCapabilityOverrides.ts 8d51b3d4da287d7dbfaef09427580ff4794483c8317d965a00eaed50cb25cf01
 * - src/lib/db/modelContextOverrides.ts 2cfe58e67905a8fcebea17f132f3857e17dd9e297d8808fbfbf3164201834418
 * - src/shared/reasoning/reasoningEffortsOverride.ts ce4c6041f6cf4f908ca6a2e301e74e5f9f60dbea02b3b411a233438ff1fc25a6
 * - src/lib/api/requireManagementAuth.ts c34dd2bd6ce9a556c043912f817d52966050118272ee742c83247b7031f28a29
 * - src/lib/api/errorResponse.ts 6015b2648eacc5e05e9f3bf03995c24c5a25ec36fbd55d9cdbc377f4fde3e0c7
 * - open-sse/services/model.ts 63d8bab2ce6c2f8fdc4d6264f8edf258cfb37d35786a2cf2085c8ff53aceb9ff
 * - open-sse/services/providerAlias.ts 82295560ca6fb2ccc2ef59691c2c957bbc9d5531d9a62287516f3ce5e80ff18f
 * - open-sse/config/providerModels.ts a991cf83a119be3fed181f0f77e85050a104d4612c44a674d49a3d4f17f95366
 * - src/shared/constants/reservedProviderPrefixes.ts b5416be8e44699018513229a4b9d5534b5c7a196f71c54c220f1884a13beda95
 * - src/server/authz/policies/management.ts c60581deaedf0a7dd814a55685238dcf63017121d0ebf73ae4d87aaa982ec1f9
 * - src/server/authz/routeGuard.ts f1fdcf54f0e77d1bfcbebc075d4d8baeff9f1bdb923a164dff9a36d1b7649d64
 * - src/shared/utils/apiAuth.ts 15270816325cd0b39494b376b884b7b4fccd19765b1e923305734f96d2cb1020
 * - src/lib/api/internalServiceAuth.ts 3701d7e5c1503e14902f8016556aef5ade85b34f81eb137d73d4694bec42927d
 * - src/lib/middleware/cliTokenAuth.ts d0e15851807a8534b3d400dd1c9a787e139acb3bad070cf8cf029f210a89f7ec
 * - src/server/authz/accessTokenAuth.ts 1844c6831e9cf872f700888601825517136e9096b9c933cbad6034c8e2145ac9
 * - src/server/authz/headers.ts c9b13e9ac3acc4e94d5047c64da675a59dc9d6f688efbf08f26e7d53261791e4
 * - src/shared/constants/managementScopes.ts 3d9ffd8a5439ad54f6fffc6ee7c39be7e1be080f0d605d7b193b06e6a1523e67
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

export const MODEL_CAPABILITY_OVERRIDE_PATCH_NORMALIZER =
  "omniroute-v3.8.52.model-capability-overrides.patch" as const;
export const MODEL_CAPABILITY_OVERRIDE_PATCH_BINDING = Object.freeze({
  operationId: "PATCH /api/model-capability-overrides",
  method: "PATCH",
  pathTemplate: "/api/model-capability-overrides",
});

export const MODEL_CAPABILITY_OVERRIDE_KEYS = [
  "context_length",
  "max_input_tokens",
  "max_output_tokens",
  "reasoning_efforts",
] as const;
export type ModelCapabilityOverrideKey = (typeof MODEL_CAPABILITY_OVERRIDE_KEYS)[number];
export type ReasoningEffortOverrideValue =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type ModelCapabilityOverridePatch =
  | { readonly target: string; readonly key: "context_length" | "max_input_tokens" | "max_output_tokens"; readonly value: number }
  | { readonly target: string; readonly key: "reasoning_efforts"; readonly value: readonly ReasoningEffortOverrideValue[] };

export interface ModelCapabilityOverrideIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type ModelCapabilityOverridePatchResult =
  | { readonly ok: true; readonly data: ModelCapabilityOverridePatch }
  | { readonly ok: false; readonly issues: readonly ModelCapabilityOverrideIssue[] };
export type ModelCapabilityOverrideRequestBody =
  | { readonly target: string; readonly key: "context_length" | "max_input_tokens" | "max_output_tokens"; readonly value: number }
  | { readonly target: string; readonly key: "reasoning_efforts"; readonly value: string };
export type ModelCapabilityOverrideRequestResult =
  | { readonly ok: true; readonly data: ModelCapabilityOverrideRequestBody }
  | { readonly ok: false; readonly issues: readonly ModelCapabilityOverrideIssue[] };

const REASONING_EFFORTS: readonly ReasoningEffortOverrideValue[] = [
  "none", "low", "medium", "high", "xhigh", "max", "ultra",
];
const EDGE_INVISIBLE_PATTERN = /^[\p{White_Space}\p{Separator}\p{Control}\p{Format}]+|[\p{White_Space}\p{Separator}\p{Control}\p{Format}]+$/gu;
const NON_ASCII_COMMA_PATTERN = /[،、︐︑﹐﹑，､]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code: string, path: readonly (string | number)[], message: string): ModelCapabilityOverrideIssue {
  return { code, path, message };
}

function parseReasoningEfforts(value: unknown):
  | { readonly ok: true; readonly efforts: ReasoningEffortOverrideValue[] }
  | { readonly ok: false; readonly error: string } {
  if (typeof value !== "string") return { ok: false, error: "reasoning_efforts must be a string" };
  if (NON_ASCII_COMMA_PATTERN.test(value)) return { ok: false, error: "reasoning_efforts must use English commas" };

  const efforts: ReasoningEffortOverrideValue[] = [];
  const seen = new Set<string>();
  for (const segment of value.split(",")) {
    const effort = segment.replace(EDGE_INVISIBLE_PATTERN, "").toLowerCase();
    if (!effort) return { ok: false, error: "reasoning_efforts contains an empty item" };
    if (!REASONING_EFFORTS.includes(effort as ReasoningEffortOverrideValue)) {
      return { ok: false, error: `Unsupported reasoning effort: ${effort}` };
    }
    if (seen.has(effort)) return { ok: false, error: `Duplicate reasoning effort: ${effort}` };
    seen.add(effort);
    efforts.push(effort as ReasoningEffortOverrideValue);
  }
  return { ok: true, efforts };
}

function normalizeNumericValue(value: unknown): number | ModelCapabilityOverrideIssue {
  let numberValue: number;
  try {
    // This intentionally follows z.coerce.number(): JSON strings, booleans, null,
    // and arrays are passed through JavaScript Number before integer/positive checks.
    numberValue = Number(value);
  } catch {
    return issue("invalid_type", ["value"], "Expected a positive integer");
  }
  if (!Number.isFinite(numberValue)) return issue("invalid_type", ["value"], "Expected a finite number");
  if (!Number.isInteger(numberValue)) return issue("invalid_type", ["value"], "Expected an integer");
  if (numberValue <= 0) return issue("too_small", ["value"], "Number must be greater than 0");
  return numberValue;
}

/**
 * Parse the server's Zod PATCH transformation into the values consumed by storage.
 * In particular reasoning efforts become an ordered list internally.
 */
export function normalizeModelCapabilityOverridePatch(value: unknown): ModelCapabilityOverridePatchResult {
  if (!isRecord(value)) {
    return { ok: false, issues: [issue("invalid_type", [], "Expected an object") ] };
  }

  const issues: ModelCapabilityOverrideIssue[] = [];
  const target = value.target;
  if (typeof target !== "string") {
    issues.push(issue("invalid_type", ["target"], "Expected a string"));
  } else if (target.length < 3) {
    issues.push(issue("too_small", ["target"], "String must contain at least 3 character(s)"));
  }

  const key = value.key;
  if (typeof key !== "string" || !(MODEL_CAPABILITY_OVERRIDE_KEYS as readonly string[]).includes(key)) {
    issues.push(issue("invalid_enum_value", ["key"], "Invalid model capability override key"));
  }

  if (issues.length > 0 || typeof target !== "string" || typeof key !== "string") {
    return { ok: false, issues };
  }

  if (key === "reasoning_efforts") {
    const parsed = parseReasoningEfforts(value.value);
    if (!parsed.ok) {
      return { ok: false, issues: [issue("custom", ["value"], parsed.error)] };
    }
    return {
      ok: true,
      data: { target, key, value: parsed.efforts },
    };
  }

  if (key === "context_length" || key === "max_input_tokens" || key === "max_output_tokens") {
    const normalized = normalizeNumericValue(value.value);
    if (typeof normalized !== "number") return { ok: false, issues: [normalized] };
    return { ok: true, data: { target, key, value: normalized } };
  }

  return { ok: false, issues: [issue("invalid_enum_value", ["key"], "Invalid model capability override key")] };
}
/** Normalize a PATCH wire body while preserving the server-required string encoding. */
export function normalizeModelCapabilityOverrideRequest(value: unknown): ModelCapabilityOverrideRequestResult {
  const parsed = normalizeModelCapabilityOverridePatch(value);
  if (!parsed.ok) return parsed;
  if (parsed.data.key === "reasoning_efforts") {
    return {
      ok: true,
      data: {
        target: parsed.data.target,
        key: parsed.data.key,
        value: parsed.data.value.join(","),
      },
    };
  }
  return { ok: true, data: parsed.data };
}

export interface CompatibleProviderNode {
  readonly id?: string;
  readonly type?: string;
  readonly prefix?: string | null;
}

export type ProviderPrefixStatus = "unique" | "ambiguous" | "reserved";
export interface ProviderPrefixEntry {
  readonly prefix: string;
  readonly status: ProviderPrefixStatus;
  readonly nodeId?: string;
}
export interface ModelCapabilityPrefixIndex {
  readonly entries: ReadonlyMap<string, ProviderPrefixEntry>;
  readonly nodeToPrefix: ReadonlyMap<string, string>;
  readonly prefixToNode: ReadonlyMap<string, string>;
  readonly eligibleNodeIds: ReadonlySet<string>;
  readonly compatibleNodeIds: ReadonlySet<string>;
}

/** Build the same prefix winner maps from getProviderNodes()'s id-ascending rows. */
export function buildModelCapabilityPrefixIndex(
  nodes: readonly CompatibleProviderNode[],
  reservedPrefixes: ReadonlySet<string>,
): ModelCapabilityPrefixIndex {
  const compatible = nodes.filter(node => node.type === "openai-compatible" || node.type === "anthropic-compatible");
  const compatibleNodeIds = new Set<string>();
  const byPrefix = new Map<string, CompatibleProviderNode[]>();
  for (const node of compatible) {
    if (node.id) compatibleNodeIds.add(node.id);
    const prefix = node.prefix?.trim();
    if (!node.id || !prefix) continue;
    const entries = byPrefix.get(prefix) ?? [];
    entries.push(node);
    byPrefix.set(prefix, entries);
  }

  const entries = new Map<string, ProviderPrefixEntry>();
  const nodeToPrefix = new Map<string, string>();
  const prefixToNode = new Map<string, string>();
  const eligibleNodeIds = new Set<string>();
  for (const [prefix, prefixNodes] of byPrefix) {
    if (reservedPrefixes.has(prefix)) {
      entries.set(prefix, { prefix, status: "reserved" });
      continue;
    }
    const winner = prefixNodes.find(node => node.type === "openai-compatible" && node.prefix === prefix)
      ?? prefixNodes.find(node => node.type === "anthropic-compatible" && node.prefix === prefix);
    if (!winner?.id) {
      entries.set(prefix, { prefix, status: "ambiguous" });
      continue;
    }
    entries.set(prefix, { prefix, status: "unique", nodeId: winner.id });
    nodeToPrefix.set(winner.id, prefix);
    prefixToNode.set(prefix, winner.id);
    eligibleNodeIds.add(winner.id);
  }
  return { entries, nodeToPrefix, prefixToNode, eligibleNodeIds, compatibleNodeIds };
}

export type CanonicalModelOverrideTarget =
  | { readonly ok: true; readonly target: string }
  | { readonly ok: false };

/** Source-faithful public-prefix, reserved-alias, and raw-node-ID target resolver. */
export function canonicalizeModelCapabilityOverrideTarget(
  target: string,
  index: ModelCapabilityPrefixIndex,
  resolveProviderAlias: (provider: string) => string | null,
): CanonicalModelOverrideTarget {
  const raw = target.trim();
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) return { ok: false };
  const provider = raw.slice(0, slashIndex).trim();
  const modelId = raw.slice(slashIndex + 1).trim();
  if (!provider || !modelId || index.compatibleNodeIds.has(provider)) return { ok: false };

  const configured = index.entries.get(provider);
  if (configured?.status === "ambiguous") return { ok: false };
  const nodeId = index.prefixToNode.get(provider);
  if (nodeId && !index.eligibleNodeIds.has(nodeId)) return { ok: false };
  const canonicalProvider = nodeId ?? resolveProviderAlias(provider) ?? provider;
  return { ok: true, target: `${canonicalProvider}/${modelId}` };
}

/** Public list projection used by the route after reading its separate DB tables. */
export function projectModelCapabilityOverrideList<T extends {
  readonly provider: string;
  readonly modelId: string;
  readonly key: string;
  readonly value: number | readonly string[];
  readonly refreshedAt: string;
}>(
  overrides: readonly T[],
  index: ModelCapabilityPrefixIndex,
): Array<T & { readonly provider: string; readonly target: string }> {
  return overrides
    .filter(override => !index.compatibleNodeIds.has(override.provider) || index.eligibleNodeIds.has(override.provider))
    .map(override => {
      const provider = index.nodeToPrefix.get(override.provider) ?? override.provider;
      return { ...override, provider, target: `${provider}/${override.modelId}` };
    })
    .sort((left, right) => right.refreshedAt.localeCompare(left.refreshedAt));
}

/** Small explicit boundary for the upstream's unreachable malformed-index branch. */
export function withAmbiguousModelCapabilityPrefix(
  index: ModelCapabilityPrefixIndex,
  prefix: string,
): ModelCapabilityPrefixIndex {
  const entries = new Map(index.entries);
  entries.set(prefix, { prefix, status: "ambiguous" });
  return { ...index, entries };
}
