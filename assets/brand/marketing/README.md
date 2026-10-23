# Marketing asset family

The product marks preserve the canonical existing SVG bytes. The official Crux Experts company logo is an unchanged 480 × 94 JPEG from the user's supplied artwork.

`showcase-dark.png` and `showcase-light.png` are 1600 × 840 compositions of the sanitized real screenshots. They scale the complete viewports proportionally. `social-preview.png` is a 1280 × 640 raster social card. These are presentation derivatives, not native screenshot masters.

The editable raster-in-SVG composition sources are under `sources/`. `scripts/export-media.py --marketing-only` renders them and updates the shared `assets/brand/manifest.json` without rebuilding historical exports. Use a Python environment that already has Pillow and CairoSVG; the exporter does not install dependencies.

The supplied PNG pixels were produced with CairoSVG 2.8.2 and Pillow 12.3.0. The available rendering environment used for integration has CairoSVG 2.9.1 and Pillow 13.0.0; a temporary render comparison differed at the pixel level. The supplied composition pixels are retained in this checkout, with metadata text chunks added. For pixel-identical regeneration, use the renderer versions recorded in the manifest.

The badges identify the documented source release, source license, and OMP plugin relationship. They are not test-status, security-certification, popularity, or upstream-endorsement badges.

Selecting the GitHub Social Preview image is a separate repository-setting action. Merely adding these files does not make the social card active.

Keep the existing source/documentation license separate from the visual-asset license. Preserve third-party notices. Do not redraw the product interfaces, recolor the logos, or restore private screenshot details.
