import { expect, test } from "bun:test";
import { createPinnedManagementAuthorization } from "./fixtures/pinned-handler.fixture.ts";

test("concurrent source-auth fixtures isolate environment and restore it after a failed handler", async () => {
  const original = process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN;
  const fixture = (token: string) => createPinnedManagementAuthorization({
    internalServiceToken: token,
    isDashboardSession: () => false,
    verifyAccessToken: () => null,
    validateApiKey: () => true,
    getApiKeyMetadata: () => ({ id: "fixture-management", scopes: ["manage"] }),
  });
  const first = fixture("fixture-environment-first");
  const second = fixture("fixture-environment-second");
  const request = () => new Request("http://127.0.0.1/api/fallback/chains", { headers: { authorization: "Bearer fixture-management-key" } });
  const options = { centralAuthRequired: true, handlerAuthRequired: true };
  const results = await Promise.allSettled([
    first.dispatch(request(), options, async () => {
      await Bun.sleep(10);
      expect(process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN).toBe("fixture-environment-first");
      return new Response("first");
    }),
    second.dispatch(request(), options, async () => {
      expect(process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN).toBe("fixture-environment-second");
      throw new Error("fixture handler failed");
    }),
  ]);
  expect(results[0]?.status).toBe("fulfilled");
  expect(results[1]?.status).toBe("rejected");
  // Compare as a boolean so an inherited credential can never appear in diagnostics.
  expect(process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN === original).toBe(true);
  const recovered = await first.dispatch(request(), options, async () => new Response("recovered"));
  expect(await recovered.text()).toBe("recovered");
  expect(process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN === original).toBe(true);
});
