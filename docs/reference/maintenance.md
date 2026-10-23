# Repository maintenance

Maintenance reporting is enabled through the repository variable
`CRUXOMNI_MAINTENANCE_ENABLED=true`. The issue labels, Copilot review ruleset,
signed-commit protection, corrected required checks, and immutable Actions
references are configured. Instructions describe the intended behavior; the
execution records below establish what was actually verified.

## Daily observations

The maintenance workflow runs daily at **07:17 UTC**, on manual dispatch, and
after a trusted default-branch CI failure. Set
`CRUXOMNI_MAINTENANCE_ENABLED=false` in repository variables to stop future
reporting. Existing in-flight runs need separate inspection before cancellation.
It checks upstream versions, dependencies, and generated
documentation. It also reports failed trusted default-branch runs. OmniRoute release
observations use the validated canonical repository `cheaper-inference/OmniRoute`,
while the original repository and immutable source pin remain recorded in
`provenance/upstreams.json`. A failed source observation does not prevent other
sources or documentation from being checked; successful independent findings can
still be reconciled, and the run reports incomplete with a nonzero exit status.
Dependency audit diagnostics remain private and are never copied into public issues.

Each identifiable public finding has a stable marker and one owned issue, labeled
`maintenance` and `automation`. Duplicate events reuse that issue. A lost create
response is reconciled by reading server state once; the script does not blindly
repeat publication. All issue writers share a concurrency group. Rate limits and
uncertain outcomes stop with an error for a maintainer to investigate. Incoming
issue text never becomes executable input.

The `1.0.0` milestone backlog is prepared in `.github/1.0.0-backlog.json`, with
separate work items and acceptance criteria. It has not been imported into GitHub.
Import must reuse matching issues and milestone entries rather than duplicate them.

## Reviews and branch settings

The description, topics, and social-preview asset are recorded in
`.github/repository-settings.json`. The Copilot review ruleset and branch protection
are active; required contexts reflect the successful package and both host-smoke
matrix jobs, with strict checks and signed commits enabled. No new human-approval
requirement was imposed; an independent human reviewer has not been verified.
Copilot review is advisory and is not automatic merge authority.

Copilot review guidance lives in `.github/copilot-instructions.md`. The implemented
setup workflow prepares locked dependencies and runs focused validation with
read-only contents permission. It does not provide issue-writing access. The
enabled ruleset requests reviews on new pull requests and subsequent pushes through
`review_on_push`. This requires the author's applicable Copilot access and credits;
see [GitHub's rules API](https://docs.github.com/en/rest/repos/rules).
A Copilot request is not proof that a review ran, and it does not authorize a merge.

Use GitHub Actions for this public repository. GitHub's separate
[Copilot Automations feature](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-automations)
has separate availability limits. Verify current entitlement and results before
claiming either feature is active.

## Verified activation: 2026-10-23

- [Copilot setup run](https://github.com/CruxExperts/OMP-OmniRoute-Provider/actions/runs/39916985136)
  passed using the pinned Bun 1.4.2 workflow, locked dependencies, fixture
  preparation, typechecking, documentation checks, and maintenance tests.
- [First maintenance dispatch](https://github.com/CruxExperts/OMP-OmniRoute-Provider/actions/runs/39917021638)
  and [repeat dispatch](https://github.com/CruxExperts/OMP-OmniRoute-Provider/actions/runs/39917572624)
  passed. The repeat retained the same two bot-owned issues, with no duplicates:
  [OMP compatibility evidence](https://github.com/CruxExperts/OMP-OmniRoute-Provider/issues/2)
  and [default-branch validation](https://github.com/CruxExperts/OMP-OmniRoute-Provider/issues/4).
- [Documentation task #3](https://github.com/CruxExperts/OMP-OmniRoute-Provider/issues/3)
  was assigned to native Copilot, which produced
  [pull request #5](https://github.com/CruxExperts/OMP-OmniRoute-Provider/pull/5).
  This verifies task assignment and agent work; it does not establish merge or
  release acceptance.
- The full local suite passed 349 tests, plus four Python capture-safety tests.
  The existing upstream-latest gate still reports OMP 18.12.6 versus the pinned
  18.12.5 and the OmniRoute repository redirect. Those facts are tracked for
  reviewed compatibility maintenance; pins and qualification gates were not
  weakened to clear CI.

GitHub may require a maintainer to approve workflows on Copilot-authored pull
requests. That platform approval remains in force. The agent's default read-only
GitHub tools do not independently grant issue creation: automatic observations
use the Actions issue writer; other agent discoveries use an authorized issue tool
or a sanitized follow-up draft in the pull request. No additional publishing
credential, paid-usage setting, automatic assignment loop, merge, or release was
enabled.

## Release authority

Implementation and local checks do not authorize publication. Prepare the exact
source, artifacts, notes, checksums, and release receipt described in the
[release guide](release.md), then obtain approval for that payload. A tag push alone
does not publish. Reconcile any partial npm or GitHub publication before retrying.
