---
title: "OMP OmniRoute Provider: Brand Identity and Editorial System"
type: "brand-identity-and-content-standard"
project: "CruxExperts/OMP-OmniRoute-Provider"
version: "1.0.0"
prepared_date: "2026-10-22"
timezone: "America/Chicago"
status: active
source_revision: "63bda63a6c72d63dc63b3bcb6813b788932ef6d3"
owner: docs/branding.md
---

# OMP OmniRoute Provider
## Brand identity and editorial system

### The central idea

**Your OmniRoute models. Right inside Oh My Pi.**

This is a practical connection, not another platform to sell someone. A person who already has an OmniRoute gateway should immediately understand that they can bring its available models into OMP without rebuilding every provider connection there.

The brand should make that relationship obvious, make the first successful connection feel approachable, and show enough real product evidence to earn trust. The visual polish supports those jobs. It does not substitute for them.

This is a refinement of the existing project identity. It retains the routed-connection mark, navy/teal product palette, canonical naming, technical identifiers, and genuine interface evidence. It is not an authorization to rename the package or redesign the parent company logo. Existing policy remains the source of truth for protected identifiers. [R1]

## 1. Positioning

### The product in one sentence

OMP OmniRoute Provider is an OMP plugin that connects Oh My Pi to an existing OmniRoute gateway through guided setup and live model discovery.

### The useful difference

The user has already done work in OmniRoute: connected providers, arranged access, and established routes. The plugin lets that work become useful inside OMP. The promise is reduced repeated setup, not unlimited models, guaranteed savings, or a different AI service.

### Primary audience

The main reader wants to use an AI coding assistant and has access to OmniRoute. They may know what a terminal is but not care about package internals, credential references, schema qualification, or transport adapters. They need to know what to install, where to enter a command, what information to have ready, and how to recognize the plugin in the interface.

A second reader manages the gateway and wants optional administration. A third contributes code. The README must serve those readers without making everyone else read their manuals first.

### The job the homepage must accomplish

A new visitor should be able to answer these questions in order: “What is it?” “Is it for my setup?” “What does it save me doing?” “What do I need?” “What exactly do I type?” “What will I see?” “Where do I go if it fails?”

The desired action is a successful, verified connection. A star is welcome, but it is not the first call to action.

### Positioning boundaries

The plugin does not install or host OmniRoute, grant provider accounts, supply a free AI quota, download model weights, or guarantee that all available models work equally well for every coding task. It is not a complete replacement for the OmniRoute dashboard. Optional administration is limited to qualified operations. [R2–R5]

## 2. Brand architecture and exact naming

Use one product identity, with an explicit parent endorsement and respectful upstream attribution.

| Context | Exact wording | Rule |
| --- | --- | --- |
| Project title | **OMP OmniRoute Provider** | Canonical public product name. |
| First explanation | **An OMP plugin that connects Oh My Pi to an existing OmniRoute gateway.** | Explain the relationship before adding features. |
| OMP login menu | **Crux OmniRoute Provider** | Match the actual visible selector label. |
| Parent company | **Crux Experts LLC** | Use the official logo and correct company name. |
| Upstream client | **Oh My Pi (OMP)** | Spell out at first mention, then use OMP. |
| Upstream gateway | **OmniRoute** | Keep its own name; do not imply ownership. |
| Repository | `OMP-OmniRoute-Provider` | Do not rename as a branding cleanup. |
| Provider identity | `omniroute` | Preserve model prefixes and credential identities. |
| Package | `@cruxexperts/cruxomni-omp-client` | Preserve compatibility; not a prose spelling error. |
| Main command | `/omniroute` | Use in new user-facing examples. |
| Other command families | `/omniroute-admin`, `/omniroute-pricing` | Keep exact spelling. |

Historical `/cruxomni*` aliases remain supported. Historical tags, genuine older screenshots, and evidence records are not to be rewritten to look current. [R1]

The parent company's rainbow-infinity logo and this product's routed-connection mark have different roles. Do not swap them, recolor either, or invent a combined emblem. The project can retain a disciplined navy/teal identity while being visibly made by Crux Experts.

## 3. Message hierarchy

### Primary headline

**Your OmniRoute models. Right inside Oh My Pi.**

It names the two tools and the result. It does not ask an unfamiliar visitor to decode an abstract slogan.

### Supporting line

**Connect the AI setup you already have to the coding assistant you want to use.**

### Core explanation

**You have already connected your AI providers in OmniRoute. You should not have to repeat that setup just to use them in Oh My Pi. Enter your gateway address and access key, choose an available model, and work inside OMP.**

