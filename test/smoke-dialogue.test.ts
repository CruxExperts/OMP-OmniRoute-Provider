import { expect, test } from "bun:test";
import {
  availableOperationMenuPattern,
  createDialogueScheduler,
  hasNativeUnknownOutcomes,
  hasNativeAvailableOperationDescription,
  nativeAdminApplyConfirmationPattern,
  nativeAdminEmptyFallbackReadPattern,
  nativeAdminNewPlanPattern,
  nativeAdminPromptPattern,
  nativeAdminUnknownOutcomePattern,
  nativePtyDialogueText,
} from "../scripts/smoke.ts";

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
    { when: /plan ([a-z0-9-]+) created/i, text: match => `/cruxomni-admin apply ${match[1]}\n`, afterMs: 0 },
  ], async (_step, _index, text) => { written.push(text); });
  expect(scheduler.observe("plan fixture-a1b2 created")).toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual(["/cruxomni-admin apply fixture-a1b2\n"]);
  expect(scheduler.completed).toBe(1);
  scheduler.cancel();
});

test("second plan ignores an earlier plan redrawn while DELETE is in progress", async () => {
  const first = "p-c40ad3639870797d319ff390f393793d";
  const second = "p-36424723bc1f1958ef6ce4cc9efb4dab";
  const written: string[] = [];
  const scheduler = createDialogueScheduler([
    { when: () => nativeAdminNewPlanPattern(first), text: match => `/cruxomni-admin apply ${match[1]}\n`, afterMs: 0 },
  ], async (_step, _index, value) => { written.push(value); });

  expect(scheduler.observe(`administration outcome is unknown; reconcile before retrying (${first})\nplan ${first} created`)).toBe(false);
  expect(scheduler.observe(`\nplan ${first} created`)).toBe(false);
  expect(scheduler.observe(`\nplan ${second} created`)).toBe(true);
  await Bun.sleep(5);
  expect(written).toEqual([`/cruxomni-admin apply ${second}\n`]);
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
