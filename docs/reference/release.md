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

## 1.0.x GitHub distribution

Versions `1.0.0`, `1.0.1`, `1.0.2`, and `1.0.3` are distributed through GitHub Releases and signed
GitHub source tags. These releases do not publish to npm or claim complete operation and
eight-platform qualification. The original `v1.0.0` tag and its release assets
are immutable. Version `1.0.1` changes the OMP `/login` provider selector label
to **Crux OmniRoute Provider**, supports an explicit profile-scoped switch from
runtime environment variables to a newly entered native endpoint and key, and
makes `/omniroute`, `/omniroute-admin`, and `/omniroute-pricing` the primary
commands while keeping the former names as aliases. Model names and native
credentials continue to use provider ID `omniroute`.

Version `1.0.2` validates API keys through the protected authentication route,
accepts guided endpoint input for local and remote hosts, and separates initial
checking and verified catalogs without compatible chat models from failures.

Version `1.0.3` separates immutable upstream integrity checks from latest-release
monitoring, adds OMP 18.12.6 to the host smoke matrix, and refreshes contributor
and installation guidance. Its OMP source and development SDK pins remain at
18.12.5; compatibility testing does not assert a source upgrade. The reviewed
maintenance decision remains valid only for that exact host/source pair and its
supporting artifact record. The 1.0.3 release required the package job and all
three host-smoke jobs, including 18.12.6, to pass for its final source commit.
The additional job has not been added to branch protection's required contexts.

Version `1.0.4` adds explicit pending-connection recovery, session-safe
inference bindings, source and catalog diagnostics, and OMP 18.16.0 host
coverage while retaining the 18.12.5 source and SDK pins. The package job and
all four host-smoke jobs must pass against the final source commit, and the
final archive must receive its own verification before release. Publication
requires those final receipts; the intermediate 18.16.0 smoke does not satisfy
them. Distribution uses GitHub only, with no npm publication or global
OMP installation. No inference or administration write is automatically
replayed after an uncertain outcome.

The 1.0.x release notes disclose the limited qualified operation set and
platform evidence. Versions `1.0.2` and `1.0.3` carry no eight-platform qualification
receipt: evidence for earlier source and package archives does not qualify a new
archive. Version `1.0.4` likewise has no eight-platform qualification
receipt. The operation eligibility guards stay enabled, and the current coverage
limits must remain visible in release notes.

These GitHub-only releases use the existing clean-source exporter, reviewed
notes, signed source commit and annotated tag, exact-archive verification, native
smoke, and public download checksum checks. The export manifest remains a
preparation record: its `github-release-and-npm` target is not a receipt for npm
publication. The GitHub Release and public asset hashes establish what was
actually published.

The exporter compares each tracked file with its committed Git bytes using a
streamed SHA-256 digest. Large generated contracts do not require buffering a
second full copy of each Git blob or raising subprocess output limits. A
failed Git read or mismatched digest still rejects the export.
Package verification measures decoded TypeScript and JavaScript string literals
when checking entropy, so an escaped NUL delimiter is not mistaken for random
credential material. Escaped high-entropy values remain rejected.
Isolated ingress failures export only bounded categories for missing modules,
read-only output, denied permissions, compiler panic, configuration loading,
type errors, or process creation. Unknown failures remain unclassified; raw
compiler messages and private paths are not uploaded.

The stricter fully qualified npm/GitHub workflow below remains unchanged. Do not
rerun that workflow against the already published `v1.0.0` tag or replace its
immutable version with different bytes. Later publications use a new version
and the applicable qualification requirements.

## 1.0.5 release candidate

Version `1.0.5` adds buffered inference recovery with five total attempts and a
30-second delay by default. Both settings are configurable. Incoming events are
drained independently of the response consumer; failed partial generations and
their speculative tool calls are discarded before a fresh attempt.

Successful buffered messages publish their content lifecycle before the terminal
event. A terminal-only tool message can be interpreted as an empty response by
the host's replay-safe wrapper. Qualification must observe a real read result in
the subsequent request, not merely the presence of a tool call in the final model
message. Linux x64 glibc smoke against the pinned OMP `18.12.5` release asset
observed that read and continuation after this repair; other platforms still
require their own native results for the final archive.

