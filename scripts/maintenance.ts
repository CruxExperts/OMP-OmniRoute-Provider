import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Finding = { findingId: string; title: string; detail: string };
type Issue = { number: number; state: string; body: string | null };
export interface IssueApi {
  list(): Promise<Issue[]>;
  create(title: string, body: string, labels: string[]): Promise<void>;
  update(number: number, body: string): Promise<void>;
}
export interface CollectionResult {
  findings: Finding[];
  collectionErrors: string[];
}
export interface MaintenanceCollectors {
  releaseTag(repository: string): Promise<string>;
  checkGeneratedDocs(root: string): Promise<void>;
}
const marker = (key: string): string => `<!-- cruxomni-maintenance:${createHash("sha256").update(key).digest("hex")} -->`;
const maintenanceLabels = ["maintenance", "automation"];

/** An uncertain create is observed once, never blindly replayed. */
export async function reconcileFinding(api: IssueApi, finding: Finding): Promise<"created" | "updated" | "unchanged" | "reconciled"> {
  const token = marker(finding.findingId);
  const body = `${token}\n\n${finding.detail}\n\nThis is an automated observation. Review source evidence before making changes. Implementation, merging, and releases require review.`;
  const matching = (await api.list()).filter(issue => issue.body?.startsWith(`${token}\n`));
  if (matching.length > 1) throw new Error("Duplicate owned maintenance issues require reconciliation");
  if (matching[0]) {
    if (matching[0].state === "open" && matching[0].body === body) return "unchanged";
    await api.update(matching[0].number, body);
    return "updated";
  }
  try {
    await api.create(finding.title, body, maintenanceLabels);
    return "created";
  } catch {
    const observed = (await api.list()).filter(issue => issue.body?.startsWith(`${token}\n`));
    if (observed.length === 1) return "reconciled";
    throw new Error("Issue creation outcome is uncertain; no automatic replay was performed");
  }
}

