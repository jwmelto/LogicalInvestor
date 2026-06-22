"""
Render LogicalInvestor splash icon.
Output: assets/images/splash-icon.png

Design: Sean's photo duotone-treated in the app palette, name + tagline below.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "fonts")
PROJECT = os.path.dirname(HERE)

W, H = 480, 660

BG      = (43, 45, 50)
SHADOW  = (43, 45, 50)
HILIGHT = (160, 188, 216)
WHITE   = (255, 255, 255)


def duotone(img, shadow_color, highlight_color):
    gray = ImageOps.grayscale(img)
    result = Image.new("RGB", gray.size)
    gray_data = gray.load()
    result_data = result.load()
    for y in range(gray.height):
        for x in range(gray.width):
            t = gray_data[x, y] / 255
            r = int(shadow_color[0] + t * (highlight_color[0] - shadow_color[0]))
            g = int(shadow_color[1] + t * (highlight_color[1] - shadow_color[1]))
            b = int(shadow_color[2] + t * (highlight_color[2] - shadow_color[2]))
            result_data[x, y] = (r, g, b)
    return result


def vignette_mask(w, h):
    """Fade bottom edge strongly into background."""
    mask = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(mask)
    # Bottom fade: last 30% of height fades to 0
    fade_start = int(h * 0.65)
    for y in range(fade_start, h):
        t = (y - fade_start) / (h - fade_start)
        alpha = int(255 * (1 - t) ** 1.5)
        draw.line([(0, y), (w, y)], fill=alpha)
    return mask.filter(ImageFilter.GaussianBlur(radius=h // 30))


def draw_tracked_text(draw, text, cx, y, font, color, opacity, tracking):
    alpha = int(255 * opacity)
    fill = color + (alpha,)
    widths = [font.getbbox(ch)[2] - font.getbbox(ch)[0] for ch in text]
    total_w = sum(widths) + tracking * (len(text) - 1)
    x = cx - total_w / 2
    for i, ch in enumerate(text):
        bb = font.getbbox(ch)
        draw.text((x - bb[0], y - bb[1]), ch, font=font, fill=fill)
        x += widths[i] + tracking


def main():
    photo_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not photo_path or not os.path.exists(photo_path):
        print("Usage: python render_splash.py <path-to-photo.jpg>")
        sys.exit(1)

    scale = 3
    sw, sh = W * scale, H * scale

    # --- Load and crop photo ---
    photo = Image.open(photo_path).convert("RGB")
    pw, ph = photo.size

    # Square crop from top center, then we'll let it fill 78% of canvas height
    crop_size = min(pw, ph)
    left = (pw - crop_size) // 2
    photo_crop = photo.crop((left, 0, left + crop_size, crop_size))

    photo_h = int(sh * 0.78)
    photo_crop = photo_crop.resize((sw, photo_h), Image.LANCZOS)

    # Duotone
    duo = duotone(photo_crop, SHADOW, HILIGHT)

    # Bottom vignette fade
    vig = vignette_mask(sw, photo_h)
    duo_rgba = duo.convert("RGBA")
    duo_rgba.putalpha(vig)

    # --- Canvas ---
    canvas = Image.new("RGBA", (sw, sh), BG + (255,))
    canvas.alpha_composite(duo_rgba, (0, 0))
    draw = ImageDraw.Draw(canvas)

    # --- Text: SEAN HYMAN ---
    name_size = 48 * scale
    name_font = ImageFont.truetype(os.path.join(FONTS, "Inter-Light.ttf"), name_size)
    line_gap = int(name_size * 1.15)

    text_top = int(sh * 0.76)
    draw_tracked_text(draw, "SEAN",  sw // 2, text_top,            name_font, WHITE, 0.90, 18 * scale)
    draw_tracked_text(draw, "HYMAN", sw // 2, text_top + line_gap, name_font, WHITE, 0.90, 10 * scale)

    # --- Tagline: Logical Investor ---
    tag_size = 26 * scale
    tag_font = ImageFont.truetype(os.path.join(FONTS, "Inter-Light.ttf"), tag_size)
    tag_y = text_top + line_gap * 2 + int(18 * scale)
    draw_tracked_text(draw, "LOGICAL INVESTOR", sw // 2, tag_y, tag_font, HILIGHT, 0.70, 6 * scale)

    # --- Downsample ---
    final = canvas.resize((W, H), Image.LANCZOS)
    out = os.path.join(PROJECT, "assets", "images", "splash-icon.png")
    final.save(out, "PNG")
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