An isolated Linux x64 check using the official `18.12.5` host and the source
extension observed a dropped response, a refused connection while the fixture
gateway was down, and recovery after a 30.032-second default retry wait. The
original user prompt was unchanged, failed-attempt text remained hidden, and
one native file read supplied its real result to the continuation request.
This is source-extension evidence, not qualification of the final package
archive or of another operating system.

Archive verification compares canonical package-directory identities rather than
lexical path spellings. This preserves destination and symlink checks while
handling macOS temporary-directory aliases and native Windows normalization.

Windows profile configuration requires a protected native access-control list,
not POSIX file-mode bits. Only the current user, SYSTEM, and Administrators are
trusted; inherited broad access and symbolic links remain rejected. Native
Windows smoke must exercise this protection and the real login lifecycle.

The login smoke completes `/login` with Tab and waits for the rendered argument
hint before sending Enter. Native Windows observations showed that Enter on the
open command completion changed `/login` to `/login ` without opening provider
selection. Completing the command explicitly avoids treating that transition as
submission; no extra Enter is sent blindly.
The research trace localized a pending startup wait to saving the optional setup
invitation preference; it did not identify the particular filesystem or Windows
access-control subprocess responsible. This informational save now runs outside
startup. Configuration-consuming commands cancel it and wait for transaction
cleanup before reading configuration; a stuck transaction remains unavailable,
not bypassed. Official, unmodified Windows x64 and arm64 qualification remains
required for the corrected source.
The setup smoke recognizes the explicit `yes/no` hint when a native terminal
redraw places its erase marker and box border directly after the word `no`.
It still requires the full environment-to-native confirmation and fail-closed
credential warning before sending the fixture's affirmative response.
The native ACL diagnostic subsequently localized a failure to loading `Get-Acl`
inside Windows PowerShell. Permission reads now use the framework APIs directly;
the actual creation and verification helpers passed on x64 and arm64. An official
login run still found the canceled invitation transaction settling. Cancellation
now reaches each ACL child, and configuration ownership remains held until that
process closes, including when its abort callback precedes process exit. These
diagnostics establish the corrected boundaries, not final native acceptance.
The arm64 runtime comparison passed the same ACL helper from PowerShell, including
under the Bun test runner, but timed out under Bun tests launched from Git Bash.
The native configuration test step therefore uses PowerShell without removing
tests or increasing their timeout. The official x64 login subsequently reached
API-key validation but did not finish setup. The bounded diagnostic now records
fixture verification/model-request completion and closure during that setup;
these observations do not establish a cause or replace native acceptance.
Both official Windows architectures subsequently completed the fixture's key
verification and model-list HTTP responses, while setup still timed out. The
research-only scenario now exercises that setup path and captures progress and
activation-refresh entry/completion markers before stopping its owned terminal.
Missing completion can also mean rejection; completed fixture responses do not
alone establish that validation, configuration persistence, or activation finished.
The provider overlay is restricted to three disposable installed sources, as described below.
The host-side research sink accepts the added setup markers 41–44 explicitly;
an actual patched-module probe rejected adjacent unsupported markers, strings,
and fractional values. This fixes trace delivery, not the Windows setup stall.
The baseline gate accepts either the original submission failure or the observed
setup timeout after both fixture validation responses completed. A successful
setup, another dialogue stage, or missing validation responses does not satisfy
the setup-failure gate; the selected reproduction is recorded before tracing.
Both the builder and instrumented-scenario wrapper enforce that same setup
reproduction boundary. A wrapper mismatch previously prevented instrumentation
from starting; that failure was not evidence of an instrumented-host crash.
Research command failures retain only their exit/timeout classification, not raw
output; a bounded scenario record is written before checking host startup.

The Windows native setup smoke retains its 75-second UI and network allowance
and budgets up to 28 sequential private-ACL helpers at 30 seconds each, for
915 seconds total. The original 15 cover setup through the pre-persistence
refresh. After native credential persistence, activation can require 11 more:
two binding reads, one recovery read, one commit read, six write checks, and
one post-commit read. A separately executed manual refresh can add two reads.
Individual helper limits, security checks, and other platforms' deadlines do
not change.