function githubApi(repository: string): IssueApi {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository identity");
  const request = (method: string, endpoint: string, payload?: unknown): unknown => {
    try {
      const args = ["api", "--method", method, endpoint];
      if (payload !== undefined) args.push("--input", "-");
      const response = execFileSync("gh", args, { input: payload === undefined ? undefined : JSON.stringify(payload), encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
      return JSON.parse(response);
    } catch { throw new Error("GitHub request failed or was interrupted; inspect the workflow privately before retrying"); }
  };
  return {
    async list() {
      const issues: Issue[] = [];
      for (let page = 1; page <= 50; page++) {
        const rows = request("GET", `repos/${repository}/issues?state=all&per_page=100&page=${page}`);
        if (!Array.isArray(rows)) throw new Error("Invalid issue inventory");
        for (const row of rows) {
          if (row && row.user?.login === "github-actions[bot]" && !row.pull_request && Number.isSafeInteger(row.number) && typeof row.state === "string" && (row.body === null || typeof row.body === "string")) issues.push(row as Issue);
        }
        if (rows.length < 100) return issues;
      }
      throw new Error("Issue inventory exceeds the bounded scan; refusing to create possible duplicates");
    },
    async create(title, body, labels) { request("POST", `repos/${repository}/issues`, { title, body, labels }); },
    async update(number, body) { request("PATCH", `repos/${repository}/issues/${number}`, { body, state: "open" }); },
  };
}

async function releaseTag(repository: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (!response.ok) throw new Error("Upstream release lookup failed");
  const value = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof value.tag_name !== "string" || !/^v?\d+\.\d+\.\d+$/.test(value.tag_name) || value.draft || value.prerelease) throw new Error("Upstream latest release is not a stable version");
  return value.tag_name;
}

const upstreamsById: Record<string, { provenanceRepository: string; latestRepository: string }> = {
  omp: { provenanceRepository: "can1357/oh-my-pi", latestRepository: "can1357/oh-my-pi" },
  omniroute: { provenanceRepository: "diegosouzapw/OmniRoute", latestRepository: "cheaper-inference/OmniRoute" },
};

const defaultCollectors: MaintenanceCollectors = {
  releaseTag,
  async checkGeneratedDocs(root) {
    execFileSync("bun", ["run", "scripts/generate-docs.ts", "--check"], { cwd: root, timeout: 30_000, stdio: "pipe" });
  },
};

export async function collectFindings(root: string, collectors: MaintenanceCollectors = defaultCollectors): Promise<CollectionResult> {
  const findings: Finding[] = [];
  const collectionErrors: string[] = [];
  const upstreams = JSON.parse(readFileSync(resolve(root, "provenance/upstreams.json"), "utf8")) as { upstreams: Array<{ id: string; repository: string; release: { tag: string } }> };
  for (const pin of upstreams.upstreams) {
    const source = Object.hasOwn(upstreamsById, pin.id) ? upstreamsById[pin.id] : undefined;
    if (!source || source.provenanceRepository !== pin.repository || !/^v?\d+\.\d+\.\d+$/.test(pin.release.tag)) {
      collectionErrors.push(`upstream:${source ? pin.id : "unknown"}`);
      continue;
    }
    try {
      const observed = await collectors.releaseTag(source.latestRepository);
      if (observed !== pin.release.tag) findings.push({ findingId: `upstream:${pin.id}`, title: `Maintenance: refresh ${pin.id} compatibility evidence`, detail: `The immutable provenance pin is ${pin.release.tag} from ${pin.repository}; GitHub Latest for its canonical repository ${source.latestRepository} reports ${observed}. The repository move does not change the pinned source artifact.\n\nReview whether to refresh the immutable source pin and affected contracts, qualification, notices, and documentation. A version observation does not authorize an upgrade or release.\n\nSource: https://github.com/${source.latestRepository}/releases/latest` });
    } catch {
      // Keep observation failures private and continue checking independent sources.
      collectionErrors.push(`upstream:${pin.id}`);
    }
  }
  try {
    await collectors.checkGeneratedDocs(root);
  } catch {
    findings.push({ findingId: "documentation:generated", title: "Maintenance: generated documentation needs review", detail: "The deterministic documentation check did not pass on the trusted default branch. Review the owning sources and regenerate documentation. Raw diagnostics are intentionally excluded from this issue." });
  }
  return { findings, collectionErrors };
}

export async function reconcileCollectedFindings(api: IssueApi, result: CollectionResult): Promise<void> {
  for (const finding of result.findings) await reconcileFinding(api, finding);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  if (process.argv[2] === "failure") {
    if (process.env.CRUXOMNI_MAINTENANCE_ENABLED !== "true") throw new Error("Maintenance publication is not enabled");
    const repository = process.env.GITHUB_REPOSITORY ?? "";
    const run = process.env.MAINTENANCE_FAILURE_RUN ?? "";
    if (!/^\d+$/.test(run)) throw new Error("Invalid workflow run ID");
    const finding = { findingId: "ci:default-branch", title: "Maintenance: default-branch validation failed", detail: `A trusted default-branch validation run failed. Inspect https://github.com/${repository}/actions/runs/${run} and reproduce the failure before applying a fix. Logs and security-sensitive diagnostics must remain out of public issues.` };
    await reconcileFinding(githubApi(repository), finding);
  } else {
    const result = await collectFindings(root);
    if (process.argv.includes("--apply")) {
      if (process.env.CRUXOMNI_MAINTENANCE_ENABLED !== "true") throw new Error("Maintenance publication is not enabled");
      const api = githubApi(process.env.GITHUB_REPOSITORY ?? "");
      await reconcileCollectedFindings(api, result);
    }
    console.log(JSON.stringify({ status: result.collectionErrors.length ? "incomplete" : "observed", findings: result.findings.map(finding => ({ findingId: finding.findingId, title: finding.title })), collectionErrors: result.collectionErrors, published: process.argv.includes("--apply") }));
    if (result.collectionErrors.length) process.exitCode = 1;
  }
}
