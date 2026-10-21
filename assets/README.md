# Media sources and exports

The `brand/` collection uses the current public display name **OMP OmniRoute
Provider**. Its wordmarks lead with “OMP” and “OmniRoute Provider,” with “OH MY PI
PROVIDER” identifying the client context. The bracket mark represents the client
boundary; the teal connection represents a route through the gateway. The navy
and teal palette keeps terminal-oriented artwork readable.

Run `python3 scripts/export-media.py` with Python 3, Pillow, and DejaVu Sans
available to reproduce both the editable SVG sources and PNG exports. The manifest
records renderer versions, font digests, source version, and every output hash.
The exporter uses shared geometry for both formats and includes corporate ownership
metadata in the SVG, PNG, and manifest. Fonts are referenced and are not bundled.

| Export | Size | Use |
| --- | --- | --- |
| `brand/icon-light.*`, `brand/icon-dark.*` | 256 x 256 | Transparent mark |
| `brand/wordmark-light.*`, `brand/wordmark-dark.*` | 1000 x 240 | Light and dark wordmarks |
| `brand/social.*` | 1280 x 640 | Social preview |
| `brand/banner.*` | 1600 x 640 | Repository banner |
| `brand/square.*` | 1080 x 1080 | Square artwork |

The release exporter includes the entire collection in its versioned graphics ZIP.
Setting GitHub's actual social preview is a separate repository-setting action;
creating the image does not establish that the setting was applied.

`setup-wizard-fixture.*` and its text transcript are existing disposable fixture
illustrations. They remain labeled as fixtures and are not presented as native UI
captures.

## Native OMP walkthrough

The checked-in native screenshots, video, transcript, and provenance are an
earlier genuine development capture whose UI displays the former CruxOmni name.
They are retained as historical evidence and have not been relabeled or edited to
show the current brand. Replace them only with a genuine capture from a newly
qualified native package, preserving the captured source and output provenance.

[`native/omp-18.12.5/`](native/omp-18.12.5/walkthrough.md) contains a genuine
capture of the compiled OMP 18.12.5 terminal running this plugin in a disposable
profile. The setup screenshot shows the real setup menu. The two administration
screenshots show the fallback-chain and model-capability-override browsers. The
six selected descriptors from two families appeared as available in the captured
source snapshot; they are representative screens, not a complete operation
inventory. Current release eligibility may differ. See the linked [capture provenance](native/omp-18.12.5/provenance.json)
and [current eligibility inventory](../contracts/release-eligibility.json). The
walkthrough cancels at each operation prompt; it sends no administration request
and makes no claim about a live OmniRoute server. The local fixture is used only
by the existing smoke setup and is not an oracle for server administration
behavior.

| File | Description |
| --- | --- |
| [setup-wizard.png](native/omp-18.12.5/setup-wizard.png) | Native setup menu; configuration is cancelled before entry. |
| [admin-fallback-chains.png](native/omp-18.12.5/admin-fallback-chains.png) | Fallback-chain operations shown as available in the captured source snapshot, with the cancelable operation prompt. |
| [admin-model-capability-overrides.png](native/omp-18.12.5/admin-model-capability-overrides.png) | Override operations shown as available in the captured source snapshot, with the cancelable operation prompt. |
| [native-walkthrough.mp4](native/omp-18.12.5/native-walkthrough.mp4) | Three selected actual PTY screens, each held for two seconds; no audio. |
| [walkthrough.md](native/omp-18.12.5/walkthrough.md) | Accessible static descriptions and a text alternative to the video. |
| [terminal-transcript.txt](native/omp-18.12.5/terminal-transcript.txt) | Sanitized screen text captured from the same run. |
| `native/omp-18.12.5/provenance.json` | Source, OMP binary, font, tool, renderer and output digests. |
| `native/omp-18.12.5/third-party-notices.txt` | Pinned OMP MIT license and the renderer font's SIL OFL notice. |

To reproduce this Linux x64 capture, use Bun 1.4.2, the checksum-pinned OMP 18.12.5
Linux x64 executable, Python with Pillow 10.2.0, tmux, ffmpeg with its MPEG-4
encoder, fontconfig, and npm on `PATH`:

```sh
python3 scripts/capture-walkthrough.py \
  --bun /absolute/path/to/bun-1.4.2 \
  --omp-binary /absolute/path/to/omp-linux-x64
```

The script creates a private named-pipe PTY mirror and a tmux server at its own
absolute socket under `.agents/state/`. It uses `-f /dev/null`, does not attach to
or inspect a user's tmux server, and keeps raw frames and smoke logs private.
Before replacing an existing versioned output, it verifies that directory's
`SHA256SUMS` and moves it to a private recovery path under `.agents/state/`. A
failed capture restores the prior output. Package input hashes are recorded
immediately before smoke and checked again before publishing new media. No
desktop capture, external upload, or live management request is part of this
workflow.

Copyright © 2026 Crux Experts LLC. https://www.cruxexperts.com/

Private asset. Property of Crux Experts LLC. Use, reproduction, modification,
distribution, or publication without prior written permission is prohibited.
See [the asset license](../ASSET_LICENSE.md) for existing asset grants and notices.
