import { expect, test } from "bun:test";
import {
  availableOperationMenuPattern,
  createDialogueScheduler,
  hasNativeAvailableOperationDescription,
  nativeAdminPromptPattern,
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
  ], step => {
    written.push(nativePtyDialogueText(step.text));
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
  ], async step => {
    written.push(step.text);
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
