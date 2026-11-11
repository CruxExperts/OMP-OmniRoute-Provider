import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWindowsResearchOverlay,
  availableOperationMenuPattern,
  createDialogueScheduler,
  hasNativeUnknownOutcomes,
  hasNativeAvailableOperationDescription,
  nativeAdminApplyConfirmationPattern,
  nativeAdminEmptyFallbackReadPattern,
  nativeAdminNewPlanPattern,
  nativeAdminPromptPattern,
  nativeAdminUnknownOutcomePattern,
  nativeEnvironmentSwitchConfirmationPattern,
  nativeInferenceTimeoutMs,
  nativeLoginSelectorShowsProvider,
  nativeLoginCommandRenderedPattern,
  nativeLoginCommandCompletedPattern,
  nativePtyDialogueText,
  writeNativeLoginDiagnostic,
} from "../scripts/smoke.ts";

test("persisted inference allows five Windows ACL reads without changing other deadlines", () => {
  expect(nativeInferenceTimeoutMs("win32", true)).toBe(170_000);
  expect(nativeInferenceTimeoutMs("win32", false)).toBe(20_000);
  expect(nativeInferenceTimeoutMs("linux", true)).toBe(20_000);
  expect(nativeInferenceTimeoutMs("darwin", true)).toBe(20_000);
});

test("native login diagnostic preserves bounded identity before and after an interrupted dialogue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-login-diagnostic-test-"));
  const path = join(directory, "diagnostic.json");
  const identity = { runId: "123", sourceRevision: "a".repeat(40), archiveSha256: "b".repeat(64), hostSha256: "c".repeat(64), hostVersion: "18.12.5", architecture: "x64" as const };
  try {
    await writeNativeLoginDiagnostic(path, identity, { rendered: "not-observed", dispatched: "not-observed", delayed: "not-observed" });
    const before = JSON.parse(await readFile(path, "utf8"));
    expect(before.identity).toEqual(identity);
    expect(before.observations.dispatched).toBe("not-observed");
    try {
      throw new Error("fixture interruption");
    } finally {
      await writeNativeLoginDiagnostic(path, identity, { rendered: { submitReady: "unavailable" }, dispatched: "not-observed", delayed: "not-observed" });
    }
  } catch (error) {
    expect((error as Error).message).toBe("fixture interruption");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.schemaVersion).toBe(2);
    expect(after.identity).toEqual(identity);
    expect(after.observations.rendered.submitReady).toBe("unavailable");
    await expect(writeNativeLoginDiagnostic(path, { ...identity, runId: "123 private data" }, {})).rejects.toThrow("identity is invalid");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(after);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native operation availability is tied to that operation's complete description", () => {
  const operationId = "GET /api/fallback/chains";
  expect(hasNativeAvailableOperationDescription(`\n${operationId} · available\n`, operationId)).toBe(true);
  expect(hasNativeAvailableOperationDescription(`│      ${operationId} · available      │\r\r\n`, operationId)).toBe(true);
  expect(hasNativeAvailableOperationDescription(`\n${operationId} · available (read-only)\n`, operationId)).toBe(false);
  expect(hasNativeAvailableOperationDescription(`\n${operationId} · unavailable: no adapter\n`, operationId)).toBe(false);
  expect(hasNativeAvailableOperationDescription(
    `${operationId} · unavailable: no adapter\nPOST /api/fallback/chains · available\n`,
    operationId,
  )).toBe(false);
  expect(hasNativeAvailableOperationDescription(
    `${operationId}\nPOST /api/fallback/chains · available\n`,
    operationId,
  )).toBe(false);
});

test("native administration prompt accepts the model selected by earlier inference", () => {
  expect(nativeAdminPromptPattern.test("π-omniroute-smoke > ⬢ fixture-responses-model > 📁 workspace >"))
    .toBe(true);
  expect(nativeAdminPromptPattern.test("π-omniroute-smoke > ⬢ no-model > 📁 workspace >"))
    .toBe(true);
});

