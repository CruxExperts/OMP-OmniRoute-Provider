# Branding and naming policy

## Product and purpose

Use **OMP OmniRoute Provider** for the project, plugin titles, README, release
titles, and original artwork. It connects Oh My Pi to an OmniRoute gateway with
guided setup, live model discovery, and optional administration. Explain that
the gateway runs separately; the plugin does not install or host OmniRoute.

Use the following names consistently. Different names in this table serve
different purposes; a display-name change does not rename saved credentials.

| Surface | Name | Owner |
| --- | --- | --- |
| Project and plugin | OMP OmniRoute Provider | `src/identity.ts` |
| OMP login provider list | Crux OmniRoute Provider | `src/identity.ts` |
| GitHub repository | OMP-OmniRoute-Provider | `src/identity.ts` and repository settings |
| Primary command | `/omniroute` | `src/index.ts` |
| Administration command | `/omniroute-admin` | `src/index.ts` |
| Pricing command | `/omniroute-pricing` | `src/index.ts` |
| Native model and credential provider ID | `omniroute` | Existing provider registration and credential contracts |
| Package identity | `@cruxexperts/cruxomni-omp-client` | `package.json` and `src/identity.ts` |

The provider-list label is the explicit user-selected name for that interface.
It does not replace the project name. Preserve upstream names **Oh My Pi** and
**OmniRoute**, and describe the project as a provider for those tools without
implying upstream ownership or endorsement.

## Commands and compatibility

Show `/omniroute`, `/omniroute-admin`, and `/omniroute-pricing` in current help,
setup messages, documentation, and demonstrations. Keep `/cruxomni`,
`/cruxomni-admin`, and `/cruxomni-pricing` as compatibility aliases using the
same handlers. Do not create a second execution path for an alias.

Preserve existing provider IDs, model prefixes, package names, tool IDs,
environment variables, configuration paths, credential keys, receipt domains,
and error codes unless a separately documented migration changes their
contracts. In particular, `OMP_OMNIROUTE_*` variables and the `omniroute`
credential identity remain supported. Technical identifiers are not spelling
errors to fix with a global replacement.

Keep published tags, archives, historical changelog sections, exact upstream
source evidence, and genuine old screenshots unchanged. Label historical
screenshots clearly. New prose and new captures use the current names.

## Voice and visual identity

Lead with what users can do, use plain language, and provide complete practical
commands. Distinguish available behavior, declared compatibility, and verified
release evidence. Do not present an operation inventory as complete working
administration coverage or imply that untested platforms were qualified.

Use the existing routed-connection mark, restrained navy and teal palette,
readable typography, and clear Oh My Pi provider identification. Keep accessible
descriptions with images and inspect the rendered result when artwork changes.
`scripts/export-media.py` owns editable graphics and reproducible SVG/PNG
exports; `assets/brand/manifest.json` records their hashes and provenance.
Update the exporter before regenerating artwork rather than patching exports.

Source and documentation retain the [MIT License](../LICENSE). Artwork retains
the separate [asset license and project-reference display grant](../ASSET_LICENSE.md).
Preserve Crux Experts LLC ownership metadata and third-party notices; never
claim upstream artwork or fonts as original project work.

## Keeping the policy aligned

Review identity constants, registered commands, marketplace declarations,
current documentation, and artwork together when changing a name. Generate
command and documentation-index tables through `bun run docs:generate`, then
run `bun run docs:check`. Run focused identity and command-registration tests,
and check the installed interface for changes to visible labels or prompts.
Releases also verify the exact exported artifacts; a text check alone does not
prove branding in images or an installed plugin.

This repo-owned policy adapts the separation of display names, compatibility
identifiers, generator ownership, and historical evidence from
[LocalSetup's branding policy](https://github.com/CruxExperts/localsetup/blob/b4c7110f96ef4571ea0a6232f3ce0059d92f95fa/ls/docs/BRANDING.md).
LocalSetup's scanner and exception registry are not installed or claimed as
checks for this repository.
