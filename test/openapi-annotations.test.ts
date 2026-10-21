import { expect, test } from "bun:test";
import { reviewedOpenApiAnnotation } from "../scripts/openapi-annotations.ts";

test("only exact pinned malformed prose receives an annotation-only repair", () => {
  const source = { commit: "ad6f33f66bda34eba98645d3bfdabbde294bc843", sha256: "b5ca0929a47416f4f223c79572c58c5e070595483cd36f13f6312149e50a9b03" };
  const label = "GET /api/system/version.responses.200.application/json.schema.properties.news";
  const malformed = { description: "Active release-news payload", "or null.": null };
  expect(reviewedOpenApiAnnotation(malformed, label, source)).toEqual({ description: "Active release-news payload, or null." });
  expect(reviewedOpenApiAnnotation(malformed, label, { ...source, sha256: "0".repeat(64) })).toBe(malformed);
  expect(reviewedOpenApiAnnotation(malformed, "another response", source)).toBe(malformed);
  const extra = { ...malformed, invented: true };
  expect(reviewedOpenApiAnnotation(extra, label, source)).toBe(extra);
});
