# Agent Instructions

This repository uses the universal agent repo shape.

## Operating Rules

- Treat `AGENTS.md` as the shared repo instruction entrypoint.
- Keep private task state under `.agents/state/<task-slug>/`; do not commit it.
- Keep durable project documentation under `docs/`.
- Review external skills before adding them to `external_skills.lock.json`.
- Prefer small, verifiable changes with focused tests or checks.
