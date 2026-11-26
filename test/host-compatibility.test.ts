import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

test("host and peer ranges retain the original floor without an upper bound", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(resolve(root, ".omp-plugin/marketplace.json"), "utf8"));
  const schema = JSON.parse(readFileSync(resolve(root, ".omp-plugin/marketplace.schema.json"), "utf8"));
  const range = manifest.omp.compatibility.host;
  expect(range).toBe(">=18.12.2");
  expect(new RegExp(schema.properties.compatibility.properties.host.pattern).test(range)).toBe(true);
  expect(marketplace.compatibility).toEqual(manifest.omp.compatibility);
  expect(Bun.semver.satisfies("18.12.1", range)).toBe(false);
  for (const version of ["18.12.2", "19.2.1", "19.99.0", "20.0.0"]) {
    expect(Bun.semver.satisfies(version, range)).toBe(true);
  }
  for (const peer of Object.values(manifest.peerDependencies)) expect(peer).toBe(range);
  for (const version of ["19.0.0", "19.1.0", "19.2.1"]) {
    expect(manifest.omp.compatibility.tested).toContain(version);
  }
});

test("modern setup input masks secrets and preserves cancellation and non-secret prefill", () => {
  const script = `
    import { mock } from "bun:test";
    mock.module("@oh-my-pi/pi-tui", () => ({}));
    const { promptSetup } = await import("./src/setup.ts");
    const answers = ["https://example.test", undefined, "  replacement  ", "secret", ""];
    const calls = [];
    const context = { mode: "tui", ui: {
      input: async (...args) => { calls.push(args); return answers.shift(); },
      editor: async (...args) => { calls.push(args); return answers.shift(); },
    } };
    const results = [
      await promptSetup(context, "Gateway", false, "https://example.test", ["Help"]),
      await promptSetup(context, "Gateway", false, "https://example.test"),
      await promptSetup(context, "Gateway", false, "https://example.test"),
      await promptSetup(context, "Key", true, "must-not-appear"),
      await promptSetup(context, "Key", true, "must-not-appear"),
    ];
    console.log(JSON.stringify({ results, calls }));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.results).toEqual(["https://example.test", null, "replacement", "secret", null]);
  expect(output.calls[0][1]).toBe("https://example.test");
  expect(output.calls[0][3]).toEqual({ promptStyle: true });
  expect(output.calls[3][0]).not.toContain("must-not-appear");
  expect(output.calls[3][2]).toEqual({ secret: true });
});

test("modern administration prompts mask credentials and stop on cancellation", () => {
  const script = `
    import { mock } from "bun:test";
    mock.module("@oh-my-pi/pi-tui", () => ({}));
    const { createAdminCommandHandler } = await import("./src/admin/ui.ts");
    delete process.env.OMP_OMNIROUTE_ADMIN_API_KEY;
    delete process.env.OMP_OMNIROUTE_ADMIN_COOKIE;
    const descriptor = {
      operationId: "GET /fixture", method: "GET", sideEffect: "read",
      confirmation: { required: false }, secrets: { inputFields: [] },
      auth: { domain: "management", sourcePolicy: { status: "unqualified" } },
    };
    const adapter = { descriptor, risk: "read", eligibility: { status: "verified" } };
    const registry = { getOperation: () => descriptor, lookup: () => adapter };
    const calls = [];
    let bound = 0, reads = 0;
    const executor = {
      getCredentialBinding: () => undefined,
      bindCredential: () => { bound++; },
      read: async () => { reads++; return { output: {} }; },
    };
    const handler = createAdminCommandHandler({ executor, registry, endpoint: "http://127.0.0.1:20128" });
    const answers = ["apiKey", undefined, "apiKey", "fixture-key", "{}"];
    const context = { mode: "tui", hasUI: true, ui: {
      input: async (...args) => { calls.push(args); return answers.shift(); },
      notify: () => {},
    } };
    await handler("GET /fixture", context);
    const cancelled = { bound, reads };
    await handler("GET /fixture", context);
    console.log(JSON.stringify({ cancelled, bound, reads, calls }));
  `;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout.toString());
  expect(output.cancelled).toEqual({ bound: 0, reads: 0 });
  expect(output.bound).toBe(1);
  expect(output.reads).toBe(1);
  expect(output.calls[0][2]).toEqual({ secret: false });
  expect(output.calls[1][2]).toEqual({ secret: true });
  expect(output.calls[3][2]).toEqual({ secret: true });
  expect(output.calls[4][2]).toEqual({ secret: false });
});