Host login success reports credential persistence, not completed activation.
The smoke sends one manual refresh and waits for the provider's native-profile
`catalog ready` notification with nonzero chat-model and live-row counts before
stopping the owned terminal. Pending, unavailable, or environment-sourced
readiness is not completion. The provider's binding synchronization compares
the saved native key with the staged candidate, validates the live catalog,
commits the pending configuration, and reloads it before native readiness can
report this state. If completion is not observed, the smoke fails at its outer
deadline; there is no timed success or extra login Enter.

Official run `42981036057` completed setup on both Windows architectures but
the subsequent persisted Chat Completions command reached its 20-second outer
deadline. Its login diagnostic records completed setup requests, not the cause
of that later timeout. A successful persisted-profile startup can perform five
sequential configuration reads: one at registration, two around credential
resolution in the startup refresh, and two in the session refresh. Each read
checks the directory and file together in one Windows ACL child, bounded at 30
seconds. The startup credential lookup has its own 10-second cancellation;
that signal does not bound the configuration reads. The persisted inference
smoke therefore retains its 20-second command allowance and adds `5 * 30`
seconds on Windows only, for 170 seconds. This is an outer allowance, not a
change to ACL limits, credential validation, or security checks. Environment
inference and other platforms retain their existing deadlines. These source
bounds do not prove the observed timeout's cause or qualify either platform.

In run `42982723874` at `a29a9cf`, both Windows architectures reached host
login success but the later persisted inference exited with activation pending
and the model unavailable, rather than timing out. The former six-second stop
after sending refresh could interrupt activation, but that run alone does not
prove the interruption caused its failure. The completion gate above must be
exercised on the unmodified official hosts and exact final archive; this change
is not platform qualification.


In the instrumented Windows research run `42974498638`, helper 1 ran from
5,773 to 31,221 ms and helper 2 from 31,223 to 53,722 ms, both within their
individual limits. Helper 3 started at 53,723 ms and was still pending at
74,845 ms, shortly before the 75,001 ms outer expiry. No dropped or overflowed
observations were reported. This supports cumulative outer-budget clipping,
not a demonstrated deadlock or a reason to increase production helper limits.
The observation does not establish that the remaining helpers complete: only
successful official native Windows jobs for the final archive can supply that
qualification evidence.

When native Windows login stalls after command rendering, manually run
`windows-input-diagnostic.yml` to compare terminal transport with the pinned host.
The transport jobs send only fixture `/login` text and one carriage return to an
owned raw-mode console child, then upload bounded hexadecimal input and decoded
key fields. The child restores its input mode before exiting. Missing input,
timeout, or truncation fails the transport diagnostic. Separate native-host jobs
use the existing package exporter and target preparation, with
`OMP_SMOKE_LOGIN_DIAGNOSTIC_PATH` enabling read-only observations around the real
terminal Enter. Only allowlisted state is uploaded; raw editor values are not.
Neither diagnostic replaces any native qualification result.

The diagnostic's `acl_only` input runs a bounded PowerShell input/EOF handshake
and the actual private-directory and file ACL helpers on both Windows
architectures. It records phase status and duration only, not paths, ACL contents,
or credentials. This isolates persistence failures without repeating the full
login smoke and never supplies qualification evidence.
With `acl_only`, the same helper also runs in isolated Bun CLI and Bun test
processes under both Bash and PowerShell. Each comparison writes only bounded
phase, timing, and fixed-stage failure fields. This distinguishes shell/runtime
transport failures without increasing the helper's timeout or changing ACL rules.

The native-host packet is initialized after host and archive verification and
before native interaction. It retains bounded run and source identifiers, the
archive SHA-256, verified host SHA-256 and version, and native architecture.
An interrupted run may retain only initial unavailable observations; the packet
is not evidence of readiness or qualification.

Successful transport delivery alone does not prove that the host editor accepted
or submitted the command. Actual-host diagnostics must retain real terminal input
and distinguish editor focus and draft changes from submission readiness. The
optional `OMP_TUI_DEBUG` interface can expose component state when supported by
the exact host binary; an absent interface is an unavailable observation, not a
passing result. Editor text and cursor observations do not establish that the
host's startup submission gate is open. Never substitute injected debug keys or
an instrumented replacement host for native release qualification.

