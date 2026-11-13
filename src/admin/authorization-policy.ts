import type { OMAAccessTokenScope } from "./registry.ts";

// Mirrors pinned OmniRoute v3.8.53 `src/server/authz/accessScopes.ts`.
// Commit 191dce8d534ceb56c28a08e71381284a9a87838f; SHA-256 8cfacb4aeba07b3b9b7817792bccdf7e5b6d686404c128ddaf39ff9009888b58.
//
// MIT License
// Copyright (c) 2026 diegosouzapw
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const ADMIN_SCOPE_PREFIXES: readonly string[] = [
  "/api/cli/tokens",
  "/api/oauth",
  "/api/auth",
  "/api/policy",
  "/api/services",
  "/api/mcp",
];
const ADMIN_MUTATION_PREFIXES: readonly string[] = [
  "/api/providers",
  "/api/cli-tools/apply",
  "/api/keys",
];
const ADMIN_MUTATION_EXACT_PATHS: readonly string[] = ["/api/settings", "/api/settings/require-login", "/api/settings/system-prompt"];

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47)) return true;
  }
  return false;
}

export function requiredOmaScope(method: string, path: string): OMAAccessTokenScope {
  const verb = (method || "GET").toUpperCase();
  const route = path || "/";
  if (matchesPrefix(route, ADMIN_SCOPE_PREFIXES)) return "admin";
  if (matchesPrefix(route, ["/api/keys"]) && /\/reveal\/?$/.test(route)) return "admin";

  const mutation = !READ_METHODS.has(verb);
  if (mutation && matchesPrefix(route, ADMIN_MUTATION_PREFIXES)) return "admin";
  const exactRoute = route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;
  if (mutation && ADMIN_MUTATION_EXACT_PATHS.includes(exactRoute)) return "admin";
  return mutation ? "write" : "read";
}
