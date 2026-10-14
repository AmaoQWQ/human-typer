"""Render the local rounded T symbol for Chromium's PNG icons."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "assets"
root.mkdir(exist_ok=True)
scale = 4
canvas = Image.new("RGBA", (128 * scale, 128 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((0, 0, 128 * scale - 1, 128 * scale - 1), radius=28 * scale, fill="#0966D9")
draw.rounded_rectangle((14 * scale, 14 * scale, 114 * scale, 114 * scale), radius=28 * scale, outline="#FFFFFF", width=7 * scale)
def stroke(points):
    points = [(x * scale, y * scale) for x, y in points]
    draw.line(points, fill="#FFFFFF", width=8 * scale)
    for x, y in points:
        r = 4 * scale
        draw.ellipse((x - r, y - r, x + r, y + r), fill="#FFFFFF")
stroke([(37, 42), (91, 42)])
stroke([(64, 42), (64, 92)])
stroke([(46, 92), (82, 92)])
for size in (16, 32, 48, 128):
    canvas.resize((size, size), Image.Resampling.LANCZOS).save(root / f"icon-{size}.png")
