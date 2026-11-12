import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { loadPinnedModule, type PinnedExports } from "./fixtures/pinned-handler.fixture.ts";

type DocsRoute = PinnedExports & { GET(): Response };

test("receipt-verified docs handler returns its static HTML without a redirect", async () => {
  // Direct source observation only: the Next ingress and its authorization are not exercised.
  const route = loadPinnedModule("src/app/api/docs/route.ts", specifier => {
    throw new Error(`Unexpected docs dependency: ${specifier}`);
  }) as DocsRoute;
  expect(route.dynamic).toBe("force-static");
  expect(Object.keys(route).sort()).toEqual(["GET", "dynamic"]);

  const response = route.GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect([...response.headers.entries()].sort()).toEqual([
    ["cache-control", "public, max-age=300, s-maxage=300"],
    ["content-type", "text/html; charset=utf-8"],
    ["x-robots-tag", "noindex"],
  ]);
  const body = await response.text();
  expect(new TextEncoder().encode(body).byteLength).toBe(2497);
  expect(createHash("sha256").update(body).digest("hex")).toBe("bc5982cda119cd7a0fadc4b0d636c32ba7c3aedfa8abcb77b409cab65df9cb62");
  // These are browser dependencies in the returned shell; the handler does not fetch them.
  expect(body).toContain('<script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>');
  expect(body).toContain('Redoc.init(\n          "/openapi.yaml",');
  expect(body).toContain('<a href="/openapi.yaml">available as YAML</a>');
  expect(body).toContain("Redoc CDN unreachable");
});
