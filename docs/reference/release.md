# Release preparation and approval

`VERSION` is the canonical package version. `bun run scripts/version.ts check`
checks it against `package.json` and `.omp-plugin/marketplace.json`, and
`bun run scripts/version.ts set X.Y.Z` updates all three files together.

`bun run scripts/version.ts plan` plans from the latest `vX.Y.Z` tag, or from
all commits when no release tag exists. It rejects an empty batch. Commits
without a `Release-Type` trailer default to a patch bump. `Release-Type: none`
contributes no bump; merge commits and version-only synchronization commits are
excluded. A revert cancels its target only when a single-parent raw Git diff
proves the exact inverse and no intervening commit changed the same paths.
Ambiguous reverts remain in the plan as ordinary commits. A breaking marker
requires `Release-Type: major`. The bump base is the validated `VERSION` at the
latest reachable release tag, or the root commit's `VERSION` before the first
tag. Setting and committing a proposed version does not count the same changes
again as an extra bump on the next plan.

## Export a reviewed source snapshot

`bun run scripts/export-release.ts` requires a clean Git worktree, tracked
release inputs, and bytes matching the current `HEAD`. The manifest records the
full source commit. The exporter builds in a fresh sibling directory, verifies
that the output contains exactly the five manifest artifacts plus
`SHA256SUMS.txt` and `release-manifest.json`, then replaces the output directory
atomically. A failed build leaves an existing output directory in place.

The fifth artifact, `CruxOmni-OMP-Client-v<VERSION>-release-notes.md`, is an
exact byte copy of the reviewed `CHANGELOG.md`. Its hash is part of the release
manifest and approval receipt. The release workflow uses this exact file as the
GitHub Release description when it creates the draft and resets the description
from the same file immediately before publishing.

Package verification applies a portable tar member preflight before extracting
an archive. It rejects traversal, links, duplicate and Windows-ambiguous names,
special files, and entries outside the package allowlist. Cross-platform smoke
jobs receive the one prepared `.tgz` archive together with its expected SHA-256;
the verifier hashes and stages those exact bytes without modifying the caller's
archive. Packed package name and version must match the reviewed source manifest.

The release manifest says the assets are `prepared` for GitHub Releases and
npm. It is not a publication receipt. The workflow does not run on tag pushes;
an existing signed tag alone cannot publish a release.

## Qualification receipt

Before manual publication, prepare a reviewed JSON qualification receipt with
this shape:

```json
{
  "schemaVersion": 1,
  "release": {
    "version": "<VERSION>",
    "sourceRevision": "<40-character commit SHA>"
  },
  "producer": {
    "repository": "<owner/repository>",
    "runId": "<GitHub workflow run ID>",
    "workflowPath": ".github/workflows/qualification.yml",
    "workflowName": "release-qualification",
    "workflowSha256": "<SHA-256 of the workflow file at sourceRevision>"
  },
  "packageArchiveSha256": "<SHA-256 of the manifest .tgz artifact>",
  "targets": [
    {
      "id": "linux-x64-glibc",
      "status": "passed",
      "version": "<VERSION>",
      "sourceRevision": "<same 40-character commit SHA>",
      "archiveSha256": "<same package archive SHA-256>",
      "evidenceRef": "evidence/linux-x64-glibc.json",
      "evidenceSha256": "<SHA-256 of that target evidence>"
    }
  ]
}
```

