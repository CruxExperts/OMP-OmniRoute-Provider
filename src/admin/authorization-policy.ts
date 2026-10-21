import type { OMAAccessTokenScope } from "./registry.ts";

// Mirrors pinned OmniRoute v3.8.52 `src/server/authz/accessScopes.ts`.
// Commit ad6f33f66bda34eba98645d3bfdabbde294bc843; SHA-256 8cadf0203b349cec4eee5f4a00c418fea3b9f27acc9c4ce7bc244aa44e1a2d75.
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
];

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

  const mutation = !READ_METHODS.has(verb);
  if (mutation && matchesPrefix(route, ADMIN_MUTATION_PREFIXES)) return "admin";
  return mutation ? "write" : "read";
}