Diagnostic editor matching uses the returned state fields rather than compiled
class names. A later read-only sample allows the host to process the single Enter;
it does not send another key or prove that submission is enabled. Diagnostic
sampling can perturb timing and must not be used as a qualification result.
Draft observations expose only a fixed category, length, and line count, not raw
text, distinguishing an emptied draft from a completed command with whitespace.

The manual `windows-login-research.yml` workflow builds the pinned OMP 18.12.5
source on a disposable GitHub-hosted Windows x64 runner with experimental Bun
1.4.2. It checks the source archive, native addon, compiler template and
instrumentation patch digests, installs only the three filtered upstream
workspaces with the frozen lockfile and lifecycle scripts disabled, and builds
the unmodified and instrumented hosts serially. The filtered dependency graph
contains accepted high-severity advisories in sharp, zod and adm-zip; this
research use is not a release approval. The hosted runner is not a Linux
namespace sandbox and the install uses network access.
Source acquisition closes the downloaded temporary file before its verified
atomic rename, including on Windows where an open handle otherwise prevents
the rename. Cached archives still require the pinned digest before extraction.
The Linux export job supplies the same-run checkout-matched provider archive
to the native runner. Source and installed dependency hashes stay fixed across
each build; only the coding-agent binaries and the pinned stats compiler's
`packages/stats/dist/client` output are excluded from the input-tree digest.
Unexpected input changes stop research and retain a bounded changed-path list.
The bounded native input trace distinguishes terminal receipt, decoded Enter,
focused editor dispatch, autocomplete handling and the bootstrap submit gate.
Startup checkpoints distinguish stream-publisher, extension-hook and session
reconciliation waits; the trace never opens the gate or substitutes a passing
result when initialization remains incomplete.
Raw transport samples omit ESC-only traffic; CR/LF categories, decoded Enter,
and semantic setup checkpoints remain observable. This avoids exhausting the
256-event buffer with terminal-control traffic before setup completes. The
32-KiB bound and overflow reporting remain unchanged; filtering is diagnostic
only and does not change terminal input or provider execution.
The research-only provider overlay is applied only after the disposable installed
package matches every archive file. Only `src/index.ts`, `src/config.ts`, and
`src/private-path.ts` may change; each original and resulting hash, plus the
combined patch hash, is recorded separately from the archive digest.
The baseline installation remains unchanged. A host-owned global sink records
integer await markers without importing a second trace module. Its provider-entry
sentinel must be observed before a missing later marker can identify a pending
await. Missing sentinels, invalid or overflowing samples, and nonreproducing
runs remain inconclusive. One trace client retains its cursor across the early
sample and a bounded final sample before timeout termination; cleanup still runs
if that sample fails. Neither the single Enter nor the dialogue deadline changes.
For a terminal staging error, research records only the fixed-schema diagnostic
and takes a final trace sample before terminating the owned process. Observation
and cleanup are bounded; an unavailable sample is not evidence of success.
A baseline staging error qualifies as a reproduction only after the same seven
dialogue steps and both completed, closed, successful validation responses as a
setup timeout. Archive and binary identity checks remain mandatory.
Configuration and Windows ACL markers are armed immediately before native login
and cleared when its promise settles, covering pre-prompt configuration loading,
persistence, and activation refresh without recording paths, values, or output.
The preceding invitation settlement remains outside that window.
These markers locate the remaining wait; they do not establish its cause until
the exact dependency and its outcome have been inspected.
For ACL markers 80–85, `id` identifies the invocation (1–256; later
invocations are not recorded), `a` is the marker, and `b`, `c`, `d` encode
elapsed whole milliseconds as a big-endian 24-bit integer from the instrumented
host trace initialization, saturating at 16,777,215 ms. Marker 80 precedes
`execFile`; 83 precedes awaiting its callback promise; 81 marks the callback;
82 marks child close; 84 enters the close-wait finally; and 85 leaves it. The
order of callback, close and finally is observed, not assumed. Marker 86 is
emitted in the host when each trace read is handled and uses the same clock;
the timeout sample's marker provides the upper observation boundary, not the
exact host termination time. The smoke process separately records
`timeoutElapsedMs` from its own monotonic timer arm to callback; its clock epoch
must not be compared directly with the host clock. Setup uses the existing
75-second smoke deadline and the ACL helper retains its 30-second deadline.
Timing differences can distinguish a helper started shortly before the outer
cutoff from one already pending much longer; missing, saturated or overflowing
trace remains inconclusive and neither marker completion nor callback proves
success. No paths, values or subprocess output are added to the trace.
The source exporter treats archive output names as local paths, so Windows drive
letters are not interpreted as remote tar destinations.
Package scanning recognizes validated Python digest/integrity assignments and
immutable schema-field references without exempting their assigned values;
opaque credential-like values remain blocked in both Python and TypeScript.


