/** Annotation-only repair of a documented malformed YAML flow mapping. */
export function reviewedOpenApiAnnotation(value: unknown, label: string, source: { commit: string; sha256: string }): unknown {
  if (source.commit !== "ad6f33f66bda34eba98645d3bfdabbde294bc843"
    || source.sha256 !== "b5ca0929a47416f4f223c79572c58c5e070595483cd36f13f6312149e50a9b03"
    || label !== "GET /api/system/version.responses.200.application/json.schema.properties.news") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  if (Object.keys(schema).sort().join(",") !== "description,or null."
    || schema.description !== "Active release-news payload" || schema["or null."] !== null) return value;
  // The unquoted comma split prose into a YAML key; no type or runtime constraint is inferred.
  return { description: "Active release-news payload, or null." };
}
