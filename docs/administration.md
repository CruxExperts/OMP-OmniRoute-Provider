# Administration

OMP OmniRoute Provider runs inside Oh My Pi. OmniRoute runs the gateway and owns its accounts,
providers, keys, routing rules, and access controls. Installing this client does
not install or configure an OmniRoute server.

Administration qualification is being rebuilt after a mutation-safety contract
migration. Reviewed reads, provider configuration, fallback chains, provider
aliases, and model mappings have regained qualification with the limits below. Other examples describe intended workflows; use the
generated inventory to check availability before trying them. Unqualified calls
remain blocked. Version 1.0.4 does not expand the qualified operation set; the
current release limits remain documented in the changelog and generated inventory.

## Start with read access

Connect with `/omniroute setup`, then use `/omniroute-admin status` to inspect whether
administration is enabled. Enable it with `/omniroute-admin enable`. Use
`/omniroute-admin search` to find available operations. Administration loads when
needed and uses separate management credentials; the runtime key used for chat
does not automatically authorize server changes. See
[What is stored](installation.md#what-is-stored) for credential retention and
storage details.

Search opens a category selector followed by an operation selector. Each
operation shows whether it is available. Use the arrow keys and Enter to
select; long lists also support typing to filter. Press Escape to cancel before
selecting an operation. You can also supply an exact operation ID directly.

Use the [generated operation inventory](reference/generated.md#operation-inventory)
to distinguish qualified operations, unfinished operations, and source-justified
exceptions. A route appearing in that inventory does not make it callable. The
client rejects operations without the required qualification evidence.

## Qualification work pipeline

The previous OmniRoute v3.8.52 inventory contained 1,234 operations:
25 invokable, 16 source-justified non-invokable, and 1,193 unqualified. These
figures describe the previous source baseline, not qualification of the current
v3.8.53 pin. Of the previously unqualified operations, 450 were GET, 7 HEAD,
133 OPTIONS, 414 POST, 62 PUT, 26 PATCH, and 101 DELETE. These are method counts,
not safety classifications. All 1,193 previously had unknown generated authorization and side-effect
semantics; all 603 non-GET/HEAD/OPTIONS entries also had unavailable mutation
preflight. The 222 operations absent from the OpenAPI specification overlapped
these groups. Unknown metadata is not proof that the server lacks a capability.

The remaining work is organized by source behavior, not by assuming every HTTP
method is interchangeable:

1. **Public probes and other non-JSON responses.** Review the pinned ingress
   policy and handler for each route, including exported HEAD and OPTIONS
   handlers. Implement only transports the source actually requires. Bounded
   UTF-8 `text/plain` transport is available only for qualified bodyless GETs
   with an explicit finite response projection; arbitrary raw output remains
   unavailable. The transport does not qualify any operation by itself. Exercise
   actual handlers, response status, headers and body, authorization and error cases in isolated
   fixtures. An exported HEAD or OPTIONS handler is not a non-invokable exception
   merely because its method is shared or its response is empty.
2. **Management reads.** Review each route family's request, authorization,
   response projection, sensitive fields and read completeness against pinned
   source. Exercise allowed and denied credentials and upstream errors using the
   real authorization and handler code with explicitly bounded fixture backends.
   Record independent observations before promoting a family to invokable.
3. **Provider collection writes.** The existing provider family fixture runs
   pinned writes but intentionally holds POST, PATCH and DELETE. Complete
   source-qualified preflight for full provider revision and dependent cleanup
   scope, then demonstrate client planning, drift checks, cancellation, partial
   commits, uncertain replies and secret handling against independent source
   behavior. A source-only write is not evidence that client apply is safe.
4. **Other mutations and external effects.** For each remaining family, identify
   a complete source-qualified read or other defensible preflight, side effects,
   confirmation scope and settlement boundary. Implement missing executor
   support where necessary; exercise concurrent drift, failures after partial
   effects and lost responses without replay. Calls needing external providers,
   services or credentials remain unavailable until an isolated fixture can
   represent those boundaries honestly and the limits are reviewed.
5. **Evidence and release.** For each supported operation bind the reviewed
   request, auth, response, side-effect and safety contract to exact pinned
   source and test bytes; capture independent before/after/result observations,
   review and content-address them, then regenerate the inventory. Re-run the
   operation's fixture and compare fresh observations with reviewed evidence.
   A route may be classified non-invokable only with the existing
   source-justified proof, never because its tests or adapter are missing.
   Release remains blocked until every inventory entry meets the gate and the
   separate native platform qualification requirements are satisfied.

The first health-probe family has direct pinned-handler lifecycle observations,
but not independent framework-ingress authorization evidence. Qualification must
not infer public access from matcher source alone. Acquisition of the pinned
`next@16.3.8` research runtime was stopped after critical advisories
[GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr) and
[GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) were
confirmed. Their patched Next.js version is `16.4.1`; substituting it would not
prove the historical pin. Keep those operations unavailable until an approved
upstream provenance refresh or isolated historical-runtime research procedure
establishes actual ingress behavior. This is not a claim that the connector
runtime depends on Next.js or that the health matcher exercises those flaws.

The `/api/health` and `/api/health/ping` candidate contracts likewise remain
unqualified until the exact framework ingress is established. Their direct
pinned-handler fixture exercises the liveness response and the source database
ping using disposable in-memory SQLite, including database failures and bounded
response projection. It bypasses Next.js and does not prove ingress access,
durable persistence, or production database health. The route source describes
these probes as public; the fixture does not impose a management credential or
claim a denied-credential result. The pinned ping handler returns a fixed error
body for an unexpected exception but also logs the exception server-side; the
response redaction check is not a claim that server logs are secret-free.

The cache-metrics GET and DELETE routes remain unqualified pending actual Next.js
ingress evidence. Their candidate contracts describe the pinned management guard
and responses, not a production authorization result. Both calculate metrics
from usage history; the deprecated DELETE does not clear that history. A query
failure can return zero metrics with HTTP 200, so zero is not proof that no cache
activity occurred. Cost savings are an estimate using fixed source assumptions,
not actual billing. The direct handler fixture uses in-memory SQLite and does not
establish durable storage or production behavior. Error responses are bounded,
but the server also logs exceptions; response redaction does not cover those logs.

## Inspect and change fallback chains

Search for `/api/fallback/chains` to inspect or change a model's fallback chain.
The reserved model name `__proto__`, including surrounding whitespace, is
rejected for changes because the source GET cannot expose its current chain.
The client previews the selected model's runtime chain and checks it again before
sending a confirmed change. Another server client can still race that read.

The server updates its in-memory chain before attempting persistence and can
silently ignore a persistence failure. Its GET reads that same memory. For this
reason, both a normal HTTP success and a lost reply leave the client's mutation
outcome **unknown**. A subsequent GET can confirm the runtime value, but cannot
prove it was saved or will survive restart. Direct backing-store changes or
another process's writes may also be invisible to that map. The client sends
one confirmed attempt and never automatically replays it. This qualification
covers conservative invocation, not proof of durable completion.

## Work with routing groups

Search for `/api/combos` to inspect stored groups, model candidates, builder
options, and metrics. A combo is a named group of models and routing rules.

Combo creation, updates, deletion, duplication, reordering, and tests are still
awaiting qualification. That work must bind available routing dependencies and
describe effects that upstream cannot expose. Combo tests also send charged
provider requests, so their selected routing targets need a qualified preview.

Metrics reset is available. Supply the `combo` query value to reset a named
combo, or omit it to reset all metrics. The preview binds the selected scope and
exposed metrics; an observed change before apply requires a new preview. Upstream
can omit counters from GET, including bypass-only counters and some map entries.
Those hidden counters are also reset within the confirmed scope. Their omission
does not prevent use, and the preview explains the visibility limit.

Resetting all metrics also stops upstream's periodic metrics cleanup timer until
the module reloads. Inspect that consequence before confirming. A normal success
reply or a lost response leaves the reset outcome unknown; the client makes one
confirmed attempt and does not automatically retry it.

Model-visible results omit configured private diagnostic fields while retaining
typed token limits and reasoning settings. Target checks use the original private
state, so hiding a field from the preview does not hide its changes from the plan.

## Route model patterns to combos

Search for `/api/model-combo-mappings` to list mappings, inspect one mapping,
or create, update, and delete a mapping. Each mapping connects a model-name
pattern to a stored combo, with a priority and an enabled flag.

The server trims a pattern when creating a mapping, after validating the raw
input. A whitespace-only create therefore stores an empty pattern; reads retain
that value. Updates preserve the pattern exactly as supplied. A partial update
retains fields you leave out. The client checks the selected mapping before
writing. Creation checks a complete collection response before deciding which
rows already exist. A lost write response stays unknown and is never replayed.
External writers can still race between the check and write because these routes
provide no atomic conditional update.

## Inspect capability overrides

Search for `/api/model-capability-overrides` to inspect the server's overrides.
Changing or deleting overrides remains blocked while the server's mutable model
prefix and alias resolution cannot be fully bound to a preview. These overrides
do not replace live discovery as the authority for runnable models.

## Configure one provider

Search for `interception-rules` or `param-filters` to inspect a provider's
interception rules or parameter filters. Each family supports reading, replacing,
and deleting that provider's configuration. An absent interception configuration
reads as an empty object; absent parameter filters use empty allow/block lists
and disabled automatic learning.

For interception rules, use the provider ID without leading or trailing
whitespace. Both configuration families reject the reserved provider ID
`__proto__`: the server can store it but cannot return its current state, so the
client cannot safely preview a change. Parameter-filter IDs otherwise retain
the server's exact spelling, including whitespace.

A replacement supplies the complete configuration rather than merging it with
the current value. Inspect the preview carefully, including model-specific
rules. Target checks include private fields hidden from the displayed preview.
Deleting the configuration restores the server's default read result. A lost
write response stays unknown. For deletes, a read cannot distinguish a deleted
row from a stored empty configuration; configuration reads can also use the
server's cached state. The client never repeats an uncertain write automatically.
These operations share the same confirmation and client write queue as other
administration changes.

Preflight detects changes visible through that server process's configuration
API. Upstream caches these values and invalidates its cache through its own
write functions. Direct database changes or writes through another process can
remain invisible to the read. This client cannot prevent those unseen changes
from being overwritten, nor lock external writers between a read and a write.
A received, validated success response acknowledges the source's database write;
a matching cached read alone does not prove that write completed.

## Review changes before applying

Choose an operation and provide its required inputs in the interactive
administration flow. Inspect the target, operation, redacted observed state, change preview, and any
source visibility limits. Approve only the change you intend. Secret-bearing inputs belong in the human
interface, not a model conversation. Server permissions still apply after client
confirmation.

A plan binds its inputs, endpoint, credential identity, and observed target state.
Expired plans and changed credentials or targets require a new preview. The
client checks the target again before dispatch. Where the server has no atomic
conditional write, an external administrator can still change it between that
check and the write. For provider cc-alias updates, the preview and apply check
only the selected provider or model override, so unrelated aliases do not stale
the plan. The client serializes its own mutation plans through preflight,
dispatch, and outcome reconciliation, but this cannot lock another server
client or make the upstream PUT atomic.

If the response is lost, the result can remain unknown even when the server
performed the change. Inspect the current target and reconcile the outcome before
creating another plan. Repeating the request can duplicate a successful change.
For cc-alias updates, a lost reply stays unknown; the client never replays the
PUT or turns a matching later value into proof of that write. The upstream route has no compare-and-set, so an external
writer can still race after the preflight read and before the PUT reaches the
server.

## End an administration session

When an OMP session restarts with administration enabled, the client reloads the
active endpoint and resolves available credentials for the new session. Previous
plans cannot be reused. Credentials held only in the old session may need to be
entered again.

Use `/omniroute-admin disable` when you finish. Keep runtime, metadata, and management
credentials separate. Rotate a compromised credential on the server, replace it
through the owning credential flow, and create fresh plans. See
[troubleshooting](troubleshooting.md) for connection and credential recovery.
