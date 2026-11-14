import { describe, expect, it } from "bun:test";
import { fetchReviewedApk } from "../scripts/qualify-release.ts";

const sha256Hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function response(url: string, status: number, body: string | null): Response {
  const result = new Response(body, { status });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

describe("reviewed Alpine APK acquisition", () => {
  for (const [architecture, filename] of [
    ["x86_64", "c-ares-1.34.8-r0.apk"],
    ["aarch64", "brotli-libs-1.1.0-r2.apk"],
  ] as const) {
    it(`uses the retained mirror after a 404 for ${architecture}`, async () => {
      const origin = `https://dl-cdn.alpinelinux.org/alpine/v3.22/main/${architecture}/${filename}`;
      const mirror = `https://repo.huaweicloud.com/alpine/v3.22/main/${architecture}/${filename}`;
      const requests: string[] = [];
      const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        const url = String(input);
        requests.push(url);
        return url === origin ? response(url, 404, null) : response(url, 200, "hello");
      }) as typeof fetch;
      expect((await fetchReviewedApk(new URL(origin), 5, sha256Hello, filename, fetcher)).toString()).toBe("hello");
      expect(requests).toEqual([origin, mirror]);
    });
  }

  it("rejects mirror bytes that do not match the recorded digest", async () => {
    const origin = "https://dl-cdn.alpinelinux.org/alpine/v3.22/main/x86_64/c-ares-1.34.8-r0.apk";
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      return url === origin ? response(url, 404, null) : response(url, 200, "other");
    }) as typeof fetch;
    await expect(fetchReviewedApk(new URL(origin), 5, sha256Hello, "c-ares", fetcher)).rejects.toThrow("bytes differ from provenance");
  });

  it("does not use the mirror for non-404 failures", async () => {
    const origin = "https://dl-cdn.alpinelinux.org/alpine/v3.22/main/aarch64/brotli-libs-1.1.0-r2.apk";
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return response(url, 503, null);
    }) as typeof fetch;
    await expect(fetchReviewedApk(new URL(origin), 5, sha256Hello, "brotli-libs", fetcher)).rejects.toThrow("HTTP 503");
    expect(requests).toEqual([origin]);
  });
});
