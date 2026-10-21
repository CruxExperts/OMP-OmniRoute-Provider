# Administration

CruxOmni runs inside Oh My Pi. OmniRoute runs the gateway and owns its accounts,
providers, keys, routing rules, and access controls. Installing this client does
not install or configure an OmniRoute server.

## Start with read access

Connect with `/cruxomni setup`, then use `/cruxomni-admin status` to inspect whether
administration is enabled. Enable it with `/cruxomni-admin enable`. Use
`/cruxomni-admin search` to find available operations. Administration loads when
needed and uses separate management credentials; the runtime key used for chat
does not automatically authorize server changes.

Use the [generated operation inventory](reference/generated.md#operation-inventory)
to distinguish qualified operations, unfinished operations, and source-justified
exceptions. A route appearing in that inventory does not make it callable. The
client rejects operations without the required qualification evidence.

## Work with routing groups

Search for `/api/combos` to browse the reviewed combo operations. A combo is a
named group of models and routing rules. You can inspect and edit its models,
duplicate an auto combo into a stored group, change ordering, and inspect or
reset its metrics. The builder and auto-combo reads show candidates from the
server's configured providers.

The combo test operation sends requests to configured models and may incur
provider charges. Its confirmation authorizes those requests. Inspect each
target's result: an HTTP success response can still contain a failed model probe.
The client does not automatically repeat the operation after a lost response.

Model-visible results omit configured private diagnostic fields while retaining
typed token limits and reasoning settings. Target checks use the original private
state, so hiding a field from the preview does not hide its changes from the plan.

## Review changes before applying

Choose an operation and provide its required inputs in the interactive
administration flow. Inspect the target, operation, and redacted change preview.
Approve only the change you intend. Secret-bearing inputs belong in the human
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
For cc-alias updates, the client reads the selected override once after a lost
reply and reports success only when that value equals the requested value; it
never replays the PUT. The upstream route has no compare-and-set, so an external
writer can still race after the preflight read and before the PUT reaches the
server.

## End an administration session

Use `/cruxomni-admin disable` when you finish. Keep runtime, metadata, and management
credentials separate. Rotate a compromised credential on the server, replace it
through the owning credential flow, and create fresh plans. See
[troubleshooting](troubleshooting.md) for connection and credential recovery.
