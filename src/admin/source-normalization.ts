/*
 * Source behavior: OmniRoute v3.8.52, commit ad6f33f66bda34eba98645d3bfdabbde294bc843.
 * Handler/schema/storage references and SHA-256:
 * - src/app/api/providers/[id]/interception-rules/route.ts f90e17db56ac7af8dabf94ad854094b58b41a85ab1185aaa6bf809b1a6412dee
 * - src/app/api/providers/[id]/param-filters/route.ts 87f4cf01c5fc5a1aa6fefef2590a5378b4ce9cf47b5f3fe5eddcd9e2ecccb1f0
 * - src/shared/validation/schemas/provider.ts fa0f2b7ef52e46b21fb779b972d27560acd7762978b0f918e6934e4f97f9203c
 * - src/app/api/providers/route.ts f6b09f5aaeeef0e759743e17a05a00f8d774180649db70c91b5da8d4c1c030d3
 * - src/lib/providers/compatibleNodeCreation.ts 3b6a0b0b81ddf2eec0492e1eff89a628df13e2da808c345ec2abdecc2bb0f774
 * - src/lib/db/interceptionRules.ts 91a6a28234502f802daba4d07697df172fc73ff429c09c012c2558eba1b20bae
 * - src/lib/db/paramFilters.ts 6f7c53317cd78fdb8d1220f81d8ab8f1b11f486129ff359a18a8ade36c4352d4
 * - src/app/api/providers/[id]/cc-alias/route.ts af92d3de950a38ad7acc02659eec0303f736cab1f70275ba75f777a3dc5a5cc0
 * - src/lib/db/ccDiscoveryAliases.ts d1c0aeb199f7d20030c31b887c469b85ec6b4ea5960a0c562ecd3bb8c5c5db2c
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

import { isDeepStrictEqual } from "node:util";
import type { AdminMethod, JsonValue } from "./types.ts";
import { normalizeModelCapabilityOverrideRequest } from "./source-model-capability-overrides.ts";
import { FALLBACK_CHAIN_GET, FALLBACK_CHAIN_POST, FALLBACK_CHAIN_DELETE, FALLBACK_CHAIN_RELATION_VIEW_BINDING, fallbackChainTargetSnapshot, normalizeFallbackChainPayload, type FallbackChainRelationViewId } from "./source-fallback-chains.ts";
import type { ValidatedOperationInput } from "./registry.ts";
import {
  comboSourceNormalizationBinding,
  normalizeComboRequest,
  comboSourceRelationViewMatches,
  comboRelationSnapshot,
  comboRelationExpectedPayload,
  isComboNormalizationId,
  isComboRelationViewId,
  type ComboSourceNormalizationId,
  type ComboSourceRelationViewId,
} from "./source-combos.ts";
import {
  isModelComboMappingRelationViewId,
  isModelComboMappingRequestCodecId,
  modelComboMappingCodecBinding,
  modelComboMappingRelationExpectedPayload,
  modelComboMappingRelationSnapshot,
  modelComboMappingRelationViewMatches,
  normalizeModelComboMappingRequest,
  type ModelComboMappingRelationViewId,
  type ModelComboMappingRequestCodecId,
} from "./source-model-combo-mappings.ts";

/** Closed request transforms and state views derived from pinned OmniRoute 3.8.52 handlers. */
export type SourceStateViewId =
  | "omniroute-v3.8.52.provider-interception-rules"
  | "omniroute-v3.8.52.provider-param-filters";
export interface SourceNormalizationBinding {
  readonly pathTemplate: string;
  readonly methods: readonly AdminMethod[];
  readonly section: "body" | "query";
}

export interface SourceStateViewBinding extends SourceNormalizationBinding {
  readonly readMethod: "GET";
}

const SOURCE_STATE_VIEW_BINDINGS: Readonly<Record<SourceStateViewId, SourceStateViewBinding>> = Object.freeze({
  "omniroute-v3.8.52.provider-interception-rules": Object.freeze({
    pathTemplate: "/api/providers/{id}/interception-rules",
    methods: Object.freeze(["PUT"] as const),
    section: "body",
    readMethod: "GET",
  }),
  "omniroute-v3.8.52.provider-param-filters": Object.freeze({
    pathTemplate: "/api/providers/{id}/param-filters",
    methods: Object.freeze(["PUT"] as const),
    section: "body",
    readMethod: "GET",
  }),
});

