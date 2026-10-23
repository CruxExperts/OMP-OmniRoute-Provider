# Third-party notices

OMP OmniRoute Provider interoperates with Oh My Pi and OmniRoute. Their names and
trademarks belong to their respective owners. The original visual asset pack is project artwork. The additive real-use
screenshots and their marketing composites depict upstream interfaces, including
OMP's splash artwork. Those interface elements remain the property of their
respective owners; Crux Experts LLC claims only its original composition,
branding and privacy edits. These captures do not imply upstream endorsement.

Runtime and development dependencies retain their own licenses and notices in
their distributed packages. The generated CycloneDX SBOM identifies the exact
dependency selections used for release verification.

## Pinned OmniRoute source behavior

The following modules adapt behavior from
[`diegosouzapw/OmniRoute` v3.8.52](https://github.com/diegosouzapw/OmniRoute/tree/ad6f33f66bda34eba98645d3bfdabbde294bc843):

- [`src/admin/source-validation.ts`](src/admin/source-validation.ts): provider
  identifiers and source-specific request validation.
- [`src/admin/source-normalization.ts`](src/admin/source-normalization.ts):
  provider configuration normalization and observable storage-state views.
- [`src/admin/authorization-policy.ts`](src/admin/authorization-policy.ts):
  method/path requirements for management access-token scopes.
- [`src/admin/source-fallback-chains.ts`](src/admin/source-fallback-chains.ts):
  fallback-chain validation, defaults, sorting and selected-model snapshots.
- [`src/admin/source-model-capability-overrides.ts`](src/admin/source-model-capability-overrides.ts):
  capability override coercion, reasoning-effort encoding and provider prefixes.

- [`src/admin/source-combos.ts`](src/admin/source-combos.ts): combo request
  normalization and observable state.
- [`src/admin/source-model-combo-mappings.ts`](src/admin/source-model-combo-mappings.ts):
  model mapping normalization and target views.

That upstream work is MIT-licensed, Copyright (c) 2026 diegosouzapw. Its full
copyright and permission notice, source filenames, and pinned file hashes remain
embedded in each adapted module. This package does not claim ownership of those
upstream identifiers or rules.

## Media export fonts

The brand exporter references the installed DejaVu Sans font and Pillow renderer.
No font software or renderer is redistributed in the media pack. Existing notices
and grants for the earlier graphics remain in effect. See assets/README.md and
assets/brand/manifest.json for source and export provenance.
