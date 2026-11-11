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
The environment URL must be an absolute HTTP or HTTPS URL; environment values
do not receive the interactive HTTPS default. Userinfo, query strings,
fragments, malformed hosts or ports, path traversal, unsupported schemes, and
unapproved remote HTTP are rejected. A trailing `/v1` is optional. Interactive
setup also accepts a bare domain or IP with an optional port and base path, but
bare input always means HTTPS. IPv6 literals must be enclosed in brackets.
For example, enter `https://llm.example.com` or
`[2001:db8::1]:8443/base`; do not enter a bare `2001:db8::1`.

## HTTPS or HTTP endpoint input

The setup prompt uses `https://llm.example.com` as neutral guidance; it does not
select that server for you. When a scheme is omitted, HTTPS is added. To request
HTTP, type `http://` explicitly. Remote HTTP requires its own confirmation and
is never attempted automatically after an HTTPS failure. If HTTPS reports a
certificate or connection problem, correct the hostname, certificate, port,
or base path instead of removing TLS protection by accident. Query strings,
fragments, embedded credentials, malformed ports, and paths containing `.` or
`..` traversal segments are not valid endpoint input.

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
Status, refresh, and the setup summary identify the selected source and explain
pending activation, missing or ambiguous native credentials, and catalog
failures. A public model catalog can succeed with an invalid key, so catalog
readiness is not independent key verification. A native profile ignores runtime
environment overrides; an environment connection requires both its URL and key.
OMP owns its model picker and JSON output; actionable startup guidance appears
on standard error and does not change either surface.

## Setup did not activate or remains auth-only

This means the protected key check, live catalog check, native persistence,
readback, or activation did not complete. A pending marker after process exit
remains unusable until explicitly recovered or replaced. In an interactive
OMP terminal, run `/omniroute recover` to confirm the pending endpoint and
generation, then verify the one saved native key and live catalog. The saved
key cannot prove it was the original candidate. Missing, ambiguous, changed,
or rejected credentials require a fresh sign-in through OMP's masked prompt.
Recovery does not use environment or legacy credential fallback. A valid empty
catalog is accepted as a connection with no chat models.

For Windows native-login smoke investigations, the identity-bound diagnostic
artifact records bounded configuration, credential, ACL, and staging outcomes
and elapsed times. Persisted inference records its own separate bounded events;
the artifact contains no paths, endpoints, credentials, or raw exceptions.
Configuration ACL reads have their own bounds and do not consume the credential
lookup or live-discovery budgets. An already-aborted credential entry does not
establish that lookup ran. A reported staging failure stops that smoke setup
promptly; it does not weaken ACL checks or change their timeouts.
The administration child records separate bounded enable-entry and
pre-confirmation phases, including ACL callback and child-close observations;
these are retained on failure. Run 43011692946 reached endpoint resolution on
both Windows architectures, then timed out at administration dialogue 1/19.
Terminal-derived event records can omit events; a missing confirmation marker
does not establish a provider hang. The failure artifact also records fixed
selector markers, bounded character distances, and the enable-pattern match
result, without retaining terminal text. Neither platform is qualified by this
diagnostic result.
A one-off reproduction with pinned Bun 1.4.2 showed that
`stripVTControlCharacters` mishandles colon-form SGR and leaves the final `X`
from erase controls: `ESC[38:2::254:188:56mYes ESC[149X ESC[149C│`
(without the illustrative spaces) becomes `:2::254:188:56mYesX│`, while
`No` followed by those controls becomes `NoX│`. This produces the observed
false Yes / true No selector signature with the earlier label boundary. The
smoke parser now removes complete CSI sequences before its usual terminal
normalization, including when a sequence spans output chunks. This local
reproduction alone did not prove the cause of the hosted failures; the later
official acceptance result is recorded below.
Official run 43038502401 at source 9b41346 reached dialogue 9/19 on both
Windows architectures, after the first apply confirmation, without retaining an
unknown-outcome notification. The actual apply notification was not retained,
so plan expiry is not established. Source inspection shows a 60-second plan
lifetime and three Windows configuration reads between plan creation and the
final pre-dispatch expiry check; three reads taking 22 seconds each would exceed
that lifetime, but those durations do not prove the cause of this run's failure.
The existing failure diagnostic now records only a fixed apply-notification
category, capped fixture GET/POST/DELETE counts, and whether the fixture sent an
intentional malformed acknowledgement. It retains no terminal text, plan IDs,
credentials, or raw errors. An explicit terminal apply failure stops the
dialogue without replay; fresh native qualification evidence remains necessary.
Run 43044940211 subsequently reported plan expiry and zero fixture POSTs on both
Windows architectures, with three serial ACL helpers taking about 22 seconds
each. Earlier standalone ACL measurements of 254 and 391 ms do not explain the
actual hosted run. The existing opt-in diagnostic artifact now separates parent
stdin completion, exit, callback and close from child first statement, stdin
read completion, JSON parse completion and ACL checks completion. Child times
use the child monotonic stopwatch; parent elapsed times on child events measure
arrival, not execution. Missing events do not establish a phase's duration.
In run 43050253681, source 2b49685, Windows arm64 recorded stdin read
completion at 20 ms, JSON parse completion at 22,647 ms and ACL checks
completion at 22,686 ms on the child stopwatch; parent startup took 289 ms.
Other calls likewise spent about 23 seconds parsing, and the plan expired.
Windows x64 passed its full native run. The helper now uses the .NET Framework
JSON serializer directly rather than discovering the ConvertFrom-Json command.
Official run 43054655900 at source 8d1a0da passed both unmodified native
Windows x64 and arm64 hosts, including administration I/O. The retained arm64
invocation completed parsing at 77 ms (stdin complete at 24 ms), ACL checks at
121 ms, and parent callback/close at 402 ms. The security checks and 60-second
plan lifetime remain unchanged. This is Windows acceptance for that candidate,
not eight-platform release qualification or publication.