const SOURCE_NORMALIZATION_BINDINGS = Object.freeze({
  ...SOURCE_STATE_VIEW_BINDINGS,
  "omniroute-v3.8.52.model-capability-overrides.patch": Object.freeze({
    pathTemplate: "/api/model-capability-overrides",
    methods: Object.freeze(["PATCH"] as const),
    section: "body",
  }),
}) satisfies Readonly<Record<string, SourceNormalizationBinding>>;

export type SourceNormalizationId = keyof typeof SOURCE_NORMALIZATION_BINDINGS | ComboSourceNormalizationId | ModelComboMappingRequestCodecId;

/** Return a closed immutable route binding, without echoing unknown input. */
export function sourceNormalizationBinding(id: unknown): SourceNormalizationBinding | undefined {
  const combo = comboSourceNormalizationBinding(id);
  if (combo) return combo;
  const mapping = modelComboMappingCodecBinding(id);
  if (mapping) return mapping;
  if (typeof id !== "string" || !Object.hasOwn(SOURCE_NORMALIZATION_BINDINGS, id)) return undefined;
  return SOURCE_NORMALIZATION_BINDINGS[id as keyof typeof SOURCE_NORMALIZATION_BINDINGS];
}

/** Only the two pinned provider DB readers have context-free state views. */
export function sourceStateViewBinding(id: unknown): SourceStateViewBinding | undefined {
  if (id !== "omniroute-v3.8.52.provider-interception-rules" && id !== "omniroute-v3.8.52.provider-param-filters") return undefined;
  return SOURCE_STATE_VIEW_BINDINGS[id];
}

export type ProviderCcAliasRelationViewId = "omniroute-v3.8.52.provider-cc-alias.selected-override";
export type SourceRelationViewId = FallbackChainRelationViewId | ComboSourceRelationViewId | ModelComboMappingRelationViewId | ProviderCcAliasRelationViewId;

const PROVIDER_CC_ALIAS_GET = "GET /api/providers/{id}/cc-alias";
const PROVIDER_CC_ALIAS_PUT = "PUT /api/providers/{id}/cc-alias";

function aliasRequest(payload: ValidatedOperationInput): {
  readonly providerId: string;
  readonly scope: "provider" | "model";
  readonly modelId: string | null;
  readonly value: "on" | "off" | null;
} {
  const providerId = payload.path.id;
  const body = payload.body;
  if (typeof providerId !== "string" || providerId.length === 0 || !isRecord(body)) {
    throw new TypeError("cc-alias relation requires a provider path and a source-shaped body");
  }
  if (body.scope !== "provider" && body.scope !== "model") {
    throw new TypeError("cc-alias relation scope is invalid");
  }
  const value = body.value;
  if (value !== null && value !== "on" && value !== "off") {
    throw new TypeError("cc-alias relation value is invalid");
  }
  if (body.scope === "provider") {
    return { providerId, scope: "provider", modelId: null, value };
  }
  const modelId = body.modelId;
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 200) {
    throw new TypeError("cc-alias model relation identity is invalid");
  }
  // The pinned GET builds `models` with `{}` and assigns string values. An
  // assignment to this special key is not an own data property, so that GET
  // cannot distinguish an absent override from a stored one. Never infer null.
  if (modelId === "__proto__") throw new TypeError("cc-alias model identity is not observable through the pinned GET");
  return { providerId, scope: "model", modelId, value };
}

function aliasRelationEntry(
  identity: { readonly providerId: string; readonly scope: "provider" | "model"; readonly modelId: string | null },
  value: "on" | "off" | null,
): JsonValue {
  return { kind: "resource", entries: [{ identity, state: { value } }] };
}

