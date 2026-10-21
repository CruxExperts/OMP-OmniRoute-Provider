# First use and everyday work

Install the published version with the command in the
[installation guide](installation.md), restart OMP, then run:

```text
/omniroute setup
```

Enter your OmniRoute endpoint and runtime API key in the setup prompts. The key
prompt is masked. You can enter a domain, single-label host, IPv4 address, or
bracketed IPv6 address, with an optional port and base path. For example,
`llm.example.com`, `localhost:20128`, or `[2001:db8::1]:8443/base`. The neutral
prompt example `https://llm.example.com` is guidance, not a selected gateway. Omitted
schemes default to HTTPS; use an explicit `http://` only when you intend HTTP
and accept its separate warning. The client never falls back to HTTP when
HTTPS fails, and normalizes a trailing `/v1`.

Before saving the connection, setup verifies the runtime key against
OmniRoute's protected authentication endpoint and checks the live model
catalog. If the key is accepted but no compatible chat model is available,
setup reports the informational `no-models` state separately from invalid
credentials. An offline or unverified connection is not saved. Once those checks succeed, the client
stores the runtime credential through OMP's native credential storage.

Use `/omniroute` to check the connection and `/omniroute refresh` after server-side
model changes. The live server model list determines which models can run.
Optional catalogs enrich that list; they cannot add runnable models or download
model weights. Unknown prices remain unknown rather than becoming a zero-cost
claim. Inspect pricing with `/omniroute-pricing`.

The native OMP `/login` selector is host-owned and may display OMP's generic
“Starting OAuth flow…” status for this API-key provider. The `/omniroute setup`
wizard uses API-key wording and gives the provider-specific check result.

The earlier `/cruxomni`, `/cruxomni-admin`, and `/cruxomni-pricing` commands
remain available as compatibility aliases.

Administration is optional. Read the [administration guide](administration.md)
before enabling it. If setup fails, start with the
[troubleshooting guide](troubleshooting.md); avoid pasting keys or cookies into an
issue or conversation.
