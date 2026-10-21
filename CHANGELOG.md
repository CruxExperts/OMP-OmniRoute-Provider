# Changelog

All notable changes to OMP OmniRoute Provider are recorded here.

## 1.0.0 — 2026-10-21

Bring your OmniRoute gateway into Oh My Pi with guided setup, live model
selection, and an optional administration workspace.

### Highlights

- **Guided setup:** configure the gateway and optional services in OMP, with
  masked prompts and native credential storage.
- **Live models:** discover the models your gateway actually serves; optional
  catalogs enrich metadata without inventing runnable model identities.
- **Streaming inference:** use Responses and Chat Completions, including tool
  continuation and cancellation tied to the active connection.
- **Reviewed administration:** inspect source-backed operations, preview the
  affected target, and confirm supported changes. Uncertain outcomes are
  reported honestly and are never automatically replayed.
- **Clear pricing:** distinguish known, unknown, conditional, and stale fields.
- **A refreshed identity:** coordinated SVG/PNG graphics, practical guides,
  generated command references, and accessible historical interface examples.

### Install from GitHub

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.0
```

Restart OMP, then run `/cruxomni setup`. The existing package identity,
`/cruxomni` commands, `omniroute` provider ID, environment variables, and native
credential configuration remain compatible.

### Distribution and verification

This is a **GitHub release**, with a package archive, source archive, versioned
media ZIP, CycloneDX dependency inventory, release manifest, and SHA-256 checksums.
The GitHub-tag install command uses the tagged source. This release does **not**
publish the package to the npm registry; the manifest's npm target describes
prepared artifacts, not npm publication.

Administration is intentionally limited to **25 qualified operations**;
**1,193 remain blocked**, with **16 source-evidenced exceptions**. The inventory
is not a claim of complete OmniRoute administration coverage. Some confirmed
mutations retain an unknown outcome where upstream persistence cannot be proven.

The declared OMP range is `>=18.12.2 <19`, with source contracts pinned to
OMP `18.12.5` and OmniRoute `3.8.52`. Native release verification covers
**Linux x64 with glibc and OMP 18.12.5**. The other seven platform targets
have **not** been qualified for this release. Existing screenshots are clearly
labeled historical captures. See the generated compatibility and capability
references for precise boundaries.

Source code and documentation use the MIT License. Visual assets retain their
separate project-reference display grant and ownership notices.

## 0.1.0 — 2026-09-20

- Established `@cruxexperts/cruxomni-omp-client` as the initial public package
  with the protocol-facing `omniroute` provider ID.
- Added the interactive `/cruxomni setup` wizard for runtime, metadata,
  administration, and pricing configuration.
- Added transactional optional-credential references backed by OMP's native
  credential storage, with session-only storage as the default.
- Restricted administration to operations with exact release evidence; other
  catalog entries remain visible but unavailable.
- Added standalone packaging, compatibility, security, and migration guidance.
