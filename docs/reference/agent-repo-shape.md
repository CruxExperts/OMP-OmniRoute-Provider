# Agent Repo Shape

The universal agent repo shape keeps shared agent instructions, documentation,
and reviewed skill metadata in stable repository paths.

## Required Files

- `AGENTS.md`: shared repository instructions.
- `agent-repo-shape.json`: machine-readable shape metadata.
- `external_skills.lock.json`: reviewed external skill roster.
- `docs/INDEX.md`: human-readable documentation index.
- `docs/index.yaml`: machine-readable documentation index.
- `docs/reference/agent-repo-shape.md`: this reference.

## Private State

Use `.agents/state/<task-slug>/` for private run ledgers and other transient
task state. The controller assigns one Git-bound task slug for every agent and
tool to reuse. When the target is a Git repository, LocalSetup adds
`.agents/state/` to `.git/info/exclude` instead of modifying tracked ignore files.