The provider fixture uses the checkout-matched exported package. The real
fixture runs against the baseline first; the instrumented dialogue runs only
when the baseline reports the same submission failure. The seven-day artifact
contains bounded observations and source, package and binary hashes, not host
binaries, upstream archives or raw logs. A missing platform dependency, build
failure, incomplete observation, or baseline that does not reproduce stops the
research; none is a passing result. These experimental hosts and observations
cannot replace official, unmodified Windows qualification.

The candidate is intended for the protected GitHub and npm publication workflow
below. Prepared source, local checks, and refreshed operation evidence are not a
publication receipt. Publication still requires complete operation coverage,
eight native results for the same archive, verified signatures, and the protected
`release` environment with its required reviewer and npm credential. Do not use
the earlier GitHub-only distribution as an exception to those gates.

The current source inventory is pinned to OmniRoute v3.8.53. Earlier eligibility
is retained as history, not carried forward as active acceptance. The
[generated inventory](generated.md#operation-inventory) owns the current operation
counts. Every unqualified operation blocks protected publication.

### Remaining qualification pipeline

Generated unknown authorization and side-effect attributes identify missing client
qualification, not missing server access controls. Packets begin at actual source
route files and retain explicit operation membership; shared persistence or
lifecycle ownership determines any merge. Reads and dependent writes can be
accepted separately without losing residual blocked IDs.

Process one source-owned route family at a time:

1. Review its pinned handlers, imports, framework behavior, authorization, and
   request/response contracts, including response redaction.
2. Implement the client adapter and isolated backend fixtures, with explicit
   side effects, mutation preflight, cancellation, and uncertain-outcome handling.
3. Independently observe successful and denied requests, errors, target drift,
   and mutation reconciliation against the pinned implementation. Expected
   outcomes must not come from the helper generating the observed result.
4. Review and bind the actual outcome to exact source and test bytes, regenerate
   contracts, then run qualification freshness and contract verification.

Advance only operations with that evidence. Do not substitute generated default
attributes, broad route exclusions, or successful catalog reads for qualification.

The protected environment must also allow the selected source branch or release
tag. With self-review prevented, the account dispatching the publication cannot
approve its own deployment; use a distinct authorized initiating account or a
separately authorized reviewer. Provision `NPM_TOKEN` through GitHub environment
secrets, never through release notes, issues, or committed configuration.

## Export a reviewed source snapshot

Release preparation requires the pinned Bun toolchain, an existing Node.js/npm
installation for `npm pack`, and `tar` and `zip` on `PATH`. It does not install a
missing package manager automatically.

`bun run scripts/export-release.ts` requires a clean Git worktree, tracked
release inputs, and bytes matching the current `HEAD`. The manifest records the
full source commit. The exporter builds in a fresh sibling directory, verifies
that the output contains exactly the five manifest artifacts plus
`SHA256SUMS.txt` and `release-manifest.json`, then replaces the output directory
atomically. A failed build leaves an existing output directory in place.

The fifth artifact, `OMP-OmniRoute-Provider-v<VERSION>-release-notes.md`, is an
exact byte copy of the reviewed `CHANGELOG.md`. Its hash is part of the release
manifest and approval receipt. The release workflow uses this exact file as the
GitHub Release description when it creates the draft and resets the description
from the same file immediately before publishing.

Package verification applies a portable tar member preflight before extracting
an archive. It rejects traversal, links, duplicate and Windows-ambiguous names,
special files, entries outside the package allowlist, and Python interpreter
cache or bytecode paths. The npm package excludes those local Python artifacts;
archive verification also rejects them before creating an extraction directory.
Cross-platform smoke
jobs receive the one prepared `.tgz` archive together with its expected SHA-256;
the verifier hashes and stages those exact bytes without modifying the caller's
archive. Packed package name and version must match the reviewed source manifest.

The release manifest says the assets are `prepared` for GitHub Releases and
npm. It is not a publication receipt. The workflow does not run on tag pushes;
an existing signed tag alone cannot publish a release.

## Qualification receipt

Finalize version and host-matrix edits before refreshing operation qualification.
The test-source fingerprint includes the package manifest and lockfiles, so even
a version-only manifest change makes the previous operation receipts stale.
Follow the [source-bound qualification procedure](contracts.md#qualify-behavior-independently):
rerun the active suites, compare fresh observations and bindings with their
reviewed references, and only then write new content-addressed receipts and
regenerate the inventory. Do not remove manifest binding or bypass the freshness
check to clear release CI. This refresh preserves the qualified operation set;
it does not qualify additional operations or platforms.

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

Every native smoke run must also complete a confirmed administration cycle
against disposable model-combo-mapping data: read the absent collection baseline,
create one mapping through the installed OMP interface, read its exact runtime
row and capture its ID, confirm deletion using that ID, and read the cleaned
collection. Both changes require typed confirmation and each is dispatched once.
The fixture injects acknowledgement loss after each state change by returning an
incomplete JSON body; HTTP status and headers may arrive, and the HTTP response
finishes, but no valid acknowledgement is received. Both outcomes remain unknown.
Runtime reads do not establish durability. The proof
binds authorization, exact create and bodyless delete requests, the item preflight,
and absence of unexpected administration requests. The target collector and
standalone release gate apply the same complete native-output validator; labels
and output hashes alone cannot qualify a target.

The two Linux musl evidence files also require a strict `runtime` binding.
It binds the source revision and package archive to the exact runtime-provenance
file, architecture-specific base digest, built image ID, signature-check
count, installed APK database hash, and canonical package inventory. The
standalone release gate and the workflow aggregator use the same validator;
missing, extra, mismatched, or incomplete runtime fields block approval.

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

The Windows parent smoke deadline is 55 minutes, covering the sequential setup,
persisted inference, and administration allowances; other native targets retain
20 minutes. Native qualification jobs and the Windows host diagnostic have a
90-minute job limit to leave time for preparation and teardown. On interruption,
timeout, or output overflow the collector fails. It does not use a reusable
Windows PID to terminate a tree: it requests termination of the live wrapper and
waits for exit, but unconfirmed descendant termination retains the workspace and
reports potentially running descendants. A wrapper that fails to exit within the
bounded wait is also reported. The same fail-closed behavior applies if the wrapper
already exited with pipes held or tree termination fails. Partial
evidence is removed; cancellation is checked through evidence writing and cleanup.
Cleanup errors remain failures and do not replace the original subprocess details.
These bounds do not qualify Windows administration or replace successful evidence
from the final archive.

The two musl jobs rebuild the runtime from the immutable architecture-specific
Bun 1.4.2 Alpine child-image digests and the frozen package list in
`provenance/musl-runtime.json`. If the recorded Alpine URL returns HTTP 404,
the job requests the same architecture and package filename from the Huawei
Cloud Alpine mirror, which retains older package revisions. This mirror is not
an immutable archive and availability is not guaranteed. Either source must
match the recorded size and SHA-256; `apk verify` checks every package signature
against the key in that exact base image. Image construction and package installation have
network access disabled; package scripts are disabled and no repositories are
configured. Before starting a runtime container, the job copies its installed
APK database from a created, unstarted container and requires the exact
41-package name, version, and architecture inventory recorded in provenance.
Runner, Docker daemon, and image architecture must all be native and agree.

Only after those checks does the job run the existing target qualification in
the rebuilt image against the same archive prepared by the workflow. The
qualifier fetches the exact manifest source commit into a fresh shallow
repository, validates its Git tree bytes against that commit, and confirms the
snapshot has no links, remotes, alternates, private Git configuration, ignored
state, or additional files. After validation it adds one empty `node_modules`
mount point for a writable temporary dependency filesystem. It mounts this
isolated snapshot and the release archive read-only; package dependencies,
temporary files, and target output use separate writable mounts. It never
mounts the live runner checkout. The smoke
container has a unique task name, owner label, and cidfile. Cleanup verifies
those identities, stops or escalates the owned container, removes it before
releasing mounted paths, and removes only its unique image tag. If Docker cannot
confirm removal, the mounted paths stay in place for safe recovery. The
container receives only the source revision and workflow identity needed by
the existing qualifier, with no GitHub token or Docker socket. The smoke
container uses ordinary job networking to install the frozen Bun dependencies
and download the pinned public OMP binary. This workflow does not claim a
network-isolated smoke.

The advisory review is bounded to the recorded Alpine runtime inventory and
the source snapshots named in provenance; those sources have different
coverage and do not establish the absence of every vulnerability. A verified
runtime build is only a prerequisite. It does not qualify either platform by
itself. An initial local x64 attempt failed because Docker's temporary
filesystem blocked loading OMP's embedded native addon. Offline probes using
the exact pinned musl binary loaded that addon successfully when the temporary
mount explicitly allowed execution; the qualifier now uses that mount option.
The loader's `releases/latest` URL was a manual recovery hint, not an automatic
download. A local x64 development smoke passed against source revision
`570b0c1c0072cebeefb726031abd7ecece50241e` using a package archive packed from
that same snapshot (`de76624e73e355e44a47cbfa1ce4c7a6e90f26c86be2de99cc7cb6b576f14923`).
The run verified the musl platform, installed package bytes, and plugin lifecycle;
its detailed output remains in the private task record. This development run is
not a trusted platform receipt. There has been no local arm64 runtime run.
Trusted platform qualification still requires the same-archive workflow and its
validated receipt.

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
job repeats these checks after environment approval. It reads both destinations
before changing either one, verifies the signed remote tag and exact release notes
and asset bytes, and checks npm's exact version, downloaded archive SHA-256, and
registry integrity against the approved archive. It creates a draft only when
both destinations are absent, publishes npm only when the matching draft exists
and npm is absent, and publishes GitHub only when both the matching draft and npm
package exist. If both destinations are already published and exact, it makes no
publication changes. Each effect is followed by another read of both destinations.

Publication readback streams each asset with the approved file's exact byte
length as its limit, compares its bytes, and verifies the npm archive SHA-256.
Individual metadata responses are limited to 8 MiB; larger or incomplete
readbacks stop reconciliation. The protected npm publish disables npm transport
retries, so a failed publish must be reconciled rather than automatically replayed.

The repository must configure the `release` environment with at least one
required reviewer and an `NPM_TOKEN` environment secret before publication can
be authorized. Both release jobs query the actual GitHub environment API and
validate its `name` and `protection_rules` response; this catches an absent or
unprotected environment before preparation can proceed. The publish job repeats
the check when it starts and verifies that `NPM_TOKEN` is non-empty before it
creates a GitHub draft. These protections are repository settings
and cannot be established by this workflow file alone. The API check follows
GitHub's [deployment environments endpoint and response schema](https://docs.github.com/en/rest/deployments/environments#get-an-environment).
If a publication operation or readback fails, its outcome may be uncertain. Stop
and reconcile both destinations before authorizing another protected workflow
run; the workflow does not automatically repeat failed effects. Missing or extra
assets, changed notes, mismatched tags or npm bytes, unavailable credentials, and
inconsistent states block further mutation. No asset overwrite, unpublish, version
bump, or bypass of the protected environment is part of recovery. Evidence
archives created by this workflow are reproducible; an older draft whose evidence
archive differs must be investigated rather than overwritten.

After successful npm authentication, a package-wide registry 404 is treated as
absent for the protected first-publication path. Existing package metadata must
still match the exact package identity and version inventory; other registry
errors stop reconciliation. Successful `whoami` authenticates the read but does
not prove scope ownership or publish entitlement. The protected token must have
the required permission; a rejected or uncertain publish stops without replay.
Do not create a package outside the protected workflow to bypass its controls.

No receipt in this document or in the release automation qualifies version
`1.0.0` by itself. Qualification requires the matching external target evidence
and complete operation coverage described above.
