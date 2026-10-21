<p align="center">
  <img src="assets/brand/banner.png" alt="CruxOmni OMP Client: your gateway, inside Oh My Pi" width="100%">
</p>

<h1 align="center">CruxOmni-OMP-Client</h1>

[![CI](https://github.com/CruxExperts/CruxOmni-OMP-Client/actions/workflows/ci.yml/badge.svg)](https://github.com/CruxExperts/CruxOmni-OMP-Client/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/source-MIT-blue)](LICENSE)

<p align="center">
  Connect Oh My Pi to OmniRoute without hand-editing config files or juggling API keys.
</p>

<p align="center">
  <a href="https://github.com/CruxExperts/CruxOmni-OMP-Client/releases/latest">Download</a>
  · <a href="docs/installation.md">Setup guide</a>
  · <a href="docs/troubleshooting.md">Troubleshooting</a>
</p>

## Why use it?

CruxOmni is an OMP extension that connects to your existing OmniRoute server.
The server runs your gateway and manages provider accounts; the client provides
setup, live model discovery, inference, and qualified administration inside OMP:

- Run one command and follow the setup wizard.
- Discover the models your OmniRoute instance actually offers. No static list
  to babysit.
- Keep runtime keys in OMP's masked credential storage, not a JSON file.
- See the difference between known, unknown, conditional, and stale prices.
- Preview and confirm sensitive admin actions before anything happens.

Administration coverage is still in progress. Only operations with qualification
evidence are callable; see the [generated capability inventory](docs/reference/generated.md).

## Get started

For a qualified, published version, install the package through OMP's native
installer:

```text
omp install @cruxexperts/cruxomni-omp-client@<qualified-version>
```

After installation, restart OMP and open the setup wizard:

```text
/cruxomni setup
```

Connection setup comes first. Pricing, metadata, and administration are
optional, so the wizard can stay as simple as you need it to be.

<p align="center">
  <img src="assets/native/omp-18.12.5/setup-wizard.png" alt="CruxOmni setup menu running inside Oh My Pi 18.12.5 in a disposable terminal profile" width="760">
</p>

This is the real setup menu in an isolated OMP session with disposable data.
The [short native walkthrough and text alternative](assets/native/omp-18.12.5/walkthrough.md)
also show the administration browser. The capture cancels before an administration
request; it does not establish complete release qualification.

## Everyday commands

Open `/cruxomni setup` to connect, `/cruxomni` to inspect status, and
`/cruxomni refresh` to rediscover models. Use `/cruxomni-pricing` to inspect
pricing, or `/cruxomni-admin` for the optional administration workflow.
The [registered command table](docs/reference/generated.md#registered-commands)
is generated from the extension source.

## Optional metadata catalogs

The setup wizard's **Catalogs (optional)** section can enrich live models from
Models.dev or OpenRouter. Both are off by default. They cannot add runnable
models, change trusted prices, or download model weights. See the
[catalog setup and source conditions](docs/installation.md#optional-metadata-catalogs)
before enabling a source.

## Prefer environment variables?

They are still available for automation and read-only environments:

```bash
export OMP_OMNIROUTE_BASE_URL="https://gateway.example"
export OMP_OMNIROUTE_API_KEY="$RUNTIME_KEY"
```

Set both values together. For normal interactive use, the wizard is easier.

## Requirements

- Oh My Pi `>=18.12.2 <19`
- Bun `>=1.4.2` for source development and package checks
- An OmniRoute endpoint and runtime API key

The declared compatibility floor is OMP `18.12.2`. The [generated reference](docs/reference/generated.md)
lists source versions and historical host claims separately. Release acceptance
requires fresh upstream checks and the same package archive passing all eight
OMP targets. The 1.0.0 release remains in preparation; use the local checkout
instructions until an accepted package is published.

## More

- [Installation and guided setup](docs/installation.md)
- [First use and everyday work](docs/first-use.md)
- [Administration](docs/administration.md)
- [Upgrade and removal](docs/upgrading.md)
- [Troubleshooting and recovery](docs/troubleshooting.md)
- [Generated commands and compatibility](docs/reference/generated.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Releases and changes](CHANGELOG.md)

---

<p align="center">
  © 2026 <a href="https://www.cruxexperts.com/">Crux Experts LLC</a> · Released under the <a href="LICENSE">MIT License</a>
</p>
