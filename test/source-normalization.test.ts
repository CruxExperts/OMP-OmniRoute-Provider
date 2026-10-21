import { describe, expect, test } from "bun:test";
import { hydrateSourceCompatibleProviderCreation, normalizeSourceRequest, sourceStateView, type SourceNormalizationId } from "../src/admin/source-normalization.ts";
import type { JsonValue } from "../src/admin/types.ts";

const INTERCEPTION: SourceNormalizationId = "omniroute-v3.8.52.provider-interception-rules";
const PARAM_FILTERS: SourceNormalizationId = "omniroute-v3.8.52.provider-param-filters";

function record(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value;
}

describe("pinned provider configuration normalization", () => {
  test("compatible-node creation rejects conflicting hydrated identity and preserves canonical node fields", () => {
    const node = {
      id: "openai-compatible-canonical",
      prefix: "fixture-prefix",
      apiType: "openai",
      baseUrl: "https://compatible.example/v1/",
      name: "Canonical fixture node",
      chatPath: "/chat/completions",
      modelsPath: "/models",
      customHeaders: { "x-fixture": "bound" },
    };
    const conflict = hydrateSourceCompatibleProviderCreation(
      "openai-compatible-alias",
      node,
      { prefix: "other-prefix" },
      true,
    );
    expect(conflict.error).toContain("providerSpecificData.prefix");
    expect(conflict.data.prefix).toBe("fixture-prefix");

    const hydrated = hydrateSourceCompatibleProviderCreation(
      "openai-compatible-alias",
      node,
      { baseUrl: " https://compatible.example/v1/// ", custom: "preserved" },
      true,
    );
    expect(hydrated.error).toBe(null);
    expect(hydrated.data).toEqual({
      baseUrl: "https://compatible.example/v1/",
      custom: "preserved",
      prefix: "fixture-prefix",
      apiType: "openai",
      nodeName: "Canonical fixture node",
      chatPath: "/chat/completions",
      modelsPath: "/models",
      customHeaders: { "x-fixture": "bound" },
    });

    const concrete = hydrateSourceCompatibleProviderCreation(
      "openai-compatible-canonical",
      node,
      { prefix: "operator-value" },
      true,
    );
    expect(concrete.error).toBe(null);
    expect(concrete.data.prefix).toBe("fixture-prefix");
  });

  test("interception requests trim root/nested URLs and model keys with last-write collision order", () => {
    const input = {
      interceptSearch: true,
      fetchProxyUrl: " https://proxy.example/root ",
      models: {
        " model/one ": { interceptFetch: true, fetchProxyUrl: " https://proxy.example/first " },
        "model/one": { interceptSearch: false },
        " model/two ": { fetchBackend: "jina", fetchProxyUrl: " https://proxy.example/second " },
      },
    } satisfies JsonValue;
    const result = record(normalizeSourceRequest(INTERCEPTION, input));
    expect(result.fetchProxyUrl).toBe("https://proxy.example/root");
    expect(Object.keys(record(result.models!))).toEqual(["model/one", "model/two"]);
    expect(record(result.models!)["model/one"]).toEqual({ interceptSearch: false });
    expect(record(result.models!)["model/two"]).toEqual({ fetchBackend: "jina", fetchProxyUrl: "https://proxy.example/second" });
    expect(record(input.models[" model/one "] as JsonValue).fetchProxyUrl).toBe(" https://proxy.example/first ");
  });

  test("prototype-like model keys survive request normalization but are absent from source GET state", () => {
    const interceptionModels = Object.fromEntries([["__proto__", { interceptFetch: true }]]);
    const normalized = normalizeSourceRequest(INTERCEPTION, { models: interceptionModels });
    expect(Object.hasOwn(record(record(normalized).models!), "__proto__")).toBe(true);
    expect(sourceStateView(INTERCEPTION, { models: interceptionModels })).toEqual({});

    const paramModels = Object.fromEntries([["__proto__", { block: ["temperature"] }]]);
    expect(sourceStateView(PARAM_FILTERS, { models: paramModels })).toEqual({
      block: [],
      allow: [],
      autoLearn: false,
    });
  });

  test("interception collision does not erase validation failure from an earlier source key", () => {
    expect(() => normalizeSourceRequest(INTERCEPTION, {
      models: {
        model: { interceptFetch: "invalid" },
        " model ": { interceptSearch: true },
      },
    })).toThrow("source model rule has an invalid field type");
  });

  test("parameter filter requests trim all entries and keys while preserving duplicates and order", () => {
    const input = {
      block: [" temperature ", "top_p", "temperature"],
      allow: [" stop ", "stop"],
      models: {
        " model/one ": { block: [" max_tokens ", "top_p"] },
        "model/one": { allow: [" stop "] },
      },
    } satisfies JsonValue;
    const result = record(normalizeSourceRequest(PARAM_FILTERS, input));
    expect(result.block).toEqual(["temperature", "top_p", "temperature"]);
    expect(result.allow).toEqual(["stop", "stop"]);
    expect(Object.keys(record(result.models!))).toEqual(["model/one"]);
    expect(record(result.models!)["model/one"]).toEqual({ allow: ["stop"] });
  });

  test("parameter collision preserves validation failures from overwritten source values", () => {
    expect(() => normalizeSourceRequest(PARAM_FILTERS, {
      models: {
        model: { block: ["  "] },
        " model ": { allow: ["stop"] },
      },
    })).toThrow("source parameter filter list is invalid");
  });

  test("record keys use source-trimmed UTF-16 bounds", () => {
    const accepted = normalizeSourceRequest(INTERCEPTION, {
      models: { [" x "]: {}, ["a".repeat(200)]: {} },
    });
    expect(Object.keys(record(record(accepted).models!))).toEqual(["x", "a".repeat(200)]);
    expect(() => normalizeSourceRequest(INTERCEPTION, { models: { "   ": {} } })).toThrow("1 to 200");
    expect(() => normalizeSourceRequest(PARAM_FILTERS, { models: { ["a".repeat(201)]: {} } })).toThrow("1 to 200");
    expect(() => normalizeSourceRequest(INTERCEPTION, { models: { ["😀".repeat(101)]: {} } })).toThrow("1 to 200");
  });

  test("state views reproduce source GET defaults and omit empty per-model rules", () => {
    expect(sourceStateView(INTERCEPTION, {})).toEqual({});
    expect(sourceStateView(PARAM_FILTERS, {})).toEqual({ block: [], allow: [], autoLearn: false });
    expect(sourceStateView(INTERCEPTION, {
      models: { empty: {}, configured: { interceptFetch: false } },
    })).toEqual({ models: { configured: { interceptFetch: false } } });
    expect(sourceStateView(PARAM_FILTERS, {
      block: ["  persisted-spacing  "],
      models: { empty: { block: [], allow: [] }, configured: { allow: ["stop"] } },
    })).toEqual({
      block: ["  persisted-spacing  "],
      allow: [],
      autoLearn: false,
      models: { configured: { allow: ["stop"] } },
    });
    expect(sourceStateView(INTERCEPTION, {
      fetchProxyUrl: " https://proxy.example/persisted ",
      models: { model: { fetchProxyUrl: " https://proxy.example/model " } },
    })).toEqual({
      fetchProxyUrl: "https://proxy.example/persisted",
      models: { model: { fetchProxyUrl: "https://proxy.example/model" } },
    });
  });


  test("state views reject malformed known source fields rather than hiding them", () => {
    expect(() => sourceStateView(INTERCEPTION, { interceptSearch: "yes" })).toThrow("invalid boolean");
    expect(() => sourceStateView(PARAM_FILTERS, { block: ["valid", 1] })).toThrow("invalid block list");
  });

  test("unknown normalization identifiers fail closed", () => {
    const unknown = "omniroute-v3.8.52.provider-other" as SourceNormalizationId;
    expect(() => normalizeSourceRequest(unknown, {})).toThrow("unsupported source normalization");
    expect(() => sourceStateView(unknown, {})).toThrow("unsupported source normalization");
  });
});
