"""Draws the app icon (an aperture in a dark rounded square) into Darkroom.iconset/."""
import math, sys
from pathlib import Path
from PIL import Image, ImageDraw
out = Path(sys.argv[1] if len(sys.argv) > 1 else "Darkroom.iconset"); out.mkdir(exist_ok=True)
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
d.rounded_rectangle([60, 60, S - 60, S - 60], radius=200, fill=(20, 20, 24, 255))
c, R = S / 2, 330
d.ellipse([c - R, c - R, c + R, c + R], fill=(226, 104, 60, 255))
for i in range(6):  # aperture blades
    a = math.radians(i * 60 + 15)
    pts = [(c + 120 * math.cos(a), c + 120 * math.sin(a)), (c + R * math.cos(a + 0.55), c + R * math.sin(a + 0.55)),
           (c + R * math.cos(a + 1.05), c + R * math.sin(a + 1.05))]
    d.polygon(pts, fill=(196, 84, 46, 255))
d.ellipse([c - 120, c - 120, c + 120, c + 120], fill=(20, 20, 24, 255))
for n in (16, 32, 128, 256, 512):
    img.resize((n, n), Image.LANCZOS).save(out / f"icon_{n}x{n}.png")
    img.resize((n * 2, n * 2), Image.LANCZOS).save(out / f"icon_{n}x{n}@2x.png")
