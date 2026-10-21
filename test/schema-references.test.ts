import { expect, test } from "bun:test";
import { verifySchemaReferences } from "../scripts/verify-contracts.ts";

test("schema reference checking distinguishes property names from schema keywords", () => {
  const path = "/schema.json";
  const schema = { $defs: { value: { type: "string" } }, properties: { $ref: { type: "string" }, normal: { $ref: "#/$defs/value" } }, const: { $ref: "literal-data" } };
  expect(() => verifySchemaReferences(new Map([[path, schema]]))).not.toThrow();
  expect(() => verifySchemaReferences(new Map([[path, { $ref: {} }]]))).toThrow("must be a non-empty string");
  expect(() => verifySchemaReferences(new Map([[path, { properties: { $ref: { $ref: "#/missing" } } }]]))).toThrow();
});
