# Troubleshooting and Recovery

## The provider does not appear

Check that the package is installed and enabled in the OMP profile you actually
started. For development checkout links, restart OMP after changing the link.

## `/omniroute setup` says setup is unavailable

The wizard is interactive-only. Run it in an OMP TUI session, not a headless
job. A non-TUI host can still use the paired environment binding for runtime
discovery.

## Environment binding is rejected

Verify that `OMP_OMNIROUTE_BASE_URL` and `OMP_OMNIROUTE_API_KEY` are both set.
Userinfo, query strings, fragments, unsupported schemes, and unapproved remote
HTTP are rejected.

## Replace an environment-configured connection

The environment pair remains active until you explicitly choose a native
profile connection. In `/login`, approve the switch prompt, then enter the new
gateway URL and runtime key. In `/omniroute setup`, enter both values and
approve the confirmation showing the target URL. The key prompt is masked; the
existing environment values are left unchanged. After a switch, the saved
profile connection takes precedence. If its native key is missing, sign in
again; the client will not borrow the previous environment key. A partial or
invalid runtime environment pair is ignored after a native switch. If old runtime
environment settings remain, optional metadata/administration environment keys
are used only when their environment endpoint matches the saved connection.
Native profiles with no runtime environment overrides can continue using their
optional environment credentials.

Use `/omniroute` to inspect connection state. The former `/cruxomni`,
`/cruxomni-admin`, and `/cruxomni-pricing` commands still work as aliases.

## Setup saved a draft or remains auth-only

This means endpoint reachability, native persistence, readback, or activation
did not complete. A URL-only draft never contains a runtime key. Sign in again
through OMP's native masked prompt, then run `/omniroute refresh`; do not test a
new key against an old endpoint manually. A pending marker after process exit
is deliberately fail-closed and requires fresh sign-in.

## Models are stale or missing

Run `/omniroute refresh`. A valid empty live catalog removes all package-owned
models. Malformed-only catalogs and conflicting identities are rejected;
mixed valid/malformed catalogs retain valid rows with diagnostics.
HTTP 401/403 removes runnable models and marks the connection unauthorized.
Same-connection network, rate-limit or server failures can retain last-known
models, explicitly marked stale.

Changing endpoints, replacing or removing the runtime credential, disabling
the package, or ending the session cancels in-flight work. Cached model objects
cannot authorize a request for an earlier connection. Old native dynamic-model
cache rows are not an availability fallback; do not delete or edit OMP's cache
to repair the connection. Sign in or correct the endpoint, then refresh.

Optional metadata or pricing failures do not make an otherwise valid live
connection offline. Replacing or forgetting a metadata credential cancels only
its pending metadata request; it does not reset the runtime connection. A late
response from that credential is discarded. Run `/omniroute refresh` to retry with
the current credential, and check the separate metadata diagnostics.

## An optional catalog is unavailable or its fields are missing

Check **Catalogs (optional)** in setup and inspect `/omniroute` or **Summary**.
`unavailable` means there is no usable snapshot; `stale` means the previous
snapshot expired. A successful download does not make catalog-only models
runnable. Exact owner/ID mismatches, conflicting external fields, and unsupported
modalities remain diagnostics rather than guessed matches.

Run `/omniroute refresh` to revalidate an expired or failed source. Source failures
do not make an otherwise healthy gateway offline. Do not add a runtime/admin key
or raise the size/depth limits to make a public source work. Review the
[source conditions](installation.md#optional-metadata-catalogs) if OpenRouter
rejects anonymous access.

An explicit live `supportsTools: false` wins over optional metadata. Unknown
support is omitted with `tools_unverified`; the host may infer a default, so do
not treat an omitted flag as tested tool support. Missing context/output limits
also carry diagnostics instead of a claim that the fallback is the real limit.

## Administration says an operation is unavailable

Enable administration in the optional setup section and bind a separate
management credential. Then inspect the operation's reason in the UI. The
operation registry is visible for audit, but only entries in
`contracts/release-eligibility.json` with matching pinned-source and behavior
evidence can be read, planned, applied, or dispatched. A valid generic schema
is not sufficient evidence. No retry or gateway request is made for an
unavailable operation.

Management API keys and dashboard sessions remain subject to the server's
permission checks; their names do not prove access. Scoped management tokens
are checked through the qualified current-credential identity operation and
the pinned method/path policy. A null scope or authentication-disabled response
does not prove unrestricted token access. Missing identity-operation evidence
keeps scoped execution unavailable rather than guessing permissions.

Some management routes also have a source-defined disabled-auth branch, subject
to both central and handler policy. That conditional server behavior does not
make the route public, prove a credential's permissions, or enable credential-free
remote management in this client. Always-protected server routes remain gated.

Returned metadata is recursively projected through the qualified schema.
Sensitive fields remain absent even from typed object maps; a source-qualified
identifier map preserves model identifiers without exposing nested credentials.
Exact sensitive target state stays private to approval and drift checks.

## Credential or config recovery

Use `/omniroute setup` to forget only the affected optional credential, or use
`/omniroute-admin logout` to clear the administration session. Never edit a key
into `omniroute/config.json`. If the private config file is corrupt or has
loose permissions, repair it while OMP is stopped and restart; the extension
will not silently reset a conflicting or insecure file.

When reporting a problem, include package/OMP versions, command and sanitized
error code. Remove keys, cookies, authorization headers, account identifiers,
local paths, endpoint hostnames, request bodies, and transcripts first. See
[SECURITY.md](../SECURITY.md) before sharing a reproduction.
