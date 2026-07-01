"""Generate Gold Journal PWA icons: gold 'AU' mark on dark rounded background."""
from PIL import Image, ImageDraw, ImageFont

BG = (16, 20, 26, 255)      # #10141a
GOLD = (212, 175, 55, 255)  # #d4af37
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"


def make(size, path, maskable=False):
    # Render at 4x for crisp downscale.
    scale = 4
    S = size * scale
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        # Full-bleed background so it survives the safe-zone crop.
        d.rounded_rectangle([0, 0, S, S], radius=int(S * 0.16), fill=BG)
        text_scale = 0.42  # keep text inside ~80% safe zone
    else:
        pad = int(S * 0.06)
        d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=int(S * 0.22), fill=BG)
        text_scale = 0.5
    # Subtle gold border ring.
    ring = int(S * 0.015)
    inset = int(S * 0.06) if not maskable else int(S * 0.10)
    d.rounded_rectangle(
        [inset, inset, S - inset, S - inset],
        radius=int(S * 0.16),
        outline=(212, 175, 55, 90),
        width=ring,
    )
    font = ImageFont.truetype(FONT_PATH, int(S * text_scale))
    text = "AU"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (S - tw) / 2 - bbox[0]
    y = (S - th) / 2 - bbox[1]
    d.text((x, y), text, font=font, fill=GOLD)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)
    print("wrote", path)


make(192, "icons/icon-192.png")
make(512, "icons/icon-512.png")
make(512, "icons/icon-maskable-512.png", maskable=True)
make(180, "icons/apple-touch-icon.png")
make(32, "icons/favicon-32.png")