### Three benefit pillars

**Keep your existing setup.** Provider accounts and routing stay in OmniRoute. The plugin connects OMP to the gateway rather than duplicating those provider configurations.

**Choose from the models your gateway exposes.** Discovery comes from the live connection. Optional information enriches the choices; it does not invent availability.

**Add complexity only when you need it.** The first connection does not require optional catalogs, pricing projections, or administration.

### Trust message

**Real screens. Clear instructions. No mystery about what connects where.**

Support this with the actual screenshot set, honest version notes, the credential-storage guide, and a visible help path. Do not turn it into an absolute security or privacy claim.

### Calls to action

Primary: **Get started** or **Connect OMP to OmniRoute**.

Secondary: **See the real screens**.

Recovery: **Get help** or **Open the troubleshooting guide**.

The primary destination is the install/setup section, not a general release page containing multiple unfamiliar artifacts. The release link is useful as a secondary reference.

## 4. Voice and writing rules

Write like a helpful product owner sitting beside the user. Be direct, warm, specific, and practical. Explain what something does before naming its internals.

Use short paragraphs and concrete verbs: connect, enter, choose, check, refresh. A heading should tell the reader what follows, not merely sound impressive. Do not make every paragraph a slogan. Leave marketing emphasis for the opening, benefit section, and final call to action.

Spell out OMP once. Introduce “runtime API key” as the gateway access key used for model requests. Keep the exact term in parentheses or the following sentence so it still matches documentation. Explain a gateway as the separate place where providers and routing are configured, not as an SDK abstraction.

Tell the reader whether a command belongs in the normal shell or inside OMP. Do not put shell prompts, dollar signs, or angle-bracket placeholders into a command advertised as ready to paste. A placeholder must be visibly explained, and an environment-variable configuration belongs in the advanced documentation rather than the default path.

### Before and after

| Avoid | Prefer |
| --- | --- |
| “Unlock seamless multi-provider inference orchestration.” | “Use your OmniRoute models inside OMP.” |
| “Register your runtime credential through host-native AuthStorage.” | “Enter the access key for your gateway. OMP handles the saved credential.” |
| “Full administration of your AI infrastructure.” | “Optional administration for selected supported operations.” |
| “All your favorite models, instantly available.” | “Choose from the compatible chat models your gateway exposes.” |
| “Enterprise-grade security.” | “The key prompt is masked; optional administration uses separate credentials.” |
| “Free AI, without limits.” | “MIT-licensed source. Provider usage and hosting may have their own costs.” |
| “Latest-version screenshots.” | “User-supplied screenshots; visible version details are recorded.” |

Do not use fabricated testimonials, usage counts, comparisons, savings percentages, benchmark scores, partner badges, or claims of official upstream endorsement. Do not portray source-code inspection or a screenshot as a successful runtime test.

## 5. Visual identity

### Design character

Quiet, precise, terminal-native, and credible. The product should look intentional rather than decorated. Large readable typography, modest borders, complete real screenshots, and controlled accents carry the design.

Retain the canonical navy `#101C2D` and teal `#39B7AA`. The broader palette extends those values for readable text and light-theme use. The design tokens live in `assets/brand/marketing/tokens.json` and `tokens.css`.

The company-level preference for disciplined geometry and generous negative space carries through. Elaborate metal imagery does not belong behind a terminal walkthrough. Avoid fake terminal windows, glowing circuit wallpaper, floating cubes, stock people, robot mascots, invented logos, or a collage of vendor logos. The UI itself supplies the visual evidence.

### Semantic color system

| Role | Dark treatment | Light treatment |
| --- | --- | --- |
| Canvas | `#101C2D` | `#F5F8FC` |
| Raised panel | `#16263B` | `#E9EFF6` |
| Primary text | `#F5F8FC` | `#101C2D` |
| Secondary text | `#A5B5C7` | `#43566D` |
| Link / readable accent | `#58CFC1` | `#087569` |
| Decorative brand teal | `#39B7AA` | `#39B7AA` |
| Border | `#33485F` | `#C6D4E3` |
| Success text | `#81D4A7` | `#216E48` |
| Warning text | `#F0C674` | `#805700` |
| Error text | `#FF9B9B` | `#A8242B` |

The canonical logo teal is not automatically a suitable small-text color on a light canvas. Use the separate readable accent token. Do not recolor captured interfaces to match the design. Purple belongs to OMP's actual UI where it appears; it does not need to become another dominant product accent.

Keep functional status understandable without color alone. Decorative borders are not substitutes for readable labels, text contrast, or focus indicators. Palette checks alone do not certify an entire interface.

