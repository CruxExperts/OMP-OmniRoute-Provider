import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import { collectManagementPolicyResponses, collectSourceResponseEvidence } from "../scripts/source-response-hints.ts";

function parseFixture(text: string): ts.SourceFile {
  return ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe("source response hint collector", () => {
  test("keeps methods isolated and recognizes aliased NextResponse", () => {
    const source = parseFixture(`
      import { NextResponse as JsonResponse } from "next/server";
      const load = () => JsonResponse.json({ ok: true }, { status: 202, headers: { "Content-Type": "Application/Problem+JSON; charset=utf-8" } });
      const save = () => Response.json({ saved: true }, { status: 201 });
      export { load as GET, save as POST };
    `);

    expect(collectSourceResponseEvidence(source, "load", "GET", "fixture.ts").jsonResponses).toEqual([
      { method: "GET", statusCode: "202", mediaType: "application/problem+json", sourceFile: "fixture.ts" },
    ]);
    expect(collectSourceResponseEvidence(source, "save", "POST", "fixture.ts").jsonResponses).toEqual([
      { method: "POST", statusCode: "201", mediaType: "application/json", sourceFile: "fixture.ts" },
    ]);
  });

  test("does not treat arbitrary json methods or shadowed Response constructors as platform responses", () => {
    const source = parseFixture(`
      class FakeResponse { static json(value: unknown) { return value; } }
      export function GET() { return FakeResponse.json({ guessed: true }); }
      export const POST = function Response() { return Response.json({ shadowed: true }); };
      export function PUT() {
        class Response { static json(value: unknown) { return value; } }
        return Response.json({ shadowed: true });
      }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses).toEqual([]);
    expect(collectSourceResponseEvidence(source, "POST", "POST", "fixture.ts").jsonResponses).toEqual([]);
    expect(collectSourceResponseEvidence(source, "PUT", "PUT", "fixture.ts").jsonResponses).toEqual([]);
  });

  test("omits dynamic and spread status or header options instead of guessing", () => {
    const source = parseFixture(`
      export function GET(status: number) {
        return Response.json({}, { status });
      }
      export function POST(headers: Record<string, string>) {
        return Response.json({}, { headers: { ...headers } });
      }
      export function PUT(options: object) {
        return Response.json({}, { ...options });
      }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses).toEqual([]);
    expect(collectSourceResponseEvidence(source, "POST", "POST", "fixture.ts").jsonResponses).toEqual([]);
    expect(collectSourceResponseEvidence(source, "PUT", "PUT", "fixture.ts").jsonResponses).toEqual([]);
  });

  test("preserves directly returned literal status and content type", () => {
    const source = parseFixture(`
      export async function GET() {
        return await Response.json({ error: true }, { status: 422, headers: { "Content-Type": "application/problem+json; charset=utf-8" } });
      }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses).toEqual([
      { method: "GET", statusCode: "422", mediaType: "application/problem+json", sourceFile: "fixture.ts" },
    ]);
  });

  test("follows returned local helpers and conditional helper paths but skips nested unreturned functions", () => {
    const source = parseFixture(`
      import { NextResponse } from "next/server";
      export async function GET(request: Request) {
        const id = new URL(request.url).searchParams.get("id");
        if (id === null) return NextResponse.json({ list: true });
        return getSingle(id);
      }
      async function getSingle(id: string) {
        if (!id.trim()) return NextResponse.json({ error: true }, { status: 400 });
        return id === "missing"
          ? getMaterialized(id)
          : NextResponse.json({ error: true }, { status: 409 });
      }
      function getMaterialized(id: string) {
        function unrelated() {
          return NextResponse.json({ guessed: true }, { status: 418 });
        }
        if (id === "missing") return NextResponse.json({ error: true }, { status: 404 });
        return NextResponse.json({ id });
      }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses.map(response => response.statusCode))
      .toEqual(["200", "400", "404", "409"]);
  });

  test("bounds returned helper cycles and excludes unrelated helper outcomes", () => {
    const source = parseFixture(`
      import { NextResponse } from "next/server";
      export function GET() { return first(); }
      function first() {
        if (Math.random()) return NextResponse.json({}, { status: 410 });
        return second();
      }
      function second() {
        if (Math.random()) return NextResponse.json({}, { status: 404 });
        return first();
      }
      function unrelated() { return NextResponse.json({}, { status: 418 }); }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses.map(response => response.statusCode))
      .toEqual(["404", "410"]);
  });

  test("does not follow a top-level helper shadowed by a handler parameter or local binding", () => {
    const source = parseFixture(`
      export function GET(helper: () => Response) { return helper(); }
      export function POST() {
        const helper = () => Response.json({}, { status: 422 });
        return helper();
      }
      function helper() { return Response.json({}, { status: 418 }); }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses).toEqual([]);
    expect(collectSourceResponseEvidence(source, "POST", "POST", "fixture.ts").jsonResponses).toEqual([]);
  });

  test("does not follow a local helper whose binding is reassigned", () => {
    const source = parseFixture(`
      export function GET() {
        helper = () => Response.json({}, { status: 422 });
        return helper();
      }
      function helper() { return Response.json({}, { status: 418 }); }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").jsonResponses).toEqual([]);
  });

  test("recognizes only returned imported guards, including direct and initialized returns", () => {
    const source = parseFixture(`
      import { requireManagementAuth as managementGate } from "@/lib/api/requireManagementAuth";
      import { rejectRetiredCommonChatGptWebProvider as retiredGate } from "@/lib/providers/chatgptWebRetirementResponse";
      export async function GET(request: Request) {
        const authError = (await managementGate(request)) ?? null;
        if (authError) return authError;
        return Response.json({ ok: true });
      }
      export async function POST(request: Request) {
        return await retiredGate(request);
      }
      export async function OPTIONS(request: Request) {
        await managementGate(request);
        return Response.json({ options: true });
      }
      export async function HEAD() {
        return managementGate;
      }
      export async function PUT(request: Request, managementGate: (request: Request) => Response | null) {
        return managementGate(request);
      }
      export async function PATCH(request: Request) {
        let authError = await managementGate(request);
        authError = null;
        if (authError) return authError;
      }
      export async function DELETE(request: Request) {
        const retired = retiredGate(request) ?? retiredGate(request);
        if (retired) return retired;
        return Response.json({ ok: true });
      }
    `);

    expect(collectSourceResponseEvidence(source, "GET", "GET", "fixture.ts").returnedImportedCalls).toEqual([
      {
        localName: "managementGate",
        importedName: "requireManagementAuth",
        moduleSpecifier: "@/lib/api/requireManagementAuth",
      },
    ]);
    expect(collectSourceResponseEvidence(source, "POST", "POST", "fixture.ts").returnedImportedCalls).toEqual([
      {
        localName: "retiredGate",
        importedName: "rejectRetiredCommonChatGptWebProvider",
        moduleSpecifier: "@/lib/providers/chatgptWebRetirementResponse",
      },
    ]);
    expect(collectSourceResponseEvidence(source, "OPTIONS", "OPTIONS", "fixture.ts").returnedImportedCalls).toEqual([]);
    expect(collectSourceResponseEvidence(source, "HEAD", "HEAD", "fixture.ts").returnedImportedCalls).toEqual([]);
    expect(collectSourceResponseEvidence(source, "PUT", "PUT", "fixture.ts").returnedImportedCalls).toEqual([]);
    expect(collectSourceResponseEvidence(source, "PATCH", "PATCH", "fixture.ts").returnedImportedCalls).toEqual([]);
    const retired = collectSourceResponseEvidence(source, "DELETE", "DELETE", "fixture.ts").returnedImportedCalls;
    expect(retired.map(call => ({ importedName: call.importedName, moduleSpecifier: call.moduleSpecifier }))).toEqual([
      { importedName: "rejectRetiredCommonChatGptWebProvider", moduleSpecifier: "@/lib/providers/chatgptWebRetirementResponse" },
    ]);
  });
  test("enumerates only finite literal leaves in returned management rejection statuses", () => {
    const fixture = `
      import { reject } from "../context";
      const managementPolicy = {
        evaluate(ctx: { initial: boolean; bearerPresent: boolean }) {
          if (ctx.initial) return reject(403, "LOCAL_ONLY");
          return reject(ctx.bearerPresent ? 403 : 401, "AUTH_001");
        }
      };
    `;
    const source = parseFixture(fixture);
    const lineOf = (text: string): number => {
      const position = fixture.indexOf(text);
      expect(position).toBeGreaterThanOrEqual(0);
      return source.getLineAndCharacterOfPosition(position).line + 1;
    };

    expect(collectManagementPolicyResponses(source, "fixture.ts")).toEqual([
      { statusCode: "401", sourceFile: "fixture.ts", line: lineOf("return reject(ctx.bearerPresent") },
      { statusCode: "403", sourceFile: "fixture.ts", line: lineOf("return reject(403") },
    ]);
  });

  test("rejects conditional management statuses with any dynamic leaf", () => {
    const source = parseFixture(`
      import { reject } from "../context";
      const managementPolicy = {
        evaluate(ctx: { fallback: boolean; dynamicStatus: number }) {
          return reject(ctx.fallback ? 403 : ctx.dynamicStatus, "AUTH_001");
        }
      };
    `);

    expect(() => collectManagementPolicyResponses(source, "fixture.ts"))
      .toThrow("management policy reject status has a non-literal conditional leaf");
  });
});
