# Changelog

All notable changes to OMP OmniRoute Provider are recorded here.

## Unreleased

## 1.0.3 — 2026-10-23

- Verify immutable upstream release tags, commits, and source hashes independently
  of GitHub Latest movement and canonical repository redirects. Latest monitoring
  remains available through maintenance and the explicit `--latest` check.
- Add exact OMP 18.12.6 Linux x64 release provenance and host lifecycle coverage
  alongside 18.12.2 and 18.12.5. Retain the reviewed 18.12.5 SDK/source pin with an
  explicit compatibility decision; future upstream releases still raise findings.
- Align contributor setup and refresh commands, sanitized real-use captures,
  fixture labeling, installation links, and current release documentation.
- This GitHub-only patch adds no administration operation qualification, publishes
  nothing to npm, and carries no eight-platform qualification receipt. The
  operation and platform limits documented below still apply.

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.3
```

- Introduce the screenshot-led GitHub homepage, guided reader journey, visual
  walkthrough, official company endorsement, and dark/light marketing artwork.
- Document the brand identity and reusable copy; preserve native screenshot
  geometry, existing runtime identities, historical artwork, and license split.


## 1.0.2 — 2026-10-21

- Guided setup and native sign-in use a neutral `https://llm.example.com`
  example. Interactive gateway addresses accept an omitted HTTPS scheme,
  local names, IP addresses, ports, and base paths; existing profile URLs
  appear only as clearly labeled prefilled values.
- Runtime API keys are verified through OmniRoute's protected cloud-auth route
  before the live model catalog is checked or any pending profile state is
  staged. Rejected keys, unavailable verification, malformed responses, failed
  catalogs, and cancelled checks leave the previous connection in place. A
  verified key may still connect when its valid live catalog has no
  chat-compatible models, which is reported separately from the live row count.
- Connection health shows `checking` during initial discovery and `no-models`
  for a verified connection without selectable chat models. It reports live
  rows separately from selectable chat models. A delayed healthy gateway
  no longer emits an initial degraded/error transition.
- OMP may still display its host-owned “Starting OAuth flow…” line in native
  sign-in. This plugin uses an API key; `/omniroute setup` uses API-key wording.
- This GitHub-only patch retains the operation and platform limits disclosed
  below. It does not publish to npm or claim full administration coverage or
  eight-platform qualification.

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.2
```

## 1.0.1 — 2026-10-21

- The OMP `/login` provider selector now labels this entry **Crux OmniRoute
  Provider**. The model provider ID and native credential identity remain
  `omniroute`; existing profiles and saved credentials need no migration.
- Setup and `/login` can explicitly switch a profile from a runtime
  environment binding to a newly entered native endpoint and masked key. The
  native source choice is persisted atomically with the pending connection;
  environment variables remain unchanged, and a missing native key never falls
  back to the environment key.
- `/omniroute`, `/omniroute-admin`, and `/omniroute-pricing` are the primary
  commands. The former `/cruxomni` command names remain aliases.
- A [branding policy](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/v1.0.1/docs/branding.md) defines the names, command aliases,
  visual identity, and compatibility identifiers maintained by this project.
- This remains a GitHub-only release with no npm publication. It carries the
  operation and platform limits documented for 1.0.0 and does not claim full
  administration coverage or eight-platform qualification.

Install the tagged source through OMP's native plugin installer:

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.1
```

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