test("native login confirms an affirmative switch away from environment credentials", () => {
  const prompt = [
    "Use a native OmniRoute profile connection instead of the environment connection?",
    "This OMP profile will use the endpoint and runtime key you enter. Environment variables remain unchanged; a missing native credential will fail closed.",
    "yes/no",
  ].join("\n");
  expect(nativeEnvironmentSwitchConfirmationPattern.test(prompt)).toBe(true);
  const nativePrompt = [
    "│ Use a native OmniRoute profile connection instead of the environment connection?X│",
    "│ This OMP profile will use the endpoint and runtime key you enter. Environment variables remain unchanged; a missing native credential will fail closed.      │",
    "│ e.g., yes/noX│",
    "│ >  X│",
    "│ (⎋ to cancel, ⏎ to submit)X│",
  ].join("\n");
  expect(nativeEnvironmentSwitchConfirmationPattern.test(nativePrompt)).toBe(true);
  expect(nativeEnvironmentSwitchConfirmationPattern.test(nativePrompt.replace("yes/noX│", "yes/nothingX│"))).toBe(false);
  expect(nativeEnvironmentSwitchConfirmationPattern.test(nativePrompt.replace("missing native credential will fail closed", "missing native credential will be ignored"))).toBe(false);
  expect(nativeEnvironmentSwitchConfirmationPattern.test(prompt.replace("yes/no", ""))).toBe(false);
  expect(nativeEnvironmentSwitchConfirmationPattern.test(prompt.replace("endpoint and runtime key", "connection"))).toBe(false);
  expect(nativeEnvironmentSwitchConfirmationPattern.test("Connect to OmniRoute?\nYes/No")).toBe(false);
});

test("native login verifies the provider label inside the selector before switch confirmation", () => {
  const section = "Select provider to login\nSearch: omniroute\nCrux OmniRoute Provider\n";
  const confirmation = "Use a native OmniRoute profile connection instead of the environment connection?";
  expect(nativeLoginSelectorShowsProvider(`${section}${confirmation}`)).toBe(true);
  expect(nativeLoginSelectorShowsProvider(`Crux OmniRoute Provider\nSelect provider to login\nSearch: omniroute\n${confirmation}`)).toBe(false);
  expect(nativeLoginSelectorShowsProvider(`Select provider to login\nSearch: omniroute\n${confirmation}\nCrux OmniRoute Provider`)).toBe(false);
});

test("composed native menu dialogue cancels after the selected available row", async () => {
  const written: string[] = [];
  const scheduler = createDialogueScheduler([
    {
      when: availableOperationMenuPattern("api/fallback", "GET /api/fallback/chains"),
      text: "__ESC__",
      afterMs: 0,
    },
  ], (_step, _index, text) => {
    written.push(nativePtyDialogueText(text));
    return Promise.resolve();
  });
  expect(scheduler.observe("Operations in api/fallback\nGET /api/fallback/chains · unavailable: no adapter\nPOST /api/fallback/chains · available\n"))
    .toBe(false);
  expect(scheduler.observe("\r\r\n\u001b[0m\u001b[K\u001b[38;5;236m│\u001b[39m      \u001b[38;5;248mGET /api/fallback/chains · available\u001b[39m      \u001b[38;5;236m│\u001b[39m\u001b[0m\r\r\n│ PATCH /api/fallback/chains · available │\r\r\n↑/↓ navigate  ⏎ select  ⎋ cancel"))
    .toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual(["\u001b"]);
  expect(scheduler.completed).toBe(1);
  scheduler.cancel();
});

