# Installation and Guided Setup

## Requirements

- Oh My Pi in the declared `>=18.12.2 <19` range. See the
  [generated compatibility reference](reference/generated.md) for pinned source
  versions; release qualification requires fresh evidence for the latest stable host.
- Bun `>=1.4.2` when installing from source or running package checks.
- An OmniRoute-compatible HTTPS endpoint and a runtime API key.

The public display name is **OhMyPie OmniRoute Plugin**. For compatibility, the
current package identity remains `@cruxexperts/cruxomni-omp-client`, and the
provider ID remains `omniroute`, preserving native model and credential identity.

## Install a published package

After a release is qualified and published, install its exact version through
OMP's native package installer:

```text
omp install @cruxexperts/cruxomni-omp-client@<qualified-version>
```

The current candidate is not published. Publication is separate from
qualification; do not use a package version that has not been released.

OMP supplies its SDK modules from the running host. Their package-manager peer
entries are marked optional so installation does not download a second SDK;
the supported OMP host is still required. Development checkouts install the
exact selected SDK through development dependencies instead.

The native smoke check serves the exact verified candidate archive from a
temporary loopback registry and runs `omp install` with its exact package version
in an isolated profile. It checks the installed file inventory and every file
digest, rejects package symlinks and duplicate host SDK packages, and requires
the registry to receive no authorization or cookie headers. Inference and
plugin lifecycle checks then use that installed package, not a checkout link.
These checks do not publish the candidate or qualify the remaining operation
catalog and performance requirements.

## Link a local checkout (development only)

```bash
bun install --frozen-lockfile --ignore-scripts
omp plugin link "$PWD"
```

Restart OMP after changing a local plugin link.

## Guided setup

Run this command in an interactive OMP terminal:

```text
/cruxomni setup
```

The wizard has independent sections:

1. **Connection** asks for a gateway URL and runtime API key. The key is
   entered in a masked prompt and handed to OMP's native credential store.
2. **Metadata (optional)** stores a separate API key or keeps it session-only.
3. **Catalogs (optional)** opts into Models.dev or OpenRouter metadata without
   sharing a runtime, metadata, or administration credential.
4. **Administration (optional)** stores a separate API key or cookie, then
   explicitly enables the verified administration boundary for the exact active
   endpoint.
5. **Pricing (optional)** selects a local source-backed JSON projection.
6. **Summary** reports state without revealing secrets.

Save and activation are transactional. A cancelled section does not discard
earlier saved sections. An offline or malformed endpoint cannot be reported as
success; a URL-only draft may be saved without a runtime key for later setup.
Native login activates a connection only after the key is persisted and live
validation succeeds. An interrupted pending login remains auth-only and needs
a fresh sign-in; `/cruxomni refresh` forces rediscovery of an active connection.
Automatic refreshes share one request and reuse a successful snapshot for
30 seconds. Explicit refresh bypasses that freshness window but joins an
already-running request.

## Select a live model

```text
omp models --json
omp --model omniroute/<live-model-id>
```

Use the full model selector returned by the model list. On OMP `18.12.2`,
an explicit `--provider omniroute` can be rejected before extension loading;
the full `--model` selector supports deferred extension-model resolution.

Startup waits up to 10 seconds for live discovery, including resolution of
the remembered native credential. Only discovered chat models become selectable;
metadata and pricing do not delay that publication or the first streamed reply.
Their optional enrichment is cancelled when the connection changes. A metadata
credential replacement or removal cancels its own pending metadata request and
discards late results without resetting live-model discovery. Refresh explicitly
to request enrichment with the replacement credential.

## Optional metadata catalogs

Open **Catalogs (optional)** in `/cruxomni setup`, then choose **Enable
models.dev** or **Enable OpenRouter**. Both are disabled by default. A change
refreshes the client, publishing live models before optional enrichment finishes.
Only the selected source IDs are saved in the version-2 `catalogSources` field;
these sources do not use the separate OmniRoute metadata credential.

The client requests only these documented HTTPS endpoints:

- [Models.dev's complete catalog](https://models.dev/api.json?type=all).
- [OpenRouter's complete modality catalog](https://openrouter.ai/api/v1/models?output_modalities=all),
  described by its [model-list API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

Requests omit credentials and cookies, reject redirects, and have a five-second
deadline, an 8-MiB body ceiling, and a JSON depth limit of 24. Successful snapshots
are shared in memory for 24 hours and revalidated on demand, never by a heartbeat.
Expired snapshots cannot enrich a new projection until revalidation succeeds.
`/cruxomni` and the setup summary show each enabled source's age, usable/stale/
unavailable state, and bounded error code without starting another request.

Only `/v1/models` supplies runnable identities. Metadata must match the exact
serving owner and ID: explicit live fields take precedence over OmniRoute
metadata, followed by non-conflicting external fields. Explicit `false` remains
false. OpenRouter's raw source ID keeps its vendor segment; only the pinned
server's `openrouter/` qualification is applied when matching its live ID.
Missing limits use conservative defaults with diagnostics. Unknown tool support
is omitted with a warning because OMP may infer a host default; it is not a
verified capability. Specialty-only models remain diagnostic, not chat selections.
External prices never replace the existing source-backed seller-pricing policy.
No source downloads model weights.

Models.dev publishes its data under MIT terms; retained fixtures include its
attribution. OpenRouter's [terms](https://openrouter.ai/terms/) contain automated
copying restrictions, and its API documentation is not a catalog-data
redistribution license. Enable it only for use permitted by those terms. Its
published schema declares API-key security: if an anonymous request is rejected,
the source stays unavailable rather than borrowing another credential. The
package retains synthetic parser fixtures, not redistributed catalog rows.

## Environment-managed mode

For an intentionally read-only binding, set both variables:

```bash
export OMP_OMNIROUTE_BASE_URL="https://gateway.example"
export OMP_OMNIROUTE_API_KEY="$RUNTIME_KEY"
```

A partial pair fails closed. Environment mode takes precedence over profile
setup and cannot be edited by the wizard. Administration credentials remain separate:
`OMP_OMNIROUTE_ADMIN_API_KEY` or `OMP_OMNIROUTE_ADMIN_COOKIE`.

## What is stored

The private profile file contains endpoint generations, flags, optional
credential references, and non-secret pricing/setup state. Runtime keys remain
in OMP AuthStorage. Optional remembered credentials use exact opaque native
records; session-only values are memory-only. No key, cookie, or credential
value belongs in `config.json`, a screenshot, or a support transcript.
