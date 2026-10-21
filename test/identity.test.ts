import { expect, test } from "bun:test";
import { DISPLAY_NAME, GITHUB_REPOSITORY, PACKAGE_NAME, PROVIDER_ID, REPOSITORY_SLUG } from "../src/identity.ts";

test("new package identity preserves native provider identity", () => {
  expect(DISPLAY_NAME).toBe("OhMyPie OmniRoute Plugin");
  expect(REPOSITORY_SLUG).toBe("OMP-OmniRoute-Provider");
  expect(GITHUB_REPOSITORY).toBe("CruxExperts/OMP-OmniRoute-Provider");
  expect(PACKAGE_NAME).toBe("@cruxexperts/cruxomni-omp-client");
  expect(PROVIDER_ID).toBe("omniroute");
});