test("login submits only after Tab completion renders, including output during writes", async () => {
  const written: string[] = [];
  const writeStarted = Promise.withResolvers<void>();
  const writeFinished = Promise.withResolvers<void>();
  const tabStarted = Promise.withResolvers<void>();
  const tabFinished = Promise.withResolvers<void>();
  const enterWritten = Promise.withResolvers<void>();
  const cancelWritten = Promise.withResolvers<void>();
  const scheduler = createDialogueScheduler([
    { when: /initial prompt/, text: "/login", afterMs: 0, captureDuringDispatch: true },
    { when: nativeLoginCommandRenderedPattern, text: "\t", afterMs: 0, captureDuringDispatch: true },
    { when: nativeLoginCommandCompletedPattern, text: "\r", afterMs: 0, captureDuringDispatch: true },
    { when: /Select provider to login/, text: "cancel", afterMs: 0 },
  ], async (_step, index, text) => {
    written.push(text);
    if (index === 0) {
      writeStarted.resolve();
      await writeFinished.promise;
    } else if (index === 1) {
      tabStarted.resolve();
      await tabFinished.promise;
    } else if (index === 2) enterWritten.resolve();
    else cancelWritten.resolve();
  });
  expect(scheduler.observe("initial prompt")).toBe(true);
  await writeStarted.promise;
  scheduler.observe("╰─ /login\r\n❯ ⤵  login           Login: choose ");
  scheduler.observe("provider\r\n");
  expect(written).toEqual(["/login"]);
  writeFinished.resolve();
  await tabStarted.promise;
  expect(written).toEqual(["/login", "\t"]);
  scheduler.observe("╰─ /login [provider|redirect URL]");
  expect(written).toEqual(["/login", "\t"]);
  tabFinished.resolve();
  await enterWritten.promise;
  expect(written).toEqual(["/login", "\t", "\r"]);
  scheduler.observe("Select provider to login");
  await cancelWritten.promise;
  expect(written).toEqual(["/login", "\t", "\r", "cancel"]);
  scheduler.cancel();
});

test("login never submits when Tab completion is not observed", async () => {
  const written: string[] = [];
  const tabWritten = Promise.withResolvers<void>();
  const scheduler = createDialogueScheduler([
    { when: nativeLoginCommandRenderedPattern, text: "\t", afterMs: 0 },
    { when: nativeLoginCommandCompletedPattern, text: "\r", afterMs: 0 },
  ], async (_step, _index, text) => {
    written.push(text);
    if (text === "\t") tabWritten.resolve();
  });
  expect(scheduler.observe("╰─ /login\n❯ login  Login: choose provider")).toBe(true);
  await tabWritten.promise;
  expect(nativeLoginCommandCompletedPattern.test("╰─ /login [provider redirect URL]")).toBe(false);
  scheduler.observe("unrelated redraw");
  scheduler.cancel();
  expect(written).toEqual(["\t"]);
});

test("dialogue waits for the delayed write before accepting another prompt", async () => {
  const written: string[] = [];
  const writeAcks: Array<() => void> = [];
  const scheduler = createDialogueScheduler([
    { when: /same prompt/u, text: "first input", afterMs: 20 },
    { when: /same prompt/u, text: "second input", afterMs: 20 },
  ], async (_step, _index, text) => {
    written.push(text);
    await new Promise<void>(resolve => writeAcks.push(resolve));
  });

  expect(scheduler.observe("same prompt")).toBe(true);
  expect(scheduler.observe("same prompt")).toBe(false);
  await Bun.sleep(30);
  expect(written).toEqual(["first input"]);
  expect(scheduler.completed).toBe(0);
  expect(scheduler.observe("same prompt")).toBe(false);

  writeAcks[0]!();
  await Bun.sleep(0);
  expect(scheduler.completed).toBe(1);
  expect(scheduler.observe("same prompt")).toBe(true);
  await Bun.sleep(30);
  expect(written).toEqual(["first input", "second input"]);
  expect(scheduler.completed).toBe(1);

  writeAcks[1]!();
  await Bun.sleep(0);
  expect(scheduler.completed).toBe(2);
  scheduler.cancel();
});

test("dialogue binds an apply command to the plan ID observed in native output", async () => {
  const written: string[] = [];
  const scheduler = createDialogueScheduler([
    { when: /plan ([a-z0-9-]+) created/i, text: match => `/omniroute-admin apply ${match[1]}\n`, afterMs: 0 },
  ], async (_step, _index, text) => { written.push(text); });
  expect(scheduler.observe("plan fixture-a1b2 created")).toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual(["/omniroute-admin apply fixture-a1b2\n"]);
  expect(scheduler.completed).toBe(1);
  scheduler.cancel();
});

