# Repository maintenance

The maintenance and Copilot setup code and workflows are implemented in the
repository. The `maintenance` and `automation` issue labels and Copilot review
ruleset are configured. Scheduled maintenance activation remains pending until
the controller enables it and verifies successful runs. No live maintenance run,
Copilot setup session, or created issue is claimed without execution evidence.
Repository code does not prove that npm or Copilot is authenticated.

## Daily observations

The maintenance workflow is scheduled for **07:17 UTC**. It stays disabled until
`CRUXOMNI_MAINTENANCE_ENABLED` is explicitly set to `true` in repository variables.
When activated, it checks upstream versions, dependencies, and generated
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

The desired description, topics, and social preview are recorded in
`.github/repository-settings.json`. The Copilot review ruleset and branch protection
are active; required contexts reflect the successful package and both host-smoke
matrix jobs, with strict checks and signed commits enabled. Human approval remains
disabled because an independent reviewer has not been verified.

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

## Release authority

Implementation and local checks do not authorize publication. Prepare the exact
source, artifacts, notes, checksums, and release receipt described in the
[release guide](release.md), then obtain approval for that payload. A tag push alone
does not publish. Reconcile any partial npm or GitHub publication before retrying.