function selectedAliasValue(selection: ReturnType<typeof aliasRequest>, response: unknown): "on" | "off" | null {
  if (!isRecord(response)) throw new TypeError("cc-alias GET response is invalid");
  if (selection.scope === "provider") {
    if (!Object.hasOwn(response, "provider")) throw new TypeError("cc-alias GET provider value is missing");
    const value = response.provider;
    if (value !== null && value !== "on" && value !== "off") throw new TypeError("cc-alias GET provider value is invalid");
    return value;
  }
  if (!Object.hasOwn(response, "models") || !isRecord(response.models)) {
    throw new TypeError("cc-alias GET model map is invalid");
  }
  const models = response.models;
  if (!Object.hasOwn(models, selection.modelId!)) return null;
  const value = models[selection.modelId!];
  if (value !== "on" && value !== "off") throw new TypeError("cc-alias GET model value is invalid");
  return value;
}

function selectedAliasEntry(value: JsonValue): {
  readonly identity: Record<string, JsonValue>;
  readonly state: Record<string, JsonValue>;
} {
  if (!isRecord(value) || value.kind !== "resource" || !Array.isArray(value.entries) || value.entries.length !== 1) {
    throw new TypeError("cc-alias selected snapshot is invalid");
  }
  const entry = value.entries[0];
  if (!isRecord(entry) || !isRecord(entry.identity) || !isRecord(entry.state)) {
    throw new TypeError("cc-alias selected snapshot entry is invalid");
  }
  return { identity: entry.identity as Record<string, JsonValue>, state: entry.state as Record<string, JsonValue> };
}

function ccAliasSelectedOverrideSnapshot(payload: ValidatedOperationInput, response: unknown): JsonValue {
  const selection = aliasRequest(payload);
  return aliasRelationEntry(
    { providerId: selection.providerId, scope: selection.scope, modelId: selection.modelId },
    selectedAliasValue(selection, response),
  );
}

function ccAliasExpectedPayload(payload: ValidatedOperationInput, originalSnapshot: JsonValue): ValidatedOperationInput {
  const selection = aliasRequest(payload);
  const entry = selectedAliasEntry(originalSnapshot);
  if (entry.identity.providerId !== selection.providerId
    || entry.identity.scope !== selection.scope
    || entry.identity.modelId !== selection.modelId
    || !Object.hasOwn(entry.state, "value")
    || (entry.state.value !== null && entry.state.value !== "on" && entry.state.value !== "off")) {
    throw new TypeError("cc-alias original snapshot does not bind the selected override");
  }
  return payload;
}

/** Keep contextual map selection separate from context-free field state views. */
export function sourceRelationViewMatches(
  id: unknown,
  operationId: string,
  targetReadId: unknown,
  reconciliationId: unknown,
  outcomeKind: unknown,
): boolean {
  if (isComboRelationViewId(id)) {
    return comboSourceRelationViewMatches(id, operationId, targetReadId, reconciliationId, outcomeKind);
  }
  if (isModelComboMappingRelationViewId(id)) {
    return modelComboMappingRelationViewMatches(id, operationId, targetReadId, reconciliationId, outcomeKind);
  }
  if (id === "omniroute-v3.8.52.provider-cc-alias.selected-override") {
    return operationId === PROVIDER_CC_ALIAS_PUT
      && targetReadId === PROVIDER_CC_ALIAS_GET
      && reconciliationId === PROVIDER_CC_ALIAS_GET
      && outcomeKind === "matches";
  }
  if (id !== FALLBACK_CHAIN_RELATION_VIEW_BINDING.id) return false;
  const expectedKind = operationId === FALLBACK_CHAIN_POST ? "upsert" : operationId === FALLBACK_CHAIN_DELETE ? "absent" : undefined;
  return expectedKind !== undefined && outcomeKind === expectedKind
    && targetReadId === FALLBACK_CHAIN_GET && reconciliationId === FALLBACK_CHAIN_GET;
}

export function sourceRelationSnapshot(id: SourceRelationViewId, payload: ValidatedOperationInput, response: unknown): JsonValue {
  if (isComboRelationViewId(id)) return comboRelationSnapshot(id, payload, response);
  if (isModelComboMappingRelationViewId(id)) return modelComboMappingRelationSnapshot(id, payload, response);
  switch (id) {
    case "omniroute-v3.8.52.provider-cc-alias.selected-override":
      return ccAliasSelectedOverrideSnapshot(payload, response);
    case "omniroute-v3.8.52.fallback-chains.reconciliation":
      return fallbackChainTargetSnapshot(payload, response);
    default:
      return assertNever(id);
  }
}