test("second plan ignores an earlier plan redrawn while DELETE is in progress", async () => {
  const first = "p-c40ad3639870797d319ff390f393793d";
  const second = "p-36424723bc1f1958ef6ce4cc9efb4dab";
  const written: string[] = [];
  const scheduler = createDialogueScheduler([
    { when: () => nativeAdminNewPlanPattern(first), text: match => `/omniroute-admin apply ${match[1]}\n`, afterMs: 0 },
  ], async (_step, _index, value) => { written.push(value); });

  expect(scheduler.observe(`administration outcome is unknown; reconcile before retrying (${first})\nplan ${first} created`)).toBe(false);
  expect(scheduler.observe(`\nplan ${first} created`)).toBe(false);
  expect(scheduler.observe(`\nplan ${second} created`)).toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual([`/omniroute-admin apply ${second}\n`]);
  expect(scheduler.completed).toBe(1);
  scheduler.cancel();
});

test("final native read selector waits for the cleaned fallback map", () => {
  expect(nativeAdminEmptyFallbackReadPattern.test('read result for GET /api/fallback/chains: {}')).toBe(true);
  expect(nativeAdminEmptyFallbackReadPattern.test('read result for GET /api/fallback/chains: { "fixture-native-admin-model": [] }')).toBe(false);
});

test("native apply confirmation matches the visible question and selected Yes after a long preview scrolls the title away", () => {
  const question = "Confirm this exact target, side effect, and irreversible consequence?";
  const modal = `│ ${question} │\r\r\n│  ❯ Yes  │\r\r\n│    No   │`;
  expect(nativeAdminApplyConfirmationPattern.test(modal)).toBe(true);
  expect(nativeAdminApplyConfirmationPattern.test(`╭─ Apply administration plan ─╮\n│  ❯ Yes  │\n│    No   │`)).toBe(false);
  expect(nativeAdminApplyConfirmationPattern.test(modal.replace("❯ Yes", "❯ No"))).toBe(false);
  expect(nativeAdminApplyConfirmationPattern.test(modal.replace("│    No", "│    Cancel"))).toBe(false);
  expect(nativeAdminApplyConfirmationPattern.test(`Enable OmniRoute administration\n│  ❯ Yes  │\n│    No   │`)).toBe(false);
});

test("native mutation dialogue advances only on an unknown outcome warning", () => {
  expect(nativeAdminUnknownOutcomePattern.test("administration outcome is unknown; reconcile before retrying (fixture-a1b2)"))
    .toBe(true);
  expect(nativeAdminUnknownOutcomePattern.test("administration plan applied: fixture-a1b2"))
    .toBe(false);
  expect(nativeAdminUnknownOutcomePattern.test("administration plan was not applied (fixture-a1b2)"))
    .toBe(false);
});

test("native administration warnings belong to both distinct plans despite terminal redraws", () => {
  const first = "p-first";
  const second = "p-second";
  const warning = (id: string) => `administration outcome is unknown; reconcile before retrying (${id})`;
  expect(hasNativeUnknownOutcomes([warning(first), warning(first), warning(first)].join("\n"), [first, second]))
    .toBe(false);
  expect(hasNativeUnknownOutcomes([warning(first), warning(second), warning(first), warning(second)].join("\n"), [first, second]))
    .toBe(true);
  expect(hasNativeUnknownOutcomes([warning(first), warning(second)].join("\n"), [first, first]))
    .toBe(false);
  expect(hasNativeUnknownOutcomes([warning(first), warning(second), warning("p-other")].join("\n"), [first, second]))
    .toBe(false);
});

