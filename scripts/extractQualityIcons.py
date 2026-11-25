"""Extract the user's screenshot icons without redrawing them. Requires Pillow.

Run from any directory: python scripts/extractQualityIcons.py
The two source screenshots remain unchanged and are not bundled with the app.
"""
from hashlib import sha256
import json
from math import hypot
from pathlib import Path
from statistics import median

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "src/assets/move-quality"
SOURCES = {
    "zugbewertungen.png": (828, 1792),
    "zugbewertungen_2.png": (1080, 2340),
}
# Pixel coordinates in the original files, before any preview scaling.
CROPS = {
    "brilliant": ("zugbewertungen_2.png", (686, 290, 754, 358)),
    "great": ("zugbewertungen.png", (517, 240, 565, 288)),
    "best": ("zugbewertungen.png", (517, 321, 565, 369)),
    "excellent": ("zugbewertungen.png", (517, 402, 565, 450)),
    "good": ("zugbewertungen.png", (517, 483, 565, 531)),
    "book": ("zugbewertungen.png", (517, 564, 565, 612)),
    "inaccuracy": ("zugbewertungen.png", (517, 645, 565, 693)),
    "mistake": ("zugbewertungen.png", (517, 726, 565, 774)),
    "miss": ("zugbewertungen.png", (517, 816, 565, 864)),
    "blunder": ("zugbewertungen.png", (517, 907, 565, 955)),
}


def cutout(source: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    """Unmatte only the circle edge; keep the original interior RGB pixels.

    Screenshot edge pixels are blended against dark gray. Recover their
    foreground color and alpha so they don't carry a dark fringe onto the board.
    """
    pad = 4
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    assert width == height
    patch = source.crop((left - pad, top - pad, right + pad, bottom + pad))
    radius = width / 2
    center = radius + pad
    fill_samples, background_samples = [], []
    for y in range(patch.height):
        for x in range(patch.width):
            distance = hypot(x + 0.5 - center, y + 0.5 - center)
            rgb = patch.getpixel((x, y))
            if radius * 0.80 < distance < radius * 0.87:
                fill_samples.append(rgb)
            elif distance > radius + 2:
                background_samples.append(rgb)
    fill = [median(pixel[c] for pixel in fill_samples) for c in range(3)]
    background = [median(pixel[c] for pixel in background_samples) for c in range(3)]
    direction = [fill[c] - background[c] for c in range(3)]
    norm = sum(value * value for value in direction)
    result = Image.new("RGBA", (width, height))
    for y in range(height):
        for x in range(width):
            distance = hypot(x + 0.5 - radius, y + 0.5 - radius)
            rgb = patch.getpixel((x + pad, y + pad))
            if distance < radius - 2.5:
                result.putpixel((x, y), (*rgb, 255))
                continue
            alpha = max(0, min(1, sum((rgb[c] - background[c]) * direction[c] for c in range(3)) / norm))
            if distance > radius + 1.5 or alpha < 0.03:
                continue
            foreground = [round(max(0, min(255, (rgb[c] - (1 - alpha) * background[c]) / alpha))) for c in range(3)]
            result.putpixel((x, y), (*foreground, round(alpha * 255)))
    # Premultiplied-alpha resampling avoids introducing dark/white fringes.
    return result.convert("RGBa").resize((128, 128), Image.Resampling.LANCZOS).convert("RGBA")


def main() -> None:
    images = {}
    manifest = {"method": "Original-pixel crops, edge unmatting, premultiplied-alpha Lanczos resize", "size": [128, 128], "sources": {}, "icons": {}}
    for filename, dimensions in SOURCES.items():
        path = ROOT / filename
        source = Image.open(path).convert("RGB")
        if source.size != dimensions:
            raise ValueError(f"Unexpected screenshot size for {filename}: {source.size}; expected {dimensions}")
        images[filename] = source
        manifest["sources"][filename] = {"sha256": sha256(path.read_bytes()).hexdigest(), "size": list(dimensions)}
    DEST.mkdir(parents=True, exist_ok=True)
    for quality, (filename, box) in CROPS.items():
        output = DEST / f"{quality}.png"
        cutout(images[filename], box).save(output, optimize=True)
        manifest["icons"][quality] = {"source": filename, "crop": list(box), "bytes": output.stat().st_size}
        print(f"{quality}: {output.stat().st_size} bytes")
    (DEST / "source.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
