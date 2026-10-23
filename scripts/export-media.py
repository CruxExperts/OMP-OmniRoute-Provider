#!/usr/bin/env python3
"""Export and verify the repository's brand and marketing media assets."""
import argparse
from html import escape
import hashlib
from io import BytesIO
import json
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin


ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "assets/brand"
MARKETING = DEST / "marketing"
MARKETING_SOURCES = MARKETING / "sources"
SCREENSHOT_MANIFEST = MARKETING / "screenshot-manifest.json"
PRODUCT_NAME = "OMP OmniRoute Provider"
REPOSITORY_NAME = "OMP-OmniRoute-Provider"
PROVIDER_NAME = "Oh My Pi provider"
CLIENT_LABEL = "OH MY PI PROVIDER"
COPYRIGHT = "Copyright © 2026 Crux Experts LLC"
WEBSITE = "https://www.cruxexperts.com/"
RIGHTS = "Private asset. Property of Crux Experts LLC. Use, reproduction, modification, distribution, or publication without prior written permission is prohibited."
MARKETING_COPYRIGHT = f"{COPYRIGHT}. Third-party interface rights retained."
DARK, LIGHT, ACCENT, MUTED = "#101c2d", "#f5f8fc", "#39b7aa", "#a5b5c7"
FONT = ImageFont.truetype("DejaVuSans.ttf", 24).path
BOLD = ImageFont.truetype("DejaVuSans-Bold.ttf", 24).path
MARKETING_OUTPUTS = {
    "showcase-dark": (1600, 840),
    "showcase-light": (1600, 840),
    "social-preview": (1280, 640),
}
MARKETING_SCREENSHOTS = (
    "assets/screenshots/omp-real-use/04-provider-selection.png",
    "assets/screenshots/omp-real-use/07-omniroute-home.png",
)