### Typography

Public README prose uses GitHub's normal typography. Do not attempt to force custom fonts or CSS into GitHub Markdown.

Editable graphic masters use **DejaVu Sans** for titles and labels, matching the existing exporter family. **DejaVu Sans Mono** is reserved for commands, technical labels, and privacy replacement text. No font binaries are included in this pack.

For standalone previews, use system sans-serif and monospace stacks. Reference CSS can describe the presentation but must not become a dependency of the GitHub README.

Suggested graphic hierarchy at a 1280-pixel social canvas: a 54–64-pixel main headline, 24–28-pixel product title and supporting text, 14–16-pixel secondary labels, and 11–12-pixel nonessential provenance labels. Never place an essential setup instruction in tiny graphic text. The complete instruction remains selectable Markdown.

### Spacing and shapes

Use an eight-pixel spacing base with 4, 8, 16, 24, 32, 48, and 64-pixel steps. Major social cards keep roughly 48 pixels of outside breathing room. Showcase panels use 10–12-pixel corner radii, restrained one- or two-pixel borders, and no heavy glow.

Aligned screenshot panels need not have the same height when the original viewport proportions differ. Never stretch one to fit the other. Empty terminal space is part of the supplied screenshot and must not be trimmed away to make a tighter layout.

## 6. Logo system and asset authority

### Product mark

The supplied `product-mark-dark.svg` and `product-mark-light.svg` preserve the exact existing repository source bytes. Their Git blob hashes were checked against the fetched originals. The mark is not newly invented.

Use the light-stroke version on dark backgrounds and the navy-stroke version on light backgrounds. Preferred display size is 48–64 pixels near the README heading, 56–72 pixels in a social card, and no smaller than 24 pixels for an identification use. Preserve its 1:1 aspect ratio and keep clear space around it.

### Company endorsement

`crux-experts-official.jpg` is the supplied official logo, copied without changing its pixels. The available source is **480 × 94**, with a black background. It must not be described as a transparent or vector master.

Use it at or below its native dimensions, preferably 240 × 47 in this package. Keep the black background as supplied. Do not erase it, isolate the infinity symbol, trace it, recolor the lettering, or regenerate it. The source limitation is better handled by a modest endorsement placement than by an invented “higher-resolution” logo.

### Upstream identity

OMP's pixel symbol and OmniRoute's UI identity appear as part of real screenshots. Do not extract those marks and present them as original Crux Experts branding. Use text attribution and preserve the existing third-party notices. [R1, R6]

## 7. Screenshot fidelity and privacy

### Native masters

The authoritative screenshots in this package come from the original user uploads, not any image-generated reconstruction in earlier conversation turns.

All six OMP masters use the exact crop rectangle `(0, 65, 1206, 841)` from their 1212 × 841 inputs. The result is **1206 × 776**. This removes only the title/tab area and right scrollbar. It preserves all terminal content, internal margins, and blank space.

The gateway master uses `(0, 118, 1226, 1177)`, giving **1226 × 1059** after browser chrome removal.

No master is resized, stretched, sharpened, contrast-enhanced, recentered, or re-typeset as a whole. The only non-crop changes are bounded privacy edits: shell identity, private status metadata, the private gateway address, and recent request activity. Replacement text is generic. The shell reads `user@workstation:project$ omp`.

The full recorded output must match the cropped source pixel for pixel outside those redaction rectangles. The package records input and output hashes, crop geometry, redaction regions, and a changed-pixels-outside-redactions count. That count is zero for every supplied screenshot.

### Presentation derivatives

The showcase and social-preview graphics are separately named composition exports. They may proportionally scale sanitized screenshot masters to fit a layout. They are not pixel-faithful masters and must never replace the native PNGs. Maintain aspect ratio and use the full screenshot viewport, not a content-only crop.

A layered social composition may naturally overlap screenshots; its source and caption must make clear that it is a composition. Do not edit visible UI values, names, success states, or version numbers to improve marketing. A new claimed release needs a real new capture.

### Provenance and version wording

The startup screen visibly shows OMP **18.12.6**. The same supplied set contains native provider selection and sign-in screens, but those images do not expose a plugin package version. The gateway image shows **3.8.51**, with the user's customized CruxOmni label. Keep these observations separate from the repository's declared compatibility and test matrix.

The provider selector already shows a logged-in state in this user's session. Do not describe that as the default state of a new installation. The key prompt is empty. The address prompt contains public examples, which are not private credentials and should remain intact.

### Metadata and rights

