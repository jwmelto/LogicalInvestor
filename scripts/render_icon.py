"""
Render LogicalInvestor app icon: 1024x1024 PNG
Output: assets/images/icon.png (replaces existing)

Fonts required (downloaded separately by fetch_fonts.sh):
  scripts/fonts/PlayfairDisplay-VF.ttf
  scripts/fonts/Inter-Light.ttf

Design:
  Background: #2b2d32, corner radius 230
  Border: 22px inset, #a0bcd8 @ 28% opacity
  "SEAN" / "HYMAN": Inter Light 80pt, tracked, top of icon
  Wave: #9fc4e0 @ 65% opacity, points 80,820→245,490→420,620→645,360→800,520→940,300
  "LI": Playfair Display Bold 480pt, vertically centered
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "fonts")
PROJECT = os.path.dirname(HERE)

SIZE = 1024
RADIUS = 230

BG           = (43, 45, 50)
BORDER_COLOR = (160, 188, 216)
WAVE_COLOR   = (159, 196, 224)
WHITE        = (255, 255, 255)


def round_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_thick_polyline(draw, points, stroke_width, color):
    r = stroke_width / 2
    for i in range(len(points) - 1):
        draw.line([points[i], points[i + 1]], fill=color, width=stroke_width)
    # Fill circle at every vertex (including interior) to close open joins
    for x, y in points:
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_tracked_text(draw, text, cx, y, font, color, opacity, tracking, scale):
    alpha = int(255 * opacity)
    fill = color + (alpha,)
    widths = [font.getbbox(ch)[2] - font.getbbox(ch)[0] for ch in text]
    total_w = sum(widths) + tracking * scale * (len(text) - 1)
    x = cx * scale - total_w / 2
    for i, ch in enumerate(text):
        bb = font.getbbox(ch)
        draw.text((x - bb[0], y * scale - bb[1]), ch, font=font, fill=fill)
        x += widths[i] + tracking * scale


def main():
    scale = 4
    S = SIZE * scale

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background
    draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS * scale, fill=BG + (255,))

    # Inset border
    bl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bl)
    inset = 22 * scale
    bd.rounded_rectangle(
        [inset, inset, S - 1 - inset, S - 1 - inset],
        radius=210 * scale,
        outline=BORDER_COLOR + (int(255 * 0.28),),
        width=22 * scale,
    )
    img = Image.alpha_composite(img, bl)
    draw = ImageDraw.Draw(img)

    # SEAN / HYMAN — Inter Light 80pt, near top
    name_font = ImageFont.truetype(os.path.join(FONTS, "Inter-Light.ttf"), 80 * scale)
    draw_tracked_text(draw, "SEAN",  512, 72,  name_font, WHITE, 0.55, 18, scale)
    draw_tracked_text(draw, "HYMAN", 512, 160, name_font, WHITE, 0.55, 10, scale)

    # Wave
    wave_pts = [(x * scale, y * scale) for x, y in
                [(80,820),(180,490),(440,620),(580,360),(820,520),(940,300)]]
    wl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw_thick_polyline(ImageDraw.Draw(wl), wave_pts,
                        stroke_width=32 * scale,
                        color=WAVE_COLOR + (int(255 * 0.16),))
    img = Image.alpha_composite(img, wl)
    draw = ImageDraw.Draw(img)

    # LI — Playfair Display Bold, visually centered
    li_font = ImageFont.truetype(os.path.join(FONTS, "PlayfairDisplay-VF.ttf"), 560 * scale)
    try:
        li_font.set_variation_by_name("Bold")
    except Exception:
        try:
            li_font.set_variation_by_axes([700])
        except Exception:
            pass

    bb = li_font.getbbox("LI")
    glyph_h = bb[3] - bb[1]
    glyph_w = bb[2] - bb[0]
    tracking = 90 * scale

    # Visual center of LI glyph at y=560 (slightly below canvas center, above wave bottom)
    top_y = int(560 * scale - glyph_h / 2)
    left_x = int(S / 2 - (glyph_w + tracking) / 2)

    for i, ch in enumerate("LI"):
        cbb = li_font.getbbox(ch)
        x_off = left_x + i * (li_font.getbbox("L")[2] - li_font.getbbox("L")[0] + tracking)
        draw.text((x_off - cbb[0], top_y - cbb[1]), ch, font=li_font, fill=WHITE + (255,))

    # Clip to rounded corners
    img.putalpha(round_rect_mask(S, RADIUS * scale))

    # Downsample 4x → 1x
    final = img.resize((SIZE, SIZE), Image.LANCZOS)

    out = os.path.join(PROJECT, "assets", "images", "icon.png")
    final.save(out, "PNG")
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
