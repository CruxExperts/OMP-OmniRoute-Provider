import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { WELL_KNOWN_CARD_IDS, WellKnownAgentCardsFixture, wellKnownCardContract, wellKnownCardDescriptor } from "./fixtures/well-known-agent-cards.fixture.ts";

const envKeys = ["CONDUCTOR_HUB_URL", "CONDUCTOR_HUB_TOKEN", "OMNIROUTE_BASE_URL", "PORT", "DASHBOARD_PORT"] as const;
const token = "fixture-private-hub-token";
type Card = { name: string; url: string; version: string; capabilities: unknown; skills: Array<{ id: string; name: string; description: string; tags: string[] }>; security?: unknown; authentication?: unknown; supportedInterfaces?: unknown; defaultInputModes?: unknown; defaultOutputModes?: unknown };
const testId = "test/admin-well-known-agent-cards.test.ts";
const observations = new Map<string, { before: null; after: null; result: { status: number; body: unknown } }>();
const cases = new Set<string>();
afterAll(async () => {
  if (observations.size !== 2 || !["read", "hub", "failure", "url", "projection"].every(name => cases.has(name))) return;
  const caseSha256 = testCaseSourceHash(testId);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  for (const id of WELL_KNOWN_CARD_IDS) {
    const contract = wellKnownCardContract(id);
    const binding = operationEvidenceBinding(id, contract);
    const path = outcomeArtifactPath(id);
    await writeFile(resolve(process.cwd(), path), `${canonicalizeJson({ operationId: id, testId, caseSha256, binding, observation: observations.get(id) })}\n`, { mode: 0o600 });
    testOutcomeHash(id, testId, caseSha256, binding, contract, path);
  }
});

