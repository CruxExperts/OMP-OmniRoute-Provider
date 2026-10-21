# Repository maintenance

The repository contains prepared settings and automation. Their presence does not
mean account settings were applied or that npm and Copilot are authenticated.

## Daily observations

The maintenance workflow is scheduled for **07:17 UTC**. It stays disabled until
`CRUXOMNI_MAINTENANCE_ENABLED` is explicitly set to `true` in repository variables.
After the exact payloads are approved, it checks upstream versions, dependencies,
and generated documentation. It also reports failed trusted default-branch runs.
Dependency audit diagnostics remain private and are never copied into public issues.

Each identifiable public finding has a stable marker and one owned issue.
Duplicate events reuse that issue. A lost create response is reconciled by reading
server state once; the script does not blindly repeat publication. All issue writers
share a concurrency group. Rate limits and uncertain outcomes stop with an error
for a maintainer to investigate. Incoming issue text never becomes executable input.

The `1.0.0` milestone backlog is prepared in `.github/1.0.0-backlog.json`, with
separate work items and acceptance criteria. It has not been imported into GitHub.
Import must reuse matching issues and milestone entries rather than duplicate them.

## Reviews and branch settings

The exact proposed description, topics, social image, and ruleset are recorded in
`.github/repository-settings.json`. Review these settings before applying them.
In particular, confirm required check names from real runs and ensure an independent
human reviewer is available before enforcing approvals without a bypass.

Copilot review guidance lives in `.github/copilot-instructions.md`. The prepared
ruleset requests reviews on new pull requests and subsequent pushes through
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
