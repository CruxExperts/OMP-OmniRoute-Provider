import { expect, test } from "bun:test";
import { reviewedOpenApiAnnotation } from "../scripts/openapi-annotations.ts";

test("only exact pinned malformed prose receives an annotation-only repair", () => {
  const source = { commit: "191dce8d534ceb56c28a08e71381284a9a87838f", sha256: "382c51388159e411dfe79d002aff2bbe3bd8bdcdcbad3b08201fbf14815d63bc" };
  const label = "GET /api/system/version.responses.200.application/json.schema.properties.news";
  const malformed = { description: "Active release-news payload", "or null.": null };
  expect(reviewedOpenApiAnnotation(malformed, label, source)).toEqual({ description: "Active release-news payload, or null." });
  expect(reviewedOpenApiAnnotation(malformed, label, { ...source, sha256: "0".repeat(64) })).toBe(malformed);
  expect(reviewedOpenApiAnnotation(malformed, "another response", source)).toBe(malformed);
  const extra = { ...malformed, invented: true };
  expect(reviewedOpenApiAnnotation(extra, label, source)).toBe(extra);
});
