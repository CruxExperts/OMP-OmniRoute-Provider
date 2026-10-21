# Administration

OhMyPie OmniRoute Plugin runs inside Oh My Pi. OmniRoute runs the gateway and owns its accounts,
providers, keys, routing rules, and access controls. Installing this client does
not install or configure an OmniRoute server.

Administration qualification is being rebuilt after a mutation-safety contract
migration. Reviewed reads, provider configuration, fallback chains, provider
aliases, and model mappings have regained qualification with the limits below. Other examples describe intended workflows; use the
generated inventory to check availability before trying them. Unqualified calls
remain blocked. This development state does not meet the 1.0.0 release requirements.

## Start with read access

Connect with `/cruxomni setup`, then use `/cruxomni-admin status` to inspect whether
administration is enabled. Enable it with `/cruxomni-admin enable`. Use
`/cruxomni-admin search` to find available operations. Administration loads when
needed and uses separate management credentials; the runtime key used for chat
does not automatically authorize server changes.

Search opens a category selector followed by an operation selector. Each
operation shows whether it is available. Use the arrow keys and Enter to
select; long lists also support typing to filter. Press Escape to cancel before
selecting an operation. You can also supply an exact operation ID directly.

Use the [generated operation inventory](reference/generated.md#operation-inventory)
to distinguish qualified operations, unfinished operations, and source-justified
exceptions. A route appearing in that inventory does not make it callable. The
client rejects operations without the required qualification evidence.

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

Use `/cruxomni-admin disable` when you finish. Keep runtime, metadata, and management
credentials separate. Rotate a compromised credential on the server, replace it
through the owning credential flow, and create fresh plans. See
[troubleshooting](troubleshooting.md) for connection and credential recovery.
