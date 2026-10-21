# Changelog

All notable changes to OMP OmniRoute Provider are recorded here.

## Unreleased

- Prepare the 1.0.0 release while retaining the current source version until
  complete operation and native-platform qualification is accepted.
- Qualify combo, fallback-chain, model-capability-override, model-combo-mapping and provider-alias
  and provider-configuration handlers against pinned source, schemas and management authorization. Publish
  thirty-two reviewed
  content-addressed observations; other operations stay unavailable.
- Serialize administration applies through preflight, dispatch and reconciliation;
  reject changed alias targets and reconcile lost responses without replay.
- Preserve typed token-capacity metadata while redacting configured nested
  diagnostics from model-visible responses and public qualification evidence.
- Share repeated provenance records, validate immutable source acquisition, and
  compare fresh qualification outcomes with reviewed references in clean CI.
- Add practical setup, administration, upgrade and release guides, generated
  command/coverage references, and a commit hook that preserves partial staging.
- Add editable brand artwork and reproducible raster exports with ownership and
  provenance metadata, plus native setup and administration-menu captures with
  accessible static descriptions. The walkthrough cancels before admin dispatch.
- Exclude local Python interpreter caches from npm packages and reject cache or
  bytecode entries during archive verification before extraction.
- Prepare disabled-by-default daily maintenance, issue guidance and review rules.
  Replace tag-triggered publication with signed-source validation, explicit
  approval, and the exact archive tested by the native qualification workflow.

- Derive response-status and media evidence from pinned handler bytes and resolved
  imports; keep source-only inventory unavailable until operation semantics pass.
- Keep private target snapshots exact while recursively redacting model-visible
  fields. Typed response maps require an explicit source-bound identifier-key
  role before secret-looking identifiers can pass through.
- Validate scoped management-token requirements against the pinned method/path
  policy instead of interpreting management API-key scopes as token-scope ranks.
- Preserve the server's conditional disabled-auth management branch without
  treating it as a public route, a locally observed grant, or permission to
  send credential-free remote management requests.

- Add opt-in, credential-free Models.dev and OpenRouter metadata adapters with
  bounded reads, shared 24-hour memory snapshots, source status, exact pinned
  identity mappings, synthetic parser fixtures, and source-term caveats.
- Merge capabilities field by field with explicit live `false` precedence and
  conflict diagnostics. Preserve evidenced tool, image, kind, limit, reasoning,
  and thinking metadata without creating runnable IDs or trusting catalog prices.
- Apply catalog selections through the existing refresh flow and reject late
  enrichment from a source disabled while its request was in flight.
- Bind optional metadata requests and late publication to their own credential
  epoch. Reconcile native optional-store changes without invalidating warm
  runtime discovery or replaying the cancelled metadata request.
- Recognize typed immutable field references, public model examples, reviewed
  fixture identifiers, and pinned authentication prose during package secret scanning without exempting actual
  authentication secrets or unrelated secret-bearing JSON keys and values.

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
  `18.12.5`, preserving the `18.12.2` floor; OMP runtime packages remain peers.
- Use OMP's current native credential and login namespaces for guided setup
  and remembered optional credentials, preserving exact-row removal.
- Resolve profile directories through OMP's public utility root, which is
  available to the compiled host's extension loader.
- Pin release metadata to OmniRoute `3.8.52` and current OMP `18.12.5`, while
  preserving the `18.12.2` floor, earlier artifact receipts, and exact ignored source archive.
- Document native package installation separately from local checkout linking;
  publication remains outside this candidate's scope.
- Mark host-supplied SDK peers installer-optional so native package installation
  does not fetch a second SDK; retain the supported host range and exact
  development SDK pins.
- Exercise native npm installation from the exact verified candidate archive in
  an isolated profile; compare installed bytes, reject duplicate host SDK copies,
  and run inference and plugin lifecycle checks against the installed package.
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
