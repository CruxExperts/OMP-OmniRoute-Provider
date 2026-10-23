# Installation and Guided Setup

## Requirements

- Oh My Pi in the declared `>=18.12.2 <19` range. See the
  [generated compatibility reference](reference/generated.md) for pinned source
  versions; release qualification requires fresh evidence for the latest stable host.
- Bun `>=1.4.2` when installing from source or running package checks.
- An OmniRoute-compatible HTTPS endpoint and a runtime API key. Remote HTTP is
  available only through an explicit choice and warning.

The plugin display name is **OMP OmniRoute Provider**. OMP's `/login` provider
selector shows **Crux OmniRoute Provider**. The package identity remains
`@cruxexperts/cruxomni-omp-client`, and the provider ID remains `omniroute`,
preserving model names and native credential identity.

## Install the GitHub release

Install the pinned `1.0.3` GitHub source tag through OMP's native plugin installer:

```text
omp plugin install https://github.com/CruxExperts/OMP-OmniRoute-Provider#v1.0.3
```

Restart OMP and run `/omniroute setup`. This command installs from GitHub; it does
not use the npm registry. The release includes a `.tgz` package artifact for
verification and tooling, but a raw tarball URL is not the documented OMP plugin
install target. See the [release notes](../CHANGELOG.md#103--2026-10-23) for the
provider selector label and the unchanged administration and platform limits.

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
/omniroute setup
```

The wizard has independent sections:

1. **Connection** asks for a gateway URL and runtime API key. The key is
   entered in a masked prompt. Endpoint input accepts a domain, a single-label
   host, IPv4, or bracketed IPv6, with an optional port and base path. For
   example: `llm.example.com`, `gateway:8443/base`, `localhost:20128`,
   `192.0.2.10`, or `[2001:db8::1]:8443/base`. Omitted schemes default to
   HTTPS; enter `http://` explicitly to request HTTP. A remote HTTP endpoint
   needs a separate warning confirmation, and the client never retries over
   HTTP after HTTPS fails. A trailing `/v1` is optional and normalized away.
   Query strings, fragments, userinfo, malformed ports, traversal paths, and
   unbracketed IPv6 are rejected. The prompt's `https://llm.example.com`
   example is neutral guidance, not an active or preselected gateway. After
   you enter the target URL and key, the client checks the key against
   OmniRoute's protected authentication endpoint and loads the live model
   catalog before activation. The key is handed to OMP's native credential
   store only after those checks succeed. If runtime environment variables are
   active, the wizard asks for confirmation before selecting the profile's
   native connection; environment variables remain unchanged.
2. **Metadata (optional)** asks for a separate API key and offers **This session
   only** or **Remember in OMP credential store**.
3. **Catalogs (optional)** opts into Models.dev or OpenRouter metadata without
   sharing a runtime, metadata, or administration credential.
4. **Administration (optional)** asks for a separate API key or cookie and
   offers **This session only** or **Remember in OMP credential store**, then
   explicitly enables the verified administration boundary for the exact active
   endpoint.
5. **Pricing (optional)** selects a local source-backed JSON projection.
6. **Summary** reports state without revealing secrets.

Save and activation are transactional. A cancelled section does not discard
earlier saved sections. An offline endpoint, failed authentication check, or
malformed catalog cannot be saved as a successful connection; setup does not
offer an unverified or URL-only connection save. A key accepted by the
protected authentication endpoint but paired with an empty or incompatible
catalog is reported as “key verified, no compatible chat models available”
in the informational `no-models` state. While verification and discovery
are pending, OMP reports a checking state; a completed empty catalog is never
presented as a healthy model list. An interrupted pending login remains
auth-only and needs a fresh sign-in; `/omniroute refresh` forces rediscovery of
an active connection.
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

Open **Catalogs (optional)** in `/omniroute setup`, then choose **Enable
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
`/omniroute` and the setup summary show each enabled source's age, usable/stale/
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

For an environment-managed connection, set both variables:

```bash
export OMP_OMNIROUTE_BASE_URL="https://gateway.example"
export OMP_OMNIROUTE_API_KEY="$RUNTIME_KEY"
```

A partial pair fails closed. The pair remains authoritative until you explicitly
approve switching this OMP profile through `/omniroute setup` or native `/login`.
The switch stores the newly entered key through OMP's native credential store,
persists that native choice for this profile, and leaves environment variables
unchanged. A missing native key fails closed rather than falling back to the old
environment key. If runtime environment variables are present, optional metadata
and administration environment credentials are used only when the environment
base URL matches the selected native endpoint. With no runtime environment
variables, optional-only environment credentials remain supported.
Administration credentials remain separate: `OMP_OMNIROUTE_ADMIN_API_KEY` or
`OMP_OMNIROUTE_ADMIN_COOKIE`.

The primary commands are `/omniroute`, `/omniroute-admin`, and
`/omniroute-pricing`. The older `/cruxomni`, `/cruxomni-admin`, and
`/cruxomni-pricing` forms continue to work as compatibility aliases.

## What is stored

The private profile file contains endpoint generations, flags, opaque optional
credential references, and non-secret pricing/setup state. In native mode, the
runtime key is stored in OMP AuthStorage. Optional metadata and administration
keys or cookies can also be stored there when **Remember in OMP credential
store** is chosen; the profile records only an opaque reference. **This session
only** keeps an optional credential in memory for the current OMP session. It is
not written to the profile or AuthStorage. Credentials supplied by environment
variables remain in the process environment. No credential value belongs in
`config.json`, a screenshot, or a support transcript.