class Drawing:
    def __init__(self, name, width, height, background, description):
        self.name, self.width, self.height = name, width, height
        self.description = description
        self.image = Image.new("RGBA", (width, height), background or (0, 0, 0, 0))
        self.draw = ImageDraw.Draw(self.image)
        self.svg = []
        if background:
            self.svg.append(f'<rect width="{width}" height="{height}" fill="{background}"/>')

    def line(self, points, color, width):
        self.draw.line(points, fill=color, width=width, joint="curve")
        self.svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"/>')

    def circle(self, x, y, radius, color):
        self.draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=color)
        self.svg.append(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="{color}"/>')

    def text(self, x, y, value, size, color, bold=False):
        font = ImageFont.truetype(BOLD if bold else FONT, size)
        bounds = self.draw.textbbox((x, y), value, font=font, anchor="lt")
        if bounds[0] < 0 or bounds[1] < 0 or bounds[2] > self.width or bounds[3] > self.height:
            raise ValueError(f"Text outside {self.name} canvas: {value!r} at {bounds}")
        self.draw.text((x, y), value, font=font, fill=color, anchor="lt")
        # SVG uses an explicit font and top-aligned glyph box, matching the raster layout.
        ascent = font.getbbox(value)[1]
        weight = "700" if bold else "400"
        self.svg.append(f'<text x="{x}" y="{y-ascent+size}" font-family="DejaVu Sans" font-size="{size}" font-weight="{weight}" fill="{color}">{escape(value)}</text>')

    def mark(self, x, y, size, foreground):
        def points(values): return [(round(x+a*size), round(y+b*size)) for a,b in values]
        stroke = max(2, round(size*.055))
        self.line(points([(.27,.18),(.08,.5),(.27,.82)]), foreground, stroke)
        self.line(points([(.73,.18),(.92,.5),(.73,.82)]), foreground, stroke)
        self.line(points([(.33,.68),(.49,.68),(.49,.32),(.67,.32)]), ACCENT, stroke)
        for a,b in [(.33,.68),(.67,.32)]: self.circle(round(x+a*size),round(y+b*size),max(3,round(size*.06)),ACCENT)

    def save(self):
        title = f"{PRODUCT_NAME} {self.name.replace('-', ' ')}"
        metadata = f'<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{escape(title)}</dc:title><dc:creator>Crux Experts LLC</dc:creator><dc:source>{WEBSITE}</dc:source><dc:rights>{escape(COPYRIGHT + ". " + RIGHTS)}</dc:rights></metadata>'
        content = f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" viewBox="0 0 {self.width} {self.height}" role="img" aria-labelledby="title description"><title id="title">{escape(title)}</title><desc id="description">{escape(self.description)}</desc>{metadata}{"".join(self.svg)}</svg>\n'
        (DEST / f"{self.name}.svg").write_text(content)
        info = PngImagePlugin.PngInfo()
        for key,value in {
            "Title": title,
            "Description": self.description,
            "Author": "Crux Experts LLC",
            "Copyright": COPYRIGHT,
            "Source": WEBSITE,
            "License": RIGHTS,
            "Software": f"{PRODUCT_NAME} reproducible media exporter",
        }.items():
            info.add_itxt(key, value)
        self.image.save(DEST / f"{self.name}.png", pnginfo=info, optimize=False, compress_level=9)


def export_legacy_assets():
    DEST.mkdir(parents=True, exist_ok=True)
    for theme,background,foreground in [("dark",DARK,LIGHT),("light",LIGHT,DARK)]:
        icon = Drawing(f"icon-{theme}",256,256,None,f"Routed connection mark for {PRODUCT_NAME}, the {PROVIDER_NAME}.")
        icon.mark(16,16,224,foreground);icon.save()

        wordmark = Drawing(f"wordmark-{theme}",1000,240,background,f"{PRODUCT_NAME}, identified as the {PROVIDER_NAME}, with the routed connection symbol.")
        wordmark.mark(30,30,180,foreground)
        wordmark.text(248,32,"OMP",54,foreground,True)
        wordmark.text(252,96,"OmniRoute Provider",38,foreground,True)
        wordmark.text(254,159,CLIENT_LABEL,22,ACCENT,True)
        wordmark.save()

    for name,width,height in [("social",1280,640),("banner",1600,640),("square",1080,1080)]:
        art = Drawing(name,width,height,DARK,f"{PRODUCT_NAME}, the {PROVIDER_NAME}. Connect Oh My Pi to your OmniRoute gateway with guided setup, live models, and reviewed administration.")
        art.line([(64,64),(width-64,64)],ACCENT,3)
        art.mark(68,112,200,LIGHT)
        art.text(310,102,"OMP",70,LIGHT,True)
        art.text(314,183,"OmniRoute Provider",48,LIGHT,True)
        art.text(318,253,CLIENT_LABEL,28,ACCENT,True)
        top=400 if height==640 else 500
        art.text(80,top,"Your OmniRoute gateway, inside Oh My Pi.",36,LIGHT)
        art.text(82,top+62,"Guided setup  /  Live models  /  Reviewed changes",23,MUTED)
        art.text(82,height-70,"CRUX EXPERTS LLC",18,MUTED,True)
        art.save()

def _image_dimensions(path: Path) -> tuple[int, int, str]:
    with Image.open(path) as image:
        return image.width, image.height, image.format or "unknown"


def _screenshot_provenance() -> dict:
    data = json.loads(SCREENSHOT_MANIFEST.read_text(encoding="utf-8"))
    for item in data.get("items", []):
        path = ROOT / item["filename"]
        if not path.is_file():
            raise FileNotFoundError(path)
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != item["sha256"]:
            raise ValueError(f"Screenshot hash mismatch for {item['filename']}: {actual}")
    return data


def _svg_metadata(path: Path) -> tuple[str, str, tuple[int, int]]:
    root = ElementTree.fromstring(path.read_bytes())
    namespace = "{http://www.w3.org/2000/svg}"
    title = root.find(f"{namespace}title")
    desc = root.find(f"{namespace}desc")
    if title is None or not title.text or desc is None or not desc.text:
        raise ValueError(f"Marketing SVG needs a title and description: {path}")
    width, height = int(float(root.attrib["width"])), int(float(root.attrib["height"]))
    source_text = path.read_text(encoding="utf-8")
    if "<dc:creator>Crux Experts LLC</dc:creator>" not in source_text:
        raise ValueError(f"Marketing SVG is missing company creator metadata: {path}")
    if WEBSITE not in source_text or RIGHTS not in source_text or COPYRIGHT not in source_text or "Third-party interface rights retained." not in source_text:
        raise ValueError(f"Marketing SVG is missing source or rights metadata: {path}")
    return title.text, desc.text, (width, height)


def export_marketing_assets() -> dict[str, str]:
    try:
        import cairosvg
    except ImportError as error:
        raise RuntimeError("Marketing export requires CairoSVG in the selected Python environment.") from error

    provenance = _screenshot_provenance()
    declared = {item["filename"]: item["sha256"] for item in provenance["items"]}
    for filename in MARKETING_SCREENSHOTS:
        actual = hashlib.sha256((ROOT / filename).read_bytes()).hexdigest()
        if declared.get(filename) != actual:
            raise ValueError(f"Marketing screenshot input is not covered by provenance: {filename}")

    MARKETING.mkdir(parents=True, exist_ok=True)
    for name, expected_size in MARKETING_OUTPUTS.items():
        source = MARKETING_SOURCES / f"{name}.svg"
        if not source.is_file():
            raise FileNotFoundError(source)
        title, description, source_size = _svg_metadata(source)
        if source_size != expected_size:
            raise ValueError(f"Unexpected source dimensions for {source}: {source_size}, expected {expected_size}")

        svg_bytes = source.read_bytes()
        rendered_bytes = cairosvg.svg2png(
            bytestring=svg_bytes,
            output_width=expected_size[0],
            output_height=expected_size[1],
        )
        with Image.open(BytesIO(rendered_bytes)) as image:
            if image.size != expected_size:
                raise ValueError(f"Unexpected rendered dimensions for {name}: {image.size}")
            output = image.convert("RGB")

        metadata = PngImagePlugin.PngInfo()
        for key, value in {
            "Title": title,
            "Description": description,
            "Author": "Crux Experts LLC",
            "Copyright": MARKETING_COPYRIGHT,
            "Source": WEBSITE,
            "License": RIGHTS,
            "Software": f"{PRODUCT_NAME} exporter; CairoSVG {cairosvg.__version__}; Pillow {Image.__version__}",
            "Attribution": "Third-party interface rights retained.",
        }.items():
            metadata.add_itxt(key, value)
        path = MARKETING / f"{name}.png"
        output.save(path, pnginfo=metadata, optimize=True, compress_level=9)
        if name == "social-preview" and path.stat().st_size >= 1_000_000:
            raise ValueError("Social preview exceeds the 1 MB GitHub image limit.")
        print(json.dumps({"status": "rendered", "asset": path.relative_to(ROOT).as_posix(), "size": output.size, "bytes": path.stat().st_size}))

    return {"CairoSVG": cairosvg.__version__, "Pillow": Image.__version__}


def _file_records(previous: dict) -> list[dict]:
    old_records = {entry["path"]: entry for entry in previous.get("files", [])}
    records = []
    for path in sorted(item for item in DEST.rglob("*") if item.is_file() and item.name != "manifest.json"):
        name = path.relative_to(ROOT).as_posix()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        old = old_records.get(name)
        if old is not None and old.get("sha256") == digest:
            records.append(old)
            continue
        record = {"path": name, "sha256": digest}
        if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            width, height, image_format = _image_dimensions(path)
            record.update({"width": width, "height": height, "format": image_format})
        records.append(record)
    return records


def _marketing_manifest(previous: dict, renderer: dict | None) -> dict:
    screenshot_data = _screenshot_provenance()
    official_logo = MARKETING / "crux-experts-official.jpg"
    logo_width, logo_height, logo_format = _image_dimensions(official_logo)
    exports = []
    input_paths = list(MARKETING_SCREENSHOTS)
    for name, (width, height) in MARKETING_OUTPUTS.items():
        path = MARKETING / f"{name}.png"
        exports.append({
            "path": path.relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "width": width,
            "height": height,
            "format": "PNG",
            "sourceSvg": (MARKETING_SOURCES / f"{name}.svg").relative_to(ROOT).as_posix(),
            "sourceSvgSha256": hashlib.sha256((MARKETING_SOURCES / f"{name}.svg").read_bytes()).hexdigest(),
            "screenshotInputs": input_paths,
        })
    old_marketing = previous.get("marketing", {})
    return {
        "editableSource": "scripts/export-media.py",
        "compositionSources": [
            (MARKETING_SOURCES / f"{name}.svg").relative_to(ROOT).as_posix()
            for name in MARKETING_OUTPUTS
        ],
        "designTokens": [
            (MARKETING / "tokens.json").relative_to(ROOT).as_posix(),
            (MARKETING / "tokens.css").relative_to(ROOT).as_posix(),
        ],
        "exports": exports,
        "renderer": renderer or old_marketing.get("renderer", {
            "supplied": {"CairoSVG": "2.8.2", "Pillow": "12.3.0"},
            "availableForComparison": {"CairoSVG": "2.9.1", "Pillow": "13.0.0"},
            "pixelReproduction": "The available versions rendered different pixels; the supplied raster samples were retained.",
        }),
        "screenshotProvenance": {
            "manifest": SCREENSHOT_MANIFEST.relative_to(ROOT).as_posix(),
            "manifestSha256": hashlib.sha256(SCREENSHOT_MANIFEST.read_bytes()).hexdigest(),
            "items": [
                {
                    "path": item["filename"],
                    "sha256": item["sha256"],
                    "sourceSha256": item["source_sha256"],
                    "sourceKind": item["source_kind"],
                    "sourceSize": item["source_size"],
                    "cropRectangleXYXY": item["crop_rectangle_xyxy"],
                    "outputSize": item["output_size"],
                    "resizePerformed": item["resize_performed"],
                    "redactions": item["redactions"],
                    "pixelCheck": item["pixel_check"],
                    "altText": item["alt_text"],
                }
                for item in screenshot_data["items"]
            ],
        },
        "officialLogo": {
            "path": official_logo.relative_to(ROOT).as_posix(),
            "sha256": hashlib.sha256(official_logo.read_bytes()).hexdigest(),
            "size": [logo_width, logo_height],
            "format": logo_format,
            "sourceKind": "user-supplied official Crux Experts logo; original pixels retained",
            "copyright": COPYRIGHT,
            "source": WEBSITE,
            "rights": RIGHTS,
        },
    }


def write_manifest(renderer: dict | None = None, update_legacy_renderer: bool = False) -> dict:
    manifest_path = DEST / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    manifest = {
        "schemaVersion": 1,
        "productName": PRODUCT_NAME,
        "providerName": PROVIDER_NAME,
        "repositoryName": REPOSITORY_NAME,
        "sourceVersion": (ROOT / "VERSION").read_text(encoding="utf-8").strip(),
        "copyright": COPYRIGHT,
        "source": WEBSITE,
        "rights": RIGHTS,
        "editableSource": "scripts/export-media.py",
        "font": {
            "name": "DejaVu Sans",
            "regularSha256": hashlib.sha256(Path(FONT).read_bytes()).hexdigest(),
            "boldSha256": hashlib.sha256(Path(BOLD).read_bytes()).hexdigest(),
            "redistributed": False,
        },
        "renderer": previous.get("renderer", {"Pillow": Image.__version__}),
        "files": _file_records(previous),
    }
    if update_legacy_renderer:
        manifest["renderer"] = {"Pillow": Image.__version__}
    manifest["marketing"] = _marketing_manifest(previous, renderer)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def verify_assets() -> dict:
    manifest = json.loads((DEST / "manifest.json").read_text(encoding="utf-8"))
    expected = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    actual_paths = {
        path.relative_to(ROOT).as_posix()
        for path in DEST.rglob("*")
        if path.is_file() and path.name != "manifest.json"
    }
    if actual_paths != set(expected):
        missing = sorted(set(expected) - actual_paths)
        unregistered = sorted(actual_paths - set(expected))
        raise ValueError(f"Brand manifest file set mismatch: missing={missing}, unregistered={unregistered}")
    for name, digest in expected.items():
        actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        if actual != digest:
            raise ValueError(f"Brand manifest hash mismatch for {name}: {actual}")

    marketing = manifest["marketing"]
    screenshot_data = _screenshot_provenance()
    if hashlib.sha256(SCREENSHOT_MANIFEST.read_bytes()).hexdigest() != marketing["screenshotProvenance"]["manifestSha256"]:
        raise ValueError("Screenshot provenance manifest hash mismatch")
    if len(screenshot_data["items"]) != len(marketing["screenshotProvenance"]["items"]):
        raise ValueError("Screenshot provenance entry count mismatch")
    for source, recorded in zip(screenshot_data["items"], marketing["screenshotProvenance"]["items"]):
        if (source["filename"], source["sha256"], source["source_sha256"]) != (
            recorded["path"], recorded["sha256"], recorded["sourceSha256"]
        ):
            raise ValueError(f"Screenshot provenance record mismatch for {source['filename']}")
    required_metadata = {"Title", "Description", "Author", "Copyright", "Source", "License", "Software", "Attribution"}
    for name, (width, height) in MARKETING_OUTPUTS.items():
        path = MARKETING / f"{name}.png"
        _svg_metadata(MARKETING_SOURCES / f"{name}.svg")
        with Image.open(path) as image:
            if (image.width, image.height) != (width, height) or image.mode != "RGB":
                raise ValueError(f"Unexpected marketing image geometry or mode: {path}")
            missing = required_metadata - set(image.info)
            if missing:
                raise ValueError(f"Marketing PNG metadata missing {sorted(missing)}: {path}")
            if (image.info["Author"] != "Crux Experts LLC" or image.info["Source"] != WEBSITE
                or image.info["License"] != RIGHTS or image.info["Copyright"] != MARKETING_COPYRIGHT):
                raise ValueError(f"Marketing PNG company metadata mismatch: {path}")
        export_path = path.relative_to(ROOT).as_posix()
        export_record = next((item for item in marketing["exports"] if item["path"] == export_path), None)
        if export_record is None or export_record["sha256"] != expected[export_path]:
            raise ValueError(f"Marketing export manifest entry mismatch: {path}")
    social = MARKETING / "social-preview.png"
    if social.stat().st_size >= 1_000_000:
        raise ValueError("Social preview exceeds the 1 MB GitHub image limit.")
    logo = MARKETING / "crux-experts-official.jpg"
    if _image_dimensions(logo) != (480, 94, "JPEG"):
        raise ValueError("Official Crux Experts logo must remain its original 480 x 94 JPEG.")
    if marketing["officialLogo"]["sha256"] != expected[logo.relative_to(ROOT).as_posix()]:
        raise ValueError("Official logo manifest hash mismatch.")
    print(json.dumps({"status": "verified", "brandAssets": len(expected), "screenshots": len(screenshot_data["items"])}))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--marketing-only", action="store_true", help="render marketing compositions without regenerating historic exports")
    parser.add_argument("--check", action="store_true", help="verify brand hashes, screenshot provenance, dimensions, and embedded metadata")
    args = parser.parse_args()
    if args.check:
        verify_assets()
        return
    if args.marketing_only:
        renderer = export_marketing_assets()
        manifest = write_manifest(renderer=renderer)
    else:
        export_legacy_assets()
        manifest = write_manifest(update_legacy_renderer=True)
    print(json.dumps({"status": "exported", "assets": len(manifest["files"]), "sourceVersion": manifest["sourceVersion"]}))


if __name__ == "__main__": main()
