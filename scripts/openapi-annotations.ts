/** Annotation-only repairs bound to the exact reviewed OpenAPI document. */
export function reviewedOpenApiAnnotation(value: unknown, label: string, source: { commit: string; sha256: string }): unknown {
  if (source.commit !== "191dce8d534ceb56c28a08e71381284a9a87838f"
    || source.sha256 !== "382c51388159e411dfe79d002aff2bbe3bd8bdcdcbad3b08201fbf14815d63bc") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  if (label === "GET /api/system/version.responses.200.application/json.schema.properties.news"
    && Object.keys(schema).sort().join(",") === "description,or null."
    && schema.description === "Active release-news payload" && schema["or null."] === null) {
    // The unquoted comma split prose into a YAML key; no type is inferred.
    return { description: "Active release-news payload, or null." };
  }
  return value;
}
