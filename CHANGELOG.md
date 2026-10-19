# Changelog

All notable changes to CruxOmni-OMP-Client are recorded here.

## Unreleased

- Unify startup, setup and explicit refresh around generation-bound live
  discovery, single-flight requests and a 30-second automatic freshness window.
  Publish explicit guarded models instead of host-cached native API rows.
- Materialize native protocol compatibility through the public host catalog
  builder and stream through the host's public API. Bind active streams to
  credential/endpoint cancellation and allow exactly one POST to the selected
  protocol endpoint, without replay or fallback.
- Clear runnable authority on authentication failure or an empty catalog.
  Publish live models before optional metadata/pricing, keep enrichment bound
  to its source connection, and preserve remembered and session-only metadata
  credentials through their existing native owner.

- Align OMP compatibility, CI, and development SDK pins with current release
  `18.12.3`, preserving the `18.12.2` floor; OMP runtime packages remain peers.
- Use OMP's current native credential and login namespaces for guided setup
  and remembered optional credentials, preserving exact-row removal.
- Resolve profile directories through OMP's public utility root, which is
  available to the compiled host's extension loader.
- Pin release metadata to OmniRoute `3.8.51` and current OMP `18.12.3`, while
  preserving the `18.12.2` floor, earlier artifact receipts, and exact ignored source archive.
- Document native package installation separately from local checkout linking;
  publication remains outside this candidate's scope.
- Refresh only the OMP development SDK's transitive `sharp` and native/libvips
  graph to `0.35.5` (`@huggingface/transformers@4.3.0` permits `^0.35.4`); no
  direct dependency, override, or product runtime package was added. This
  addresses [CVE-2026-96889 / GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w);
  the maintainer advisory and OSV identify versions below `0.35.5` as affected,
  deps.dev reports no advisory for `0.35.5`, NVD currently scores the CVE
  `7.8`, and CISA's exploited-vulnerability catalog has no matching entry.
  The patched npm release was published `2026-09-27`.

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
