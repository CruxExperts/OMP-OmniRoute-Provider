import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recheckUpstreams, verifyPinnedUpstreams } from "../scripts/check-upstreams.ts";

const tag = "v1.2.3";
const repository = "example/upstream";
const releaseId = 101;
const publishedAt = "2026-10-20T12:34:56Z";
const tagObject = "a".repeat(40);
const commit = "b".repeat(40);
const tree = "c".repeat(40);
const remoteSource = "{\"name\":\"pinned-upstream\"}\n";
const localSource = "local package source\n";

function gitBlobSha1(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type Fixture = {
  packageRoot: string;
  provenance: unknown;
};

async function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const packageRoot = await mkdtemp(join(tmpdir(), "check-upstreams-"));
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "src", "local.txt"), localSource);
  const provenance = {
    upstreams: [{
      id: "demo",
      repository,
      release: {
        tag,
        version: "1.2.3",
        release_id: releaseId,
        tag_ref: `refs/tags/${tag}`,
        annotated_tag_object: tagObject,
        peeled_commit: commit,
        published_at: publishedAt,
      },
      source_hashes: [
        { path: "package.json", algorithm: "git-blob-sha1", hash: gitBlobSha1(new TextEncoder().encode(remoteSource)) },
        { path: "commit-tree", algorithm: "git-tree-sha1", hash: tree },
      ],
    }],
    package_source_hashes: [{ path: "src/local.txt", algorithm: "sha256", hash: sha256(localSource) }],
  };
  try {
    return await run({ packageRoot, provenance });
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

type FetchOverrides = {
  movedTag?: boolean;
  lightweight?: boolean;
  changedSource?: boolean;
  changedTree?: boolean;
  refError?: boolean;
  releaseId?: number;
};

function mockFetch(overrides: FetchOverrides = {}): { fetchImpl: NonNullable<Parameters<typeof verifyPinnedUpstreams>[0]>; calls: string[] } {
  const calls: string[] = [];
  const currentTagObject = overrides.movedTag ? "d".repeat(40) : tagObject;
  const currentCommit = overrides.movedTag ? "e".repeat(40) : commit;
  const fetchImpl: Parameters<typeof verifyPinnedUpstreams>[0] = async input => {
    const url = String(input);
    calls.push(url);
    const pathname = new URL(url).pathname;
    const apiBase = `/repos/${repository}`;

    if (pathname === `${apiBase}/releases/tags/${tag}`) {
      return new Response(JSON.stringify({
        id: overrides.releaseId ?? releaseId,
        tag_name: tag,
        published_at: publishedAt,
        // Redirected/canonical URLs are intentionally not identity checks.
        html_url: `https://github.com/canonical-owner/upstream/releases/tag/${tag}`,
      }));
    }
    if (pathname === `${apiBase}/git/ref/tags/${tag}`) {
      if (overrides.refError) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      const object = overrides.lightweight
        ? { sha: currentCommit, type: "commit" }
        : { sha: currentTagObject, type: "tag" };
      return new Response(JSON.stringify({ ref: `refs/tags/${tag}`, object }));
    }
    if (!overrides.lightweight && pathname === `${apiBase}/git/tags/${currentTagObject}`) {
      return new Response(JSON.stringify({ object: { sha: currentCommit, type: "commit" } }));
    }
    if (pathname === `${apiBase}/git/commits/${commit}`) {
      return new Response(JSON.stringify({ tree: { sha: overrides.changedTree ? "f".repeat(40) : tree } }));
    }
    if (pathname === `/example/upstream/${commit}/package.json`) {
      return new Response(overrides.changedSource ? `${remoteSource}changed` : remoteSource);
    }
    throw new Error(`unexpected mocked fetch: ${url}`);
  };
  return { fetchImpl, calls };
}

test("pinned verification ignores Latest and canonical repository URL changes", async () => {
  await withFixture(async fixture => {
    const mocked = mockFetch();
    const result = await verifyPinnedUpstreams(mocked.fetchImpl, fixture);

    expect(result.status).toBe("verified");
    expect(mocked.calls.some(url => url.includes("/releases/latest"))).toBe(false);
    expect(mocked.calls).toContain(`https://api.github.com/repos/${repository}/releases/tags/${tag}`);
    expect(mocked.calls).toContain(`https://api.github.com/repos/${repository}/git/ref/tags/${tag}`);
    expect(JSON.stringify(result)).not.toContain("canonical-owner");
  });
});

test("a moved pinned tag is reported as drift", async () => {
  await withFixture(async fixture => {
    const result = await verifyPinnedUpstreams(mockFetch({ movedTag: true }).fetchImpl, fixture);
    const upstream = (result.upstreams as Array<{ diffs: Array<{ path: string; changed: boolean }> }>)[0]!;

    expect(result.status).toBe("drift");
    expect(upstream.diffs.some(diff => diff.path === "release.peeled_commit" && diff.changed)).toBe(true);
    expect(upstream.diffs.some(diff => diff.path === "release.annotated_tag_object" && diff.changed)).toBe(true);
  });
});

test("a lightweight pinned tag is checked directly and detects movement", async () => {
  await withFixture(async fixture => {
    const provenance = fixture.provenance as { upstreams: Array<{ release: { annotated_tag_object: string | null } }> };
    provenance.upstreams[0]!.release.annotated_tag_object = null;

    const verified = await verifyPinnedUpstreams(mockFetch({ lightweight: true }).fetchImpl, fixture);
    const moved = await verifyPinnedUpstreams(mockFetch({ lightweight: true, movedTag: true }).fetchImpl, fixture);

    expect(verified.status).toBe("verified");
    expect(moved.status).toBe("drift");
    const movedDiffs = (moved.upstreams as Array<{ diffs: Array<{ path: string; changed: boolean }> }>)[0]!.diffs;
    expect(movedDiffs.some(diff => diff.path === "release.peeled_commit" && diff.changed)).toBe(true);
  });
});

test("source hash mismatches and release metadata changes fail the pinned check", async () => {
  await withFixture(async fixture => {
    const sourceResult = await verifyPinnedUpstreams(mockFetch({ changedSource: true }).fetchImpl, fixture);
    const sourceHashes = (sourceResult.upstreams as Array<{ sourceHashes: Array<{ path: string; matches: boolean }> }>)[0]!.sourceHashes;
    expect(sourceResult.status).toBe("drift");
    expect(sourceHashes.find(hash => hash.path === "package.json")?.matches).toBe(false);
  });

  await withFixture(async fixture => {
    const result = await verifyPinnedUpstreams(mockFetch({ changedTree: true }).fetchImpl, fixture);
    const sourceHashes = (result.upstreams as Array<{ sourceHashes: Array<{ path: string; matches: boolean }> }>)[0]!.sourceHashes;
    expect(result.status).toBe("drift");
    expect(sourceHashes.find(hash => hash.path === "commit-tree")?.matches).toBe(false);
  });

  await withFixture(async fixture => {
    const releaseResult = await verifyPinnedUpstreams(mockFetch({ releaseId: releaseId + 1 }).fetchImpl, fixture);
    const diffs = (releaseResult.upstreams as Array<{ diffs: Array<{ path: string; changed: boolean }> }>)[0]!.diffs;
    expect(releaseResult.status).toBe("drift");
    expect(diffs.some(diff => diff.path === "release.release_id" && diff.changed)).toBe(true);
  });
});

test("upstream API errors fail closed", async () => {
  await withFixture(async fixture => {
    await expect(verifyPinnedUpstreams(mockFetch({ refError: true }).fetchImpl, fixture)).rejects.toThrow("HTTP 404");
  });
});

test("local package hash drift is reported", async () => {
  await withFixture(async fixture => {
    await writeFile(join(fixture.packageRoot, "src", "local.txt"), "changed local package source\n");
    const result = await verifyPinnedUpstreams(mockFetch().fetchImpl, fixture);
    const hashes = result.packageSourceHashes as Array<{ path: string; matches: boolean }>;

    expect(result.status).toBe("drift");
    expect(hashes.find(hash => hash.path === "src/local.txt")?.matches).toBe(false);
  });
});

test("API authentication stays on the API origin across canonical redirects, not raw downloads", async () => {
  const previousGh = process.env.GH_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = "test-gh-token";
  process.env.GITHUB_TOKEN = "test-fallback-token";
  try {
    await withFixture(async fixture => {
      const mocked = mockFetch();
      let redirected = false;
      const fetchImpl: NonNullable<Parameters<typeof verifyPinnedUpstreams>[0]> = async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        if (url.origin === "https://api.github.com") {
          expect(headers.get("authorization")).toBe("Bearer test-gh-token");
          expect(init?.redirect).toBe("manual");
          if (!redirected) {
            redirected = true;
            return new Response(null, { status: 301, headers: { location: `${url.pathname}?canonical=1` } });
          }
        } else {
          expect(url.origin).toBe("https://raw.githubusercontent.com");
          expect(headers.has("authorization")).toBe(false);
        }
        return mocked.fetchImpl(input, init);
      };
      expect((await verifyPinnedUpstreams(fetchImpl, fixture)).status).toBe("verified");
      expect(redirected).toBe(true);
    });
  } finally {
    if (previousGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousGh;
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousGithub;
  }
});

test("cross-origin redirects and upstream errors fail without leaking credentials", async () => {
  const previousGh = process.env.GH_TOKEN;
  const previousGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = "secret-fallback-token";
  try {
    await withFixture(async fixture => {
      let calls = 0;
      const redirectFetch: NonNullable<Parameters<typeof verifyPinnedUpstreams>[0]> = async (_input, init) => {
        calls += 1;
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-fallback-token");
        return new Response(null, { status: 302, headers: { location: "https://attacker.example/?secret=secret-fallback-token" } });
      };
      try {
        await verifyPinnedUpstreams(redirectFetch, fixture);
        throw new Error("expected redirect rejection");
      } catch (error) {
        expect(String(error)).toContain("non-API URL");
        expect(String(error)).not.toContain("secret-fallback-token");
      }
      expect(calls).toBe(1);
      const errorFetch: NonNullable<Parameters<typeof verifyPinnedUpstreams>[0]> = async () =>
        new Response(JSON.stringify({ message: "secret-fallback-token" }), { status: 403 });
      await expect(verifyPinnedUpstreams(errorFetch, fixture)).rejects.toThrow("HTTP 403");
      try {
        await verifyPinnedUpstreams(errorFetch, fixture);
      } catch (error) {
        expect(String(error)).not.toContain("secret-fallback-token");
      }
      const failingFetch: NonNullable<Parameters<typeof verifyPinnedUpstreams>[0]> = async () => {
        throw new Error("secret-fallback-token");
      };
      await expect(verifyPinnedUpstreams(failingFetch, fixture)).rejects.toThrow("GitHub API request failed");
    });
  } finally {
    if (previousGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousGh;
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousGithub;
  }
});

test("latest release selector does not receive API credentials", async () => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "selector-test-token";
  try {
    let calls = 0;
    const fetchImpl: NonNullable<Parameters<typeof recheckUpstreams>[0]> = async (input, init) => {
      calls += 1;
      if (calls === 1) {
        expect(new URL(String(input)).origin).toBe("https://github.com");
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const response = new Response("");
        Object.defineProperty(response, "url", { value: "https://github.com/example/upstream/releases/tag/v1.2.3" });
        return response;
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer selector-test-token");
      return new Response("{}", { status: 403 });
    };
    await expect(recheckUpstreams(fetchImpl)).rejects.toThrow("HTTP 403");
    expect(calls).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
  }
});