The `targets` array must contain exactly these eight IDs: `linux-x64-glibc`,
`linux-arm64-glibc`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`,
`darwin-arm64`, `windows-x64`, and `windows-arm64`. Every target must report
`passed`, the manifest version and source commit, and the exact same npm archive
hash as the release manifest. Each target must provide a safe relative path to
a regular JSON evidence file beside the receipt, plus the SHA-256 of its actual
bytes. Evidence files are limited to 1 MiB and must repeat the target ID,
`passed` status, version, source commit, and archive hash. Evidence paths cannot
contain symlinks or leave the qualification bundle.

Each evidence file is a JSON object with `schemaVersion: 1`,
`recordKind: "omniroute-target-qualification"`, and the same `id`, `status`,
`version`, `sourceRevision`, and `archiveSha256` fields as its receipt entry.
It also records the producer repository, run ID, workflow path and name, the
workflow-file digest, and the exact target job name. `host` must identify the
expected native OS, architecture, and Linux libc. `smoke` contains the exact
command naming the package archive, exit code zero, captured non-empty output
and its digest, plus `install-package` and `package-smoke` checks with passed
status, captured output, and matching output digests. The target-specific run
must retain the native outputs so the receipt can be checked against their
actual bytes.

The qualification bundle is uploaded as the exact artifact
`cruxomni-release-qualification` from the successful same-repository
`release-qualification` workflow at `.github/workflows/qualification.yml` for
the same source commit. GitHub Actions must report exactly one completed,
successful job named for each supported target. The release workflow checks the
run name, workflow path, event, repository, source commit, job conclusions,
artifact owner, and producer metadata before downloading the bundle. It contains
`qualification-receipt.json` and the referenced `evidence/*.json` files. The
files must retain those paths in the artifact. The release gate verifies each
evidence file's bytes against the receipt and checks the native smoke fields.

The `release-qualification` workflow is manual-only. It prepares the package
once, runs source, contract, and documentation checks, then downloads and tests
that exact archive on native glibc Linux, macOS, and Windows x64/arm64 hosts.
Each target downloads the pinned OMP binary and checksum file recorded in
provenance, checks both digests and the checksum entry, and retains actual smoke
output. The aggregate step validates the output bytes and identity before it
writes the receipt and evidence bundle. The release gate also checks the
successful workflow run and all eight native job names.

The workflow currently fails closed on `linux-x64-musl` and
`linux-arm64-musl`. The official Bun 1.4.2 Alpine image has been inspected by
immutable layer digest on both architectures. Its original OpenSSL and zlib
packages have known advisories, so that unmodified image is unsuitable for
qualification. The image also lacks Git and Python, which the qualification
scripts require.

A remediation candidate uses authenticated Alpine package indexes and frozen
package archives for the required tools and fixes. Its proposed final inventory
has been checked against OSV, National Vulnerability Database records for the
original findings, and the CISA Known Exploited Vulnerabilities catalog, with
Alpine's security database providing fixed-version evidence. These checks have
different coverage and do not establish the absence of every vulnerability.
An isolated x64 build installs without network access or package scripts; its
actual installed inventory matches the reviewed package closure. This is
runtime preparation, not client or platform qualification.

The jobs remain blocked until the immutable runtime inputs and their verification
are integrated into the owning workflow, and both architectures run the same
prepared client archive natively. The jobs cannot produce passing evidence
until those checks execute. Synthetic test fixtures and a successful image
build do not qualify a release.

Operation coverage is read from `contracts/operations.json` and
`contracts/release-eligibility.json`, not inferred from a short list in the
receipt. Every invokable operation needs its verified, source-bound evidence.
Every non-invokable operation needs a source file, source hashes, and a reason.
Any operation whose coverage remains `unqualified`, or whose invokable evidence
is missing, blocks approval. A receipt for only the currently verified
operation subset does not satisfy the full operation inventory.

On a clean checkout of the tagged commit, create release assets and calculate
the exact approval receipt:

```sh
bun run scripts/export-release.ts
bun run scripts/release-gate.ts receipt release /path/to/qualification-receipt.json
```

The command prints `approvalReceiptSha256`, which binds the exact bytes of both
`release-manifest.json` and the qualification receipt; the manifest in turn
binds the versioned release notes to `CHANGELOG.md`. To verify the digest
before dispatching the workflow:

```sh
bun run scripts/release-gate.ts approve release /path/to/qualification-receipt.json <approvalReceiptSha256>
```

The gate checks all artifact hashes, rejects stale or unmanifested files, binds
the receipt to the clean tagged commit, checks all eight targets against the
same npm archive, and blocks on unqualified operation coverage. It reports
`ready-for-protected-approval`; this is a pre-publication result, not evidence
that anything has been published.

## Compare development performance

Use a separate baseline checkout with the same installed SDKs and toolchain:

```sh
bun scripts/benchmark.ts <baseline-checkout> <report.json>
```

The report binds both source trees, records five isolated-process samples after
one warmup, and compares medians for module startup, administration registry
loading, process memory, fixture discovery, and package size. Discovery projects
1,000 local fixture models and excludes network latency; module imports do not
measure interactive startup. Keep the report with release evidence, record the
baseline revision, and investigate regressions rather than treating noisy local
timings as platform qualification.

## Manual publication

Run the `signed-release` workflow with the existing signed tag, the exact
`approvalReceiptSha256`, and the successful qualification workflow run ID. The
workflow validates the tag and source commit signatures in both jobs, retrieves
the producer’s exact package and manifest, checks the qualification bundle and
all eight named native jobs, and
verifies the receipt before it reaches the `release` environment. The publish
job repeats these checks after environment approval, uploads the manifest-listed
package artifacts plus the manifest, checksums, approval records, and
qualification evidence archive, publishes the matching npm archive, verifies
the receipt again, resets the draft's notes from the approved notes artifact,
and then publishes the GitHub release.

The repository must configure the `release` environment with at least one
required reviewer and an `NPM_TOKEN` environment secret before publication can
be authorized. Both release jobs query the actual GitHub environment API and
validate its `name` and `protection_rules` response; this catches an absent or
unprotected environment before preparation can proceed. The publish job repeats
the check when it starts and verifies that `NPM_TOKEN` is non-empty before it
creates a GitHub draft. These protections are repository settings
and cannot be established by this workflow file alone. The API check follows
GitHub's [deployment environments endpoint and response schema](https://docs.github.com/en/rest/deployments/environments#get-an-environment).
A failure after npm publication or draft release creation can leave one
destination prepared or published; reconcile the exact tag and package version
before retrying.

No receipt in this document or in the release automation qualifies version
`1.0.0` by itself. Qualification requires the matching external target evidence
and complete operation coverage described above.