/** Called only for an explicitly declared expected postcondition, not deletion. */
export function sourceRelationExpectedPayload(
  id: SourceRelationViewId,
  payload: ValidatedOperationInput,
  originalSnapshot: JsonValue,
): ValidatedOperationInput {
  if (isComboRelationViewId(id)) return comboRelationExpectedPayload(id, payload, originalSnapshot);
  if (isModelComboMappingRelationViewId(id)) return modelComboMappingRelationExpectedPayload(id, payload, originalSnapshot);
  switch (id) {
    case "omniroute-v3.8.52.provider-cc-alias.selected-override":
      return ccAliasExpectedPayload(payload, originalSnapshot);
    case "omniroute-v3.8.52.fallback-chains.reconciliation":
      return normalizeFallbackChainPayload(FALLBACK_CHAIN_POST, payload);
    default:
      return assertNever(id);
  }
}


type JsonRecord = { [key: string]: JsonValue };

const FETCH_BACKENDS = new Set(["firecrawl", "jina", "tavily"]);

type ProviderNodeData = Record<string, unknown>;

function providerNodeIdentityValue(key: string, value: unknown): unknown {
  if (key !== "baseUrl" || typeof value !== "string") return value;
  const trimmed = value.trim();
  const separator = trimmed.search(/[?#]/);
  const pathname = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const suffix = separator < 0 ? "" : trimmed.slice(separator);
  return pathname.replace(/\/+$/, "") + suffix;
}

/** Apply the compatible-node hydration performed by the provider-create handler. */
export function hydrateSourceCompatibleProviderCreation(
  provider: string,
  node: ProviderNodeData,
  incoming: ProviderNodeData | null,
  includeApiType: boolean,
): { readonly data: ProviderNodeData; readonly error: string | null } {
  const nodeFields: ProviderNodeData = {
    prefix: node.prefix,
    ...(includeApiType ? { apiType: node.apiType } : {}),
    baseUrl: node.baseUrl,
    nodeName: node.name,
    ...(node.chatPath ? { chatPath: node.chatPath } : {}),
    ...(node.modelsPath ? { modelsPath: node.modelsPath } : {}),
    ...(node.customHeaders ? { customHeaders: node.customHeaders } : {}),
  };
  const supplied = incoming ?? {};
  const conflict = provider === node.id
    ? undefined
    : Object.keys(nodeFields).find(key => Object.hasOwn(supplied, key)
      && !isDeepStrictEqual(providerNodeIdentityValue(key, supplied[key]), providerNodeIdentityValue(key, nodeFields[key])));

  return {
    data: { ...supplied, ...nodeFields },
    error: conflict
      ? `providerSpecificData.${conflict} conflicts with the resolved provider node. Use its concrete node id or matching node settings.`
      : null,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function copyRecord(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(value));
}

function trimValue(value: JsonValue | undefined): JsonValue | undefined {
  return typeof value === "string" ? value.trim() : value;
}

function trimArray(value: JsonValue | undefined): JsonValue | undefined {
  return Array.isArray(value) ? value.map(item => typeof item === "string" ? item.trim() : item) : value;
}

function normalizedModelMap(
  value: JsonValue | undefined,
  normalizeRule: (rule: JsonValue) => JsonValue,
  validateRule: (rule: JsonValue) => void,
): JsonValue | undefined {
  if (!isRecord(value)) return value;
  const entries = new Map<string, JsonValue>();
  for (const [sourceKey, sourceRule] of Object.entries(value)) {
    const key = sourceKey.trim();
    // Zod's z.string().trim().min(1).max(200) checks the UTF-16 string length.
    if (key.length < 1 || key.length > 200) {
      throw new Error("source model-map key must contain 1 to 200 characters");
    }
    const rule = normalizeRule(sourceRule);
    if (entries.has(key)) {
      // Zod parses each record value before its output object applies last-write-wins.
      // Validate both colliding values so an invalid earlier value cannot disappear.
      validateRule(entries.get(key)!);
      validateRule(rule);
    }
    // Map.set replaces the value without changing the first key's source order.
    entries.set(key, rule);
  }
  return Object.fromEntries(entries);
}

function assertObject(value: JsonValue): JsonRecord {
  if (!isRecord(value)) throw new Error("source model rule must be an object");
  return value;
}

function assertBooleanWhenPresent(value: JsonRecord, field: string): void {
  if (Object.hasOwn(value, field) && typeof value[field] !== "boolean") {
    throw new Error("source model rule has an invalid field type");
  }
}

function assertArrayWhenPresent(value: JsonRecord, field: string): void {
  if (!Object.hasOwn(value, field)) return;
  const items = value[field];
  if (!Array.isArray(items) || items.length > 500 || items.some(item =>
    typeof item !== "string" || item.trim().length < 1 || item.trim().length > 200)) {
    throw new Error("source parameter filter list is invalid");
  }
}

function assertInterceptionCollisionRule(rule: JsonValue): void {
  const value = assertObject(rule);
  assertBooleanWhenPresent(value, "interceptSearch");
  assertBooleanWhenPresent(value, "interceptFetch");
  if (Object.hasOwn(value, "fetchBackend") && (typeof value.fetchBackend !== "string" || !FETCH_BACKENDS.has(value.fetchBackend))) {
    throw new Error("source model rule has an invalid field value");
  }
  if (Object.hasOwn(value, "fetchProxyUrl")) {
    const url = value.fetchProxyUrl;
    if (typeof url !== "string" || url.length > 2000) throw new Error("source model rule has an invalid field value");
    try { new URL(url); } catch { throw new Error("source model rule has an invalid field value"); }
  }
}

function assertParamFilterCollisionRule(rule: JsonValue): void {
  const value = assertObject(rule);
  assertArrayWhenPresent(value, "block");
  assertArrayWhenPresent(value, "allow");
}

function normalizeInterceptionRule(value: JsonValue): JsonValue {
  if (!isRecord(value)) return value;
  const rule = copyRecord(value);
  if (Object.hasOwn(rule, "fetchProxyUrl")) rule.fetchProxyUrl = trimValue(rule.fetchProxyUrl)!;
  return rule;
}

function normalizeParamFilterRule(value: JsonValue): JsonValue {
  if (!isRecord(value)) return value;
  const rule = copyRecord(value);
  if (Object.hasOwn(rule, "block")) rule.block = trimArray(rule.block)!;
  if (Object.hasOwn(rule, "allow")) rule.allow = trimArray(rule.allow)!;
  return rule;
}

/** Apply only the request transforms performed by the pinned route's Zod schemas. */
export function normalizeSourceRequest(id: SourceNormalizationId, value: JsonValue): JsonValue {
  if (isComboNormalizationId(id)) return normalizeComboRequest(id, value);
  if (isModelComboMappingRequestCodecId(id)) return normalizeModelComboMappingRequest(id, value);
  if (id === "omniroute-v3.8.52.model-capability-overrides.patch") {
    const result = normalizeModelCapabilityOverrideRequest(value);
    if (!result.ok) throw new Error("source model-capability override request is invalid");
    return result.data;
  }
  if (id !== "omniroute-v3.8.52.provider-interception-rules" && id !== "omniroute-v3.8.52.provider-param-filters") {
    return assertNever(id);
  }
  if (!isRecord(value)) return value;
  const body = copyRecord(value);
  switch (id) {
    case "omniroute-v3.8.52.provider-interception-rules":
      if (Object.hasOwn(body, "fetchProxyUrl")) body.fetchProxyUrl = trimValue(body.fetchProxyUrl)!;
      if (Object.hasOwn(body, "models")) {
        body.models = normalizedModelMap(body.models, normalizeInterceptionRule, assertInterceptionCollisionRule)!;
      }
      return body;
    case "omniroute-v3.8.52.provider-param-filters":
      if (Object.hasOwn(body, "block")) body.block = trimArray(body.block)!;
      if (Object.hasOwn(body, "allow")) body.allow = trimArray(body.allow)!;
      if (Object.hasOwn(body, "models")) {
        body.models = normalizedModelMap(body.models, normalizeParamFilterRule, assertParamFilterCollisionRule)!;
      }
      return body;
    default:
      return assertNever(id);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported source normalization: ${String(value)}`);
}

function optionalBoolean(source: JsonRecord, target: JsonRecord, field: string): void {
  if (!Object.hasOwn(source, field)) return;
  const value = source[field];
  if (typeof value !== "boolean") throw new Error("source configuration state has an invalid boolean");
  target[field] = value;
}

function optionalBackend(source: JsonRecord, target: JsonRecord): void {
  if (!Object.hasOwn(source, "fetchBackend")) return;
  const value = source.fetchBackend;
  if (typeof value !== "string" || !FETCH_BACKENDS.has(value)) throw new Error("source configuration state has an invalid backend");
  target.fetchBackend = value;
}

function optionalUrl(source: JsonRecord, target: JsonRecord): void {
  if (!Object.hasOwn(source, "fetchProxyUrl")) return;
  const value = source.fetchProxyUrl;
  if (typeof value !== "string") throw new Error("source configuration state has an invalid URL");
  const trimmed = value.trim();
  if (trimmed.length > 0) target.fetchProxyUrl = trimmed;
}

function interceptionState(value: JsonValue): JsonValue {
  if (!isRecord(value)) throw new Error("source interception state must be an object");
  const state: JsonRecord = {};
  optionalBoolean(value, state, "interceptSearch");
  optionalBoolean(value, state, "interceptFetch");
  optionalBackend(value, state);
  optionalUrl(value, state);
  if (Object.hasOwn(value, "models")) {
    const modelsValue = value.models;
    if (!isRecord(modelsValue)) throw new Error("source interception models must be an object");
    const modelEntries: [string, JsonValue][] = [];
    for (const [modelId, ruleValue] of Object.entries(modelsValue)) {
      // The pinned DB reader assigns model entries into a plain object, so a
      // "__proto__" key changes its prototype and is not observable in the GET result.
      if (modelId === "__proto__") continue;
      const rule = assertObject(ruleValue);
      const projected: JsonRecord = {};
      optionalBoolean(rule, projected, "interceptSearch");
      optionalBoolean(rule, projected, "interceptFetch");
      optionalBackend(rule, projected);
      optionalUrl(rule, projected);
      if (Object.keys(projected).length > 0) modelEntries.push([modelId, projected]);
    }
    if (modelEntries.length > 0) state.models = Object.fromEntries(modelEntries);
  }
  return state;
}

function stringArray(value: JsonValue, field: string): JsonValue[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`source configuration state has an invalid ${field} list`);
  }
  return [...value];
}

function paramRuleState(value: JsonValue): JsonValue | undefined {
  const source = assertObject(value);
  const result: JsonRecord = {};
  if (Object.hasOwn(source, "block")) {
    const block = stringArray(source.block!, "block");
    if (block.length > 0) result.block = block;
  }
  if (Object.hasOwn(source, "allow")) {
    const allow = stringArray(source.allow!, "allow");
    if (allow.length > 0) result.allow = allow;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function paramFiltersState(value: JsonValue): JsonValue {
  if (!isRecord(value)) throw new Error("source parameter-filter state must be an object");
  const block = Object.hasOwn(value, "block") ? stringArray(value.block!, "block") : [];
  const allow = Object.hasOwn(value, "allow") ? stringArray(value.allow!, "allow") : [];
  const autoLearn = Object.hasOwn(value, "autoLearn") ? value.autoLearn : false;
  if (typeof autoLearn !== "boolean") throw new Error("source parameter-filter state has an invalid autoLearn flag");

  const state: JsonRecord = { block, allow, autoLearn };
  if (Object.hasOwn(value, "models")) {
    if (!isRecord(value.models)) throw new Error("source parameter-filter models must be an object");
    const modelEntries: [string, JsonValue][] = [];
    for (const [modelId, rule] of Object.entries(value.models)) {
      // Match the pinned DB reader's plain-object assignment behavior.
      if (modelId === "__proto__") continue;
      const projected = paramRuleState(rule);
      if (projected !== undefined) modelEntries.push([modelId, projected]);
    }
    if (modelEntries.length > 0) state.models = Object.fromEntries(modelEntries);
  }
  return state;
}

/** Canonicalize a GET response or expected PUT body to the pinned DB reader's observable state. */
export function sourceStateView(id: unknown, value: JsonValue): JsonValue {
  switch (id) {
    case "omniroute-v3.8.52.provider-interception-rules":
      return interceptionState(value);
    case "omniroute-v3.8.52.provider-param-filters":
      return paramFiltersState(value);
    default:
      throw new Error("unsupported source normalization");
  }
}