Publish only sanitized derivatives. Do not add the original identifying screenshots to the public repository or to this delivery archive. New PNG derivatives contain minimal copyright information, not user paths, hostnames, capture-location data, prompts, tool-session details, or API keys. The supplied official logo remains an unchanged source asset.

Retain the existing split between MIT-licensed source/documentation and separately licensed visual assets. Do not use the visual pack to silently expand or restrict the repository's licensing terms. [R6]

## 8. GitHub homepage composition

The README must function without custom CSS, JavaScript, external font loading, video autoplay, or interactive widgets. The supplied version uses Markdown, modest HTML image/picture blocks, links, and collapsible detail sections.

The first viewport contains the name, concrete outcome, primary action, three modest identification badges, and a real-UI showcase. The story then moves through benefit, product relationship, setup, proof, everyday commands, optional depth, trust, common questions, compatibility, help, and a final call to action.

Do not add a large wall of shields, sponsor requests, animated typing banners, fake certification badges, or a dense provider-logo collage above setup. Technical accuracy belongs throughout, but detailed administration contracts belong in the linked guides.

Keep setup commands as copyable code blocks. Relative image/document links make the branch self-contained. Check whether `.github/README.md` exists, because GitHub can select that before a root README. [G1]

### Mobile behavior

The live H1, subtitle, navigation links, and paragraphs must reflow. Screenshots scale proportionally in the page, with a linked native-resolution file for closer inspection. Important UI labels are described in the surrounding prose, not available only inside a scaled image.

The facts table has two columns. Avoid using three-column feature cards as the sole source of essential information. Long commands may scroll in their own code block; the entire page must not overflow horizontally.

### Theme behavior

The showcase has dark and light variants. Product marks also have theme-appropriate variants. Captured UI itself remains unchanged in both themes. The default fallback image is the light treatment. Verify actual rendering on GitHub; a local preview does not perfectly reproduce GitHub's sanitization or CSS.

## 9. Social preview and launch copy

Use the supplied **1280 × 640** `social-preview.png` as the candidate repository social card. GitHub recommends that size for best display and requires a supported raster image under 1 MB. A committed image is not automatically the selected Social Preview image. The setting and the externally served preview must be checked separately. [G2]

The social card communicates the product and its result. It does not try to teach installation inside a small thumbnail. A person who follows it should land on a README that repeats the same promise and immediately offers setup.

Use the reusable headline, repository description, release-opening paragraph, and Facebook copy in [the copy deck](brand-copy.md). Do not add new feature claims to fill visual space.

## 10. Maintenance and governance

The repository exporter, `scripts/export-media.py`, owns the established graphics and the marketing family. Editable composites and design tokens live under `assets/brand/marketing/`; the asset manifest records their provenance. Do not overwrite generated references, erase historical screenshot provenance, change package identifiers, or remove older compatibility aliases.

The pack's version is **1.0.0**. That is a brand-package version, not a plugin release. The README's `v1.0.2` installation is tied to the audited repository snapshot. Any future release update must reconcile the install command, release badge, source version, compatibility notes, and current documentation together.

Keep a clear distinction among the editable source, generated export, sanitized screenshot master, and publication setting. A file existing is not proof that a social card is selected; a command appearing in prose is not proof that it was executed; an image looking polished is not proof of a feature.

## 11. Editorial acceptance standard

The homepage is ready when a reader unfamiliar with the internals can understand the relationship between the products, find the exact install command, tell the shell from OMP's prompt, recognize the provider name, connect with their own gateway credentials, and find help without reading the contributor guide.

The identity is ready when the actual company logo is intact, the product mark is consistent, the palette is readable in both themes, every screenshot is genuine and sanitized, and the claims agree with the release evidence.

That is the quality bar: a convincing product page that remains useful after the first impression.

## Evidence references

- **R1:** [Existing naming/branding policy](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/docs/branding.md).
- **R2:** [Installation and credential handling](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/docs/installation.md).
- **R3:** [Everyday behavior](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/docs/first-use.md).
- **R4:** [Administration scope](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/docs/administration.md).
- **R5:** [Generated compatibility and operation inventory](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/docs/reference/generated.md).
- **R6:** [Existing visual asset license](https://github.com/CruxExperts/OMP-OmniRoute-Provider/blob/63bda63a6c72d63dc63b3bcb6813b788932ef6d3/ASSET_LICENSE.md).
- **G1:** [GitHub README guidance and relative links](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes).
- **G2:** [GitHub social-preview requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

The official company logo is used unchanged. Screenshot capture notes are in [the visual walkthrough](visual-walkthrough.md); asset hashes and source ownership are recorded in `assets/brand/manifest.json`.