async function isolated(run: (fixture: WellKnownAgentCardsFixture, calls: Array<{ url: string; init?: RequestInit }>, setReply: (value: Response | Error) => void) => Promise<void>): Promise<void> {
  const saved = envKeys.map(key => process.env[key]);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reply: Response | Error = Response.json([]);
  try {
    for (const key of envKeys) delete process.env[key];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      if (reply instanceof Error) throw reply;
      return reply.clone();
    }) as typeof fetch;
    const fixture = new WellKnownAgentCardsFixture();
    try { await run(fixture, calls, value => { reply = value; }); } finally { fixture.reset(); }
  } finally {
    globalThis.fetch = originalFetch;
    envKeys.forEach((key, index) => { const value = saved[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
}

async function body(response: Response): Promise<Card> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  return await response.json() as Card;
}

// Direct source invocation only: this is not an HTTP/Next matcher or auth proof.
test("both receipt-verified GET cards share metadata but advertise distinct protocol envelopes", async () => isolated(async (fixture, calls) => {
  for (const id of WELL_KNOWN_CARD_IDS) {
    const response = await fixture.get(id, "https://gateway.example");
    const card = await body(response);
    observations.set(id, { before: null, after: null, result: { status: response.status, body: projectResponse(wellKnownCardDescriptor(id), card) } });
    expect(card.name).toBe("OmniRoute AI Gateway");
    expect(card.url).toBe("https://gateway.example/a2a");
    expect(card.version).toBe("3.8.53");
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
    expect(card.skills.map(skill => skill.id)).toEqual(["smart-routing", "quota-management", "provider-discovery", "cost-analysis", "health-report", "list-capabilities"]);
    const advertisement = { schemes: ["api-key"], apiKeyHeader: "Authorization" };
    if (id === WELL_KNOWN_CARD_IDS[0]) {
      expect(card.security).toEqual(advertisement);
      expect(card.authentication).toBeUndefined();
      expect(card.supportedInterfaces).toEqual([{ url: "https://gateway.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "1.0" }, { url: "https://gateway.example/a2a", protocolBinding: "JSONRPC", protocolVersion: "0.3" }]);
      expect(card.defaultInputModes).toEqual(["text/plain"]);
      expect(card.defaultOutputModes).toEqual(["text/plain"]);
    } else {
      expect(card.authentication).toEqual(advertisement);
      expect(card.security).toBeUndefined();
      expect(card.supportedInterfaces).toBeUndefined();
    }
    const contract = wellKnownCardContract(id);
    expect(contract.auth.sourcePolicy.status).toBe("qualified");
    expect(contract.sideEffect).toBe("read");
    expect(contract.retry.allowed).toBe(false);
  }
  expect(calls).toHaveLength(0);
  cases.add("read");
}));

test("controlled hub GET shares cached online runner data, observes expiry and reset without leaking the bearer", async () => isolated(async (fixture, calls, setReply) => {
  process.env.CONDUCTOR_HUB_URL = "  https://hub.example/base  ";
  process.env.CONDUCTOR_HUB_TOKEN = ` ${token} `;
  setReply(Response.json([
    { online: true, capabilities: { clis: [{ profile: "alpha", models: [{ id: "model-one" }, { id: "model-two" }] }], skills: ["code-review"] }, privateField: "private-runner-data" },
    { capabilities: { clis: [{ profile: "alpha", models: [{ id: "model-one" }] }], skills: ["code-review"] } },
    { online: false, capabilities: { clis: [{ profile: "offline", models: [{ id: "offline-model" }] }] } },
  ]));
  const first = await body(await fixture.get(WELL_KNOWN_CARD_IDS[0], "https://gateway.example"));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://hub.example/base/v1/runners");
  expect(calls[0]!.init?.method ?? "GET").toBe("GET");
  expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(`Bearer ${token}`);
  expect(first.skills.slice(6)).toEqual([
    { id: "conductor-cli-alpha", name: "Conductor fleet: alpha CLI", description: "Delegate coding tasks to the OmniConductor fleet's alpha CLI (2 runner(s) online; models: model-one, model-two). Tasks run in disposable git worktrees; results come back as branches with graduated manifests.", tags: ["conductor", "fleet", "cli", "alpha"] },
    { id: "conductor-skill-code-review", name: "Conductor fleet skill: code-review", description: 'OASF skill "code-review" declared by online runners of the OmniConductor fleet.', tags: ["conductor", "fleet", "skill"] },
  ]);
  expect(JSON.stringify(first)).not.toContain(token);
  expect(JSON.stringify(first)).not.toContain("private-runner-data");
  expect(JSON.stringify(first)).not.toContain("offline-model");
  setReply(Response.json([{ capabilities: { skills: ["changed"] } }]));
  fixture.now += 59_999;
  const cached = await body(await fixture.get(WELL_KNOWN_CARD_IDS[1]));
  expect(cached.skills.slice(6)).toEqual(first.skills.slice(6));
  expect(calls).toHaveLength(1);
  fixture.now += 1;
  const expired = await body(await fixture.get(WELL_KNOWN_CARD_IDS[0]));
  expect(expired.skills[6]?.id).toBe("conductor-skill-changed");
  expect(calls).toHaveLength(2);
  fixture.reset();
  await body(await fixture.get(WELL_KNOWN_CARD_IDS[1]));
  expect(calls).toHaveLength(3);
  cases.add("hub");
}));

test("hub failures and malformed bodies fail open and cache empty results", async () => isolated(async (fixture, calls, setReply) => {
  process.env.CONDUCTOR_HUB_URL = "https://hub.example";
  const failures = [new Error("private fetch failure"), new Response("unavailable", { status: 503 }), new Response("not-json", { status: 200 }), Response.json([{ capabilities: { clis: "bad-shape" } }])];
  for (const failure of failures) {
    fixture.reset();
    setReply(failure);
    const before = calls.length;
    for (const id of WELL_KNOWN_CARD_IDS) {
      const card = await body(await fixture.get(id));
      expect(card.skills).toHaveLength(6);
      expect(JSON.stringify(card)).not.toContain("private fetch failure");
    }
    expect(calls).toHaveLength(before + 1);
    expect(new Headers(calls[before]!.init?.headers).get("authorization")).toBe("Bearer");
  }
  cases.add("failure");
}));

test("base URL override, request origin and local port fallbacks follow pinned source", async () => isolated(async fixture => {
  for (const id of WELL_KNOWN_CARD_IDS) {
    process.env.OMNIROUTE_BASE_URL = "https://override.example/root/";
    expect((await body(await fixture.get(id, "https://ignored.example"))).url).toBe("https://override.example/root//a2a");
    delete process.env.OMNIROUTE_BASE_URL;
    expect((await body(await fixture.get(id, "https://origin.example:8443"))).url).toBe("https://origin.example:8443/a2a");
    process.env.PORT = "1234";
    process.env.DASHBOARD_PORT = "5678";
    expect((await body(await fixture.get(id))).url).toBe("http://localhost:1234/a2a");
    delete process.env.PORT;
    expect((await body(await fixture.get(id))).url).toBe("http://localhost:5678/a2a");
    delete process.env.DASHBOARD_PORT;
    expect((await body(await fixture.get(id))).url).toBe("http://localhost:20128/a2a");
  }
  cases.add("url");
}));

test("declared projection excludes untrusted skills, addresses and injected price claims", async () => isolated(async (fixture, _calls, setReply) => {
  process.env.CONDUCTOR_HUB_URL = "https://hub.example";
  process.env.CONDUCTOR_HUB_TOKEN = token;
  setReply(Response.json([{ capabilities: { clis: [{ profile: "private-profile", models: [{ id: "private-model" }] }] } }]));
  for (const id of WELL_KNOWN_CARD_IDS) {
    const card = await body(await fixture.get(id, "https://private-host.example"));
    const projection = projectResponse(wellKnownCardDescriptor(id), { ...card, pricing: { "private-model": 0 }, privateField: token });
    expect(projection).toEqual({ name: "OmniRoute AI Gateway", version: "3.8.53", capabilities: { streaming: true, pushNotifications: false } });
    const encoded = JSON.stringify(projection);
    for (const secret of [token, "private-host", "private-profile", "private-model", "pricing"]) expect(encoded).not.toContain(secret);
  }
  cases.add("projection");
}));
