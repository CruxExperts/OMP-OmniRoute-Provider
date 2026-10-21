# First use and everyday work

Install the published version with the command in the
[installation guide](installation.md), restart OMP, then run:

```text
/omniroute setup
```

Enter your OmniRoute endpoint and runtime API key in the masked setup prompts.
The client stores runtime credentials through OMP's native credential storage.
An unsuccessful discovery does not establish a working connection. Correct the
endpoint or credentials and retry before choosing a model.

Use `/omniroute` to check the connection and `/omniroute refresh` after server-side
model changes. The live server model list determines which models can run.
Optional catalogs enrich that list; they cannot add runnable models or download
model weights. Unknown prices remain unknown rather than becoming a zero-cost
claim. Inspect pricing with `/omniroute-pricing`.

The earlier `/cruxomni`, `/cruxomni-admin`, and `/cruxomni-pricing` commands
remain available as compatibility aliases.

Administration is optional. Read the [administration guide](administration.md)
before enabling it. If setup fails, start with the
[troubleshooting guide](troubleshooting.md); avoid pasting keys or cookies into an
issue or conversation.
