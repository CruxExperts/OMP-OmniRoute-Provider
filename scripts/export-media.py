#!/usr/bin/env python3
"""Export editable SVG and PNG brand assets from shared drawing instructions."""
from html import escape
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin


ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "assets/brand"
PRODUCT_NAME = "OhMyPie OmniRoute Plugin"
REPOSITORY_NAME = "OMP-OmniRoute-Provider"
PROVIDER_NAME = "OMP Provider"
COPYRIGHT = "Copyright © 2026 Crux Experts LLC"
WEBSITE = "https://www.cruxexperts.com/"
RIGHTS = "Private asset. Property of Crux Experts LLC. Use, reproduction, modification, distribution, or publication without prior written permission is prohibited."
DARK, LIGHT, ACCENT, MUTED = "#101c2d", "#f5f8fc", "#39b7aa", "#a5b5c7"
FONT = ImageFont.truetype("DejaVuSans.ttf", 24).path
BOLD = ImageFont.truetype("DejaVuSans-Bold.ttf", 24).path


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


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    for theme,background,foreground in [("dark",DARK,LIGHT),("light",LIGHT,DARK)]:
        icon = Drawing(f"icon-{theme}",256,256,None,f"Routed connection mark for {PRODUCT_NAME}, the {PROVIDER_NAME}.")
        icon.mark(16,16,224,foreground);icon.save()

        wordmark = Drawing(f"wordmark-{theme}",1000,240,background,f"{PRODUCT_NAME}, identified as the {PROVIDER_NAME}, with the routed connection symbol.")
        wordmark.mark(30,30,180,foreground)
        wordmark.text(248,32,"OhMyPie",54,foreground,True)
        wordmark.text(252,96,"OmniRoute Plugin",38,foreground,True)
        wordmark.text(254,159,"OMP PROVIDER",22,ACCENT,True)
        wordmark.save()

    for name,width,height in [("social",1280,640),("banner",1600,640),("square",1080,1080)]:
        art = Drawing(name,width,height,DARK,f"{PRODUCT_NAME}, the {PROVIDER_NAME}. Connect Oh My Pi to your OmniRoute gateway with guided setup, live models, and reviewed administration.")
        art.line([(64,64),(width-64,64)],ACCENT,3)
        art.mark(68,112,200,LIGHT)
        art.text(310,102,"OhMyPie",70,LIGHT,True)
        art.text(314,183,"OmniRoute Plugin",48,LIGHT,True)
        art.text(318,253,"OMP PROVIDER",28,ACCENT,True)
        top=400 if height==640 else 500
        art.text(80,top,"Your OmniRoute gateway, inside Oh My Pi.",36,LIGHT)
        art.text(82,top+62,"Guided setup  /  Live models  /  Reviewed changes",23,MUTED)
        art.text(82,height-70,"CRUX EXPERTS LLC",18,MUTED,True)
        art.save()

    files=[]
    for path in sorted(DEST.glob("*")):
        if path.suffix in {".svg",".png"}:
            files.append({"path":path.relative_to(ROOT).as_posix(),"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest={
        "schemaVersion":1,
        "productName":PRODUCT_NAME,
        "providerName":PROVIDER_NAME,
        "repositoryName":REPOSITORY_NAME,
        "sourceVersion":(ROOT/'VERSION').read_text().strip(),
        "copyright":COPYRIGHT,
        "source":WEBSITE,
        "rights":RIGHTS,
        "editableSource":"scripts/export-media.py",
        "font":{"name":"DejaVu Sans","regularSha256":hashlib.sha256(Path(FONT).read_bytes()).hexdigest(),"boldSha256":hashlib.sha256(Path(BOLD).read_bytes()).hexdigest(),"redistributed":False},
        "renderer":{"Pillow":Image.__version__},
        "files":files,
    }
    (DEST/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({"status":"exported","assets":len(files),"sourceVersion":manifest['sourceVersion']}))


if __name__ == "__main__": main()