Windows qualification limits the complete smoke to 55 minutes; other native
targets retain 20 minutes. The native qualification and Windows diagnostic jobs
allow 90 minutes for preparation, the bounded smoke, cleanup, and artifact upload.
On timeout or cancellation, native qualification fails rather than reporting
success. Windows cannot safely identify the process tree by a reusable PID. It
requests termination of the live wrapper and waits for its exit, but descendant
termination remains unconfirmed and the temporary workspace is retained. If
the wrapper does not exit within the bounded wait, the error explicitly reports
that its exit is unconfirmed too. A wrapper that exited while descendants still
hold its pipes, or an unsuccessful tree
termination, also leaves the workspace intact. The error identifies the retained
path and warns that processes may still be running. Inspect the runner and stop
the remaining processes before manually removing that workspace. Failed evidence
output is independently removed. Cleanup failures preserve the original error;
cleanup failure alone also fails qualification. This deadline change does not establish Windows
administration qualification; new successful native evidence is still required.

If the key check succeeds but setup reports no compatible chat models, the
credential was verified and the current `/v1/models` response did not yield a
runnable chat model. Check the route prefix and model availability separately;
do not treat that result as a rejected key. While the endpoint is checking,
wait for verification and catalog discovery to finish before selecting a
model. A completed empty catalog is not reported as a ready model list.

## OMP displays generic OAuth wording

The native `/login` selector and its initial progress text belong to OMP; the
host may show “Starting OAuth flow…” even though this provider uses an API key.
That host-owned wording does not mean the plugin opens a browser or requests an
OAuth token. Use `/omniroute setup` for provider-specific API-key prompts and
verification messages.

## Models are stale or missing

Run `/omniroute refresh`. A valid empty live catalog removes all package-owned
models. Malformed-only catalogs and conflicting identities are rejected;
mixed valid/malformed catalogs retain valid rows with diagnostics.
HTTP 401/403 removes runnable models and marks the connection unauthorized.
Same-connection network, rate-limit or server failures can retain last-known
models, explicitly marked stale.

When a task subagent ends, the parent session retains its own active provider
and connection. Each session's inference binding is isolated; a model retained
from an ended session cannot use another session's credentials.

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

## Inference connection interrupted

Transient inference failures, including interrupted streams during gateway
restarts, can trigger a fresh generation after a delay. Response text is held
until generation succeeds; the connector does not stream live tokens. Partial
output from failed attempts is discarded, and their tool calls are never started.
By default, the client allows 5 total attempts, including the initial request,
with 30000 milliseconds between attempts. Terminal failures are not retried.
Cancellation or a connection binding change stops retries. No synthetic resume
prompt is sent, and administration operations are not replayed. A fresh
inference attempt does not guarantee exactly-once processing by the model
server or restart the OMP process.

Set `reconnectMaxAttempts` to `1` to disable retries, or adjust the attempt
count and delay using the [plugin settings](installation.md#inference-reconnect-settings).
After attempts are exhausted, investigate the gateway and connection before
trying again.

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

Windows qualification run 42992934819 passed native setup and persisted Chat
Completions inference on both architectures, including the exact reply, usage,
single POST, and live model discovery. Administration I/O did not complete in
that run; run 43054655900 subsequently passed it on both architectures. A visible classic PTY
prompt or fixed delay does not prove submission readiness. The smoke dialogue
now starts the official host with a positional `/omniroute-admin status`
command and waits for its enabled or disabled status response before enabling administration;
this readiness barrier does not itself establish qualification.

## Credential or config recovery

Use `/omniroute setup` to forget only the affected optional credential, or use
`/omniroute-admin logout` to clear the administration session. Never edit a key
into `omniroute/config.json`. If the private config file is corrupt or has
loose permissions, repair it while OMP is stopped and restart; the extension
will not silently reset a conflicting or insecure file.

On Windows, private-directory creation and permission verification use Windows
PowerShell's .NET security APIs directly, without loading the `Get-Acl` cmdlet.
Request JSON is decoded with the built-in .NET Framework serializer.
Verification still rejects inherited directory access rules, untrusted owners,
and access grants outside the current user, SYSTEM, and Administrators.
Cancellation is passed to an in-flight Windows permission helper. Configuration
transactions wait for that process to close before releasing their ownership;
a canceled startup preference write cannot continue behind a new setup write.

When reporting a problem, include package/OMP versions, command and sanitized
error code. Remove keys, cookies, authorization headers, account identifiers,
local paths, endpoint hostnames, request bodies, and transcripts first. See
[SECURITY.md](../SECURITY.md) before sharing a reproduction.