test("dynamic native warning matcher ignores a redraw of the first plan", async () => {
  const written: string[] = [];
  let expectedPlan = "p-first";
  const scheduler = createDialogueScheduler([
    { when: () => new RegExp(`reconcile before retrying \\(${expectedPlan}\\)`), text: "next", afterMs: 0 },
    { when: () => new RegExp(`reconcile before retrying \\(${expectedPlan}\\)`), text: "done", afterMs: 0 },
  ], async (_step, _index, value) => { written.push(value); });
  expect(scheduler.observe("reconcile before retrying (p-first)")).toBe(true);
  await Bun.sleep(5);
  expectedPlan = "p-second";
  expect(scheduler.observe("reconcile before retrying (p-first)")).toBe(false);
  expect(scheduler.observe("reconcile before retrying (p-second)")).toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual(["next", "done"]);
  scheduler.cancel();
});

test("research provider overlay changes only three verified disposable installed sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-provider-overlay-"));
  const files = ["src/index.ts", "src/config.ts", "src/private-path.ts"];
  const originals = await Promise.all(files.map(file => readFile(join(import.meta.dir, "..", file))));
  const patch = join(import.meta.dir, "../scripts/windows-research-provider-overlay.patch");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    await mkdir(join(directory, "src"));
    for (const [index, file] of files.entries()) await writeFile(join(directory, file), originals[index]!);
    await writeFile(join(directory, "untouched.txt"), "preserve");
    const result = await applyWindowsResearchOverlay(directory, patch);
    expect(result).toMatchObject({ researchOnly: true, archiveStillVerifiedAfterOverlay: false, patchSha256: hash(await readFile(patch)) });
    const entries = result.files as Array<{ file: string; originalSha256: string; resultingSha256: string }>;
    expect(entries.map(entry => entry.file)).toEqual(files);
    for (const [index, file] of files.entries()) {
      const modified = await readFile(join(directory, file));
      expect(entries[index]!.originalSha256).toBe(hash(originals[index]!));
      expect(entries[index]!.resultingSha256).toBe(hash(modified));
      expect(modified).not.toEqual(originals[index]!);
      expect(await readFile(join(import.meta.dir, "..", file))).toEqual(originals[index]!);
    }
    const instrumented = await readFile(join(directory, "src/index.ts"), "utf8");
    expect(instrumented).toContain('pi.on("session_start", async (_event, ctx) => {\n\t\tresearchStartup(19);');
    expect(instrumented).toContain('researchStartup(28);\n\t\t\tconst flight = updateConfig');
    expect(instrumented).toContain('() => { researchStartup(29); }');
    expect(instrumented).toContain('error => {\n\t\t\t\t\tresearchStartup(40);');
    const loginStart = instrumented.indexOf("login: async callbacks => {");
    const loginEnd = instrumented.indexOf("\n\t\t},\n\t};", loginStart);
    expect(loginStart).toBeGreaterThanOrEqual(0);
    expect(loginEnd).toBeGreaterThan(loginStart);
    const loginExpression = instrumented.slice(loginStart + "login: ".length, loginEnd + "\n\t\t}".length);
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`const run = ${loginExpression};`);
    const state = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const setupKey = Symbol.for("cruxomni.windowsResearch.setup.v1");
    for (const reject of [false, true]) {
      const { promise: gate, resolve: settle } = Promise.withResolvers<void>();
      const observed: boolean[] = [];
      const failure = new Error("login failed");
      const nativeLogin = { login: async () => {
        observed.push(state[setupKey] === true); // pre-prompt configuration load
        await gate;
        observed.push(state[setupKey] === true); // persistence
        observed.push(state[setupKey] === true); // activation refresh
        if (reject) throw failure;
        return "complete";
      } };
      const run = new Function("nativeLogin", "settleInvitation", "researchStartup", `${compiled}\nreturn run;`)(
        nativeLogin, async () => undefined, () => undefined,
      ) as (callbacks: object) => Promise<string>;
      const pending = run({});
      await Promise.resolve();
      expect(state[setupKey]).toBe(true);
      settle();
      if (reject) await expect(pending).rejects.toBe(failure);
      else await expect(pending).resolves.toBe("complete");
      expect(observed).toEqual([true, true, true]);
      expect(state[setupKey]).toBe(false);
    }
    delete state[setupKey];
    const privatePath = await readFile(join(directory, "src/private-path.ts"), "utf8");
    for (const marker of [80, 81, 82, 83, 84, 85]) expect(privatePath).toContain(`researchMarker(${marker}, invocation)`);
    expect(privatePath).toContain("const invocation = ++researchInvocation;");
    expect(await readFile(join(directory, "untouched.txt"), "utf8")).toBe("preserve");
    for (const [index, file] of files.entries()) await writeFile(join(directory, file), originals[index]!);
    for (const [index, file] of files.entries()) {
      await writeFile(join(directory, file), "drift");
      await expect(applyWindowsResearchOverlay(directory, patch)).rejects.toThrow("original source mismatch");
      expect(await readFile(join(directory, file), "utf8")).toBe("drift");
      await writeFile(join(directory, file), originals[index]!);
    }
    const invalid = join(directory, "invalid.patch");
    await writeFile(invalid, `${await readFile(patch, "utf8")}--- a/untouched.txt\n+++ b/untouched.txt\n`);
    await expect(applyWindowsResearchOverlay(directory, invalid)).rejects.toThrow("file allowlist mismatch");
    await writeFile(invalid, `${await readFile(patch, "utf8")}\n`);
    await expect(applyWindowsResearchOverlay(directory, invalid)).rejects.toThrow("patch digest mismatch");
    for (const [index, file] of files.entries()) expect(await readFile(join(directory, file))).toEqual(originals[index]!);
    expect(await readFile(join(directory, "untouched.txt"), "utf8")).toBe("preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("research ACL events correlate invocations and use the sample's monotonic clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-trace-timing-"));
  const key = Symbol.for("cruxomni.windowsResearch.trace.v1");
  const state = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previousSink = state[key];
  const previousEnabled = process.env.OMP_RESEARCH_INPUT_TRACE;
  try {
    const patch = await readFile(join(import.meta.dir, "../scripts/windows-research-input-instrumentation.patch"), "utf8");
    const section = patch.split("+++ b/packages/tui/src/research-trace.ts\n")[1]?.split("--- a/packages/tui/src/terminal.ts\n")[0];
    if (!section) throw new Error("research trace patch section missing");
    const lines = section.trimEnd().split("\n");
    expect(lines.shift()).toBe("@@ -0,0 +1,63 @@");
    expect(lines.every(line => line.startsWith("+"))).toBe(true);
    const modulePath = join(directory, "research-trace.ts");
    await writeFile(modulePath, lines.map(line => line.slice(1)).join("\n"));
    process.env.OMP_RESEARCH_INPUT_TRACE = "1";
    // The module is generated from the patch at a temporary runtime path.
    const trace = await import(modulePath);
    const sink = state[key] as (marker: unknown, invocation?: unknown) => void;
    sink(80, 1);
    sink(81, 1);
    sink(80, 2);
    sink(83, 2);
    sink(80, 257);
    sink(80, "2");
    sink(86, 2);
    const first = trace.researchRead(0);
    expect(first.available).toBe(true);
    expect(first.events.map((event: { a: number; id: number }) => [event.a, event.id])).toEqual([[80, 1], [81, 1], [80, 2], [83, 2], [86, 0]]);
    const elapsed = (event: { b: number; c: number; d: number }) => event.b * 65536 + event.c * 256 + event.d;
    const times = first.events.map(elapsed);
    expect(times[1]).toBeGreaterThanOrEqual(times[0]);
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
    expect(first.overflow).toBe(false);
    const second = trace.researchRead(first.cursor);
    expect(second.events.map((event: { a: number }) => event.a)).toEqual([86]);
    expect(elapsed(second.events[0])).toBeGreaterThanOrEqual(times[4]);
  } finally {
    if (previousEnabled === undefined) delete process.env.OMP_RESEARCH_INPUT_TRACE;
    else process.env.OMP_RESEARCH_INPUT_TRACE = previousEnabled;
    if (previousSink === undefined) delete state[key];
    else state[key] = previousSink;
    await rm(directory, { recursive: true, force: true });
  }
});
