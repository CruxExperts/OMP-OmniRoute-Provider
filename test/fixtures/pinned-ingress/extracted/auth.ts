import { readHeaderValue, type AuthRequestHeaders } from "@/sse/services/headerReader.ts";
import { extractGoogApiKeyHeader } from "@/sse/services/googApiKeyAuth.ts";
import { validateApiKey } from "@/lib/db/apiKeys";
import { timingSafeCompare } from "@/shared/utils/timingSafeCompare";
type AuthRequestLike = {
  headers?: AuthRequestHeaders | null;
  url?: string | null;
};

export function readNonEmptyUrlToken(request: AuthRequestLike): string | null {
  if (typeof request?.url !== "string" || request.url.trim().length === 0) return null;

  try {
    const url = new URL(request.url, "http://localhost");

    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (segments[0] === "vscode" && segments[1]) {
      const decodedSegment = decodeURIComponent(segments[1]).trim();
      if (decodedSegment.length > 0) return decodedSegment;
    }

    if (segments[0] === "api" && segments[1] === "v1" && segments[2] === "vscode") {
      if (segments[3] && segments[3] !== "raw" && segments[3] !== "combos") {
        const decodedSegment = decodeURIComponent(segments[3]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }

      if ((segments[3] === "raw" || segments[3] === "combos") && segments[4]) {
        const decodedSegment = decodeURIComponent(segments[4]).trim();
        if (decodedSegment.length > 0) return decodedSegment;
      }
    }

    // NOTE: query-string token fallbacks (`?token=`/`?key=`/`?apiKey=`/`?api_key=`)
    // were intentionally REMOVED. They are a broad credential-in-URL surface that
    // leaks into access logs, Referer headers and proxy logs, and — because this
    // extractor also feeds management auth — would let `?token=<mgmt-key>`
    // authenticate management routes. The VS Code integration only needs the
    // path-scoped `/vscode/<token>/…` form above. (security review, #3300 follow-up)
  } catch {
    return null;
  }

  return null;
}

export function extractApiKey(request: AuthRequestLike, opts?: { allowUrl?: boolean }) {
  const authHeader =
    readHeaderValue(request?.headers, "Authorization") ||
    readHeaderValue(request?.headers, "authorization");
  if (typeof authHeader === "string") {
    const trimmedHeader = authHeader.trim();
    if (trimmedHeader.toLowerCase().startsWith("bearer ")) {
      return trimmedHeader.slice(7).trim() || null;
    }
  }

  // Issue #2225: Anthropic Messages API clients authenticate via x-api-key.
  // Gate the fallback on anthropic-version OR a claude-code/anthropic user-agent so we
  // don't trip up local-mode requests from non-Anthropic clients that send placeholder
  // x-api-key values (which would otherwise be rejected as Invalid API key).
  const anthropicVersion =
    readHeaderValue(request?.headers, "anthropic-version") ||
    readHeaderValue(request?.headers, "Anthropic-Version");
  const userAgent =
    readHeaderValue(request?.headers, "user-agent") ||
    readHeaderValue(request?.headers, "User-Agent");
  if (anthropicVersion || (userAgent && /claude-code|claude-cli|anthropic/i.test(userAgent))) {
    const xApiKey =
      readHeaderValue(request?.headers, "x-api-key") ||
      readHeaderValue(request?.headers, "X-Api-Key");
    if (typeof xApiKey === "string") {
      const trimmed = xApiKey.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  const xGoogApiKey = extractGoogApiKeyHeader(request?.headers); // Issue #7034
  if (xGoogApiKey) return xGoogApiKey;
  if (opts?.allowUrl === false) return null;
  return readNonEmptyUrlToken(request);
}

export async function isValidApiKey(apiKey: string) {
  if (!apiKey) return false;

  // Persistent env-var key — always valid regardless of DB state (#1350)
  const envKey = process.env.OMNIROUTE_API_KEY || process.env.ROUTER_API_KEY;
  if (envKey && timingSafeCompare(apiKey, envKey)) return true;

  return await validateApiKey(apiKey);
}
