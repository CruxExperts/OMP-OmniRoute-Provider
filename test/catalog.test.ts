import { expect, test } from "bun:test";
import { THINKING_EFFORTS, type ThinkingConfig } from "@oh-my-pi/pi-ai";
import { projectCatalog } from "../src/catalog.ts";
import type { CatalogMetadataEntry, CatalogMetadataSnapshot, CatalogSourceId } from "../src/catalog-sources.ts";

function snapshot(source: CatalogSourceId, entries: CatalogMetadataEntry[], expiresAt = 1_000): CatalogMetadataSnapshot {
  return { source, fetchedAt: 10, expiresAt, digest: "a".repeat(64), entries };
}
const syntheticThinking: ThinkingConfig = {
  mode: "effort",
  efforts: THINKING_EFFORTS.filter(effort => effort === "low" || effort === "medium" || effort === "high"),
};

test("live false capability values override exact external metadata and partial fields merge independently", () => {
  const metadata = snapshot("openrouter", [{
    owner: "openrouter",
    id: "openrouter/vendor/synthetic-chat",
    sourceOwner: "openrouter",
    sourceId: "vendor/synthetic-chat",
    name: "Synthetic external name",
    context_length: 32_000,
    max_output_tokens: 4096,
    input_modalities: ["text", "image"],
    capabilities: {
      reasoning: true,
      supportsTools: true,
      thinking: syntheticThinking,
    },
  }]);
  const projection = projectCatalog({ data: [{
    id: "openrouter/vendor/synthetic-chat",
    owned_by: "openrouter",
    supported_endpoints: ["chat"],
    supportsTools: false,
    context_length: 8192,
    capabilities: { reasoning: false },
  }] }, { externalMetadata: [metadata], now: 50 });
  const model = projection.models[0];
  expect(model).toMatchObject({
    id: "openrouter/vendor/synthetic-chat",
    name: "Synthetic external name",
    contextWindow: 8192,
    maxTokens: 4096,
    reasoning: false,
    supportsTools: false,
    input: ["text", "image"],
  });
  expect(model?.thinking).toBeUndefined();
  expect(projection.diagnostics).toContainEqual(expect.objectContaining({ code: "capability_source_conflict", detail: "supportsTools" }));
});

test("conflicting optional source fields are omitted instead of selected by arrival order", () => {
  const modelsDev = snapshot("models.dev", [{
    owner: "openrouter", id: "openrouter/vendor/model", sourceOwner: "openrouter", sourceId: "vendor/model",
    context_length: 4096, max_output_tokens: 1024, input_modalities: ["text"],
    capabilities: { supportsTools: true },
  }]);
  const openRouter = snapshot("openrouter", [{
    owner: "openrouter", id: "openrouter/vendor/model", sourceOwner: "openrouter", sourceId: "vendor/model",
    context_length: 8192, max_output_tokens: 1024, input_modalities: ["image"],
    capabilities: { supportsTools: false },
  }]);
  const projection = projectCatalog({ data: [{ id: "openrouter/vendor/model", owned_by: "openrouter", supported_endpoints: ["chat"] }] }, {
    externalMetadata: [modelsDev, openRouter],
    now: 50,
  });
  expect(projection.models[0]?.contextWindow).toBe(128_000);
  expect(projection.models[0]?.maxTokens).toBe(1024);
  expect(projection.models[0]?.input).toEqual(["text"]);
  expect(projection.models[0]?.supportsTools).toBeUndefined();
  expect(projection.pricing.get("openrouter/vendor/model")?.state).toBe("unknown");
  expect(projection.diagnostics).toContainEqual(expect.objectContaining({ code: "external_field_conflict", modelId: "openrouter/vendor/model", detail: "context_length" }));
  expect(projection.diagnostics).toContainEqual(expect.objectContaining({ code: "external_field_conflict", modelId: "openrouter/vendor/model", detail: "supportsTools" }));
  expect(projection.diagnostics).toContainEqual(expect.objectContaining({ code: "context_limit_unverified", modelId: "openrouter/vendor/model" }));
  expect(projection.diagnostics).toContainEqual(expect.objectContaining({ code: "tools_unverified", modelId: "openrouter/vendor/model" }));
});

test("OpenRouter metadata must follow its pinned live-ID qualification before joining", () => {
  const unqualified = snapshot("openrouter", [{
    owner: "openrouter",
    id: "vendor/model",
    sourceOwner: "openrouter",
    sourceId: "vendor/model",
    name: "Misdirected external name",
  }]);
  const projection = projectCatalog({ data: [{
    id: "openrouter/vendor/model",
    owned_by: "openrouter",
    name: "Live name",
    supported_endpoints: ["chat"],
  }] }, { externalMetadata: [unqualified], now: 50 });
  expect(projection.models[0]?.name).toBe("Live name");
  expect(projection.diagnostics).toContainEqual({ code: "metadata_entry_invalid", source: "openrouter" });
});

test("optional catalog-only identities never become runnable and expired snapshots are diagnostic-only", () => {
  const expired = snapshot("openrouter", [{
    owner: "openrouter", id: "openrouter/vendor/catalog-only", sourceOwner: "openrouter", sourceId: "vendor/catalog-only",
    name: "Expired label",
  }], 49);
  const catalogOnly = projectCatalog({ data: [] }, { externalMetadata: [expired], now: 50 });
  expect(catalogOnly.models).toEqual([]);
  expect(catalogOnly.rows.size).toBe(0);
  const live = projectCatalog({ data: [{ id: "openrouter/vendor/catalog-only", owned_by: "openrouter", supported_endpoints: ["chat"] }] }, {
    externalMetadata: [expired], now: 50,
  });
  expect(live.models[0]?.name).toBe("openrouter/vendor/catalog-only");
  expect(live.diagnostics).toContainEqual({ code: "metadata_source_stale", source: "openrouter" });
});

test("specialty kinds and unknown kinds are not relabeled as chat models", () => {
  const projection = projectCatalog({ data: [
    { id: "image-generator", owned_by: "openrouter", kind: "image", supported_endpoints: ["chat"] },
    { id: "unknown-kind", owned_by: "openrouter", kind: "future-kind", supported_endpoints: ["chat"] },
  ] });
  expect(projection.models).toEqual([]);
  expect(projection.diagnostics).toContainEqual({ code: "specialty_only_route", modelId: "image-generator" });
  expect(projection.diagnostics).toContainEqual({ code: "unsupported_model_kind", modelId: "unknown-kind" });
});
