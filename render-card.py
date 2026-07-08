#!/usr/bin/env python3
import json
import sys
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


WIDTH = 1080
HEIGHT = 1350
BG = (128, 190, 133)
PANEL = (255, 255, 255)
HERO = (3, 29, 24)
HERO_2 = (9, 75, 64)
GREEN = (22, 163, 90)
CYAN = (64, 196, 255)
RED = (255, 89, 89)
TEXT = (242, 248, 243)
INK = (12, 18, 16)
MUTED = (166, 181, 170)
BODY_MUTED = (101, 113, 107)
LINE = (48, 64, 54)
BODY_LINE = (226, 232, 228)


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_wrapped(draw, text, xy, max_chars, fill, font_obj, line_gap=8, max_lines=None):
    x, y = xy
    lines = []
    for part in str(text).splitlines():
        lines.extend(textwrap.wrap(part, max_chars) or [""])
    if max_lines:
        lines = lines[:max_lines]
    for line in lines:
        draw.text((x, y), line, fill=fill, font=font_obj)
        y += font_obj.size + line_gap
    return y


def text_width(draw, text, font_obj):
    bbox = draw.textbbox((0, 0), str(text), font=font_obj)
    return bbox[2] - bbox[0]


def ellipsize(draw, text, font_obj, max_width):
    text = str(text)
    if text_width(draw, text, font_obj) <= max_width:
        return text
    while text and text_width(draw, text + "...", font_obj) > max_width:
        text = text[:-1]
    return text + "..."


def draw_signal_pill(draw, xy, label, value, color, font_label, font_value):
    x, y = xy
    draw.rounded_rectangle((x, y, x + 280, y + 86), radius=28, fill=(244, 248, 245), outline=BODY_LINE, width=2)
    draw.ellipse((x + 22, y + 22, x + 64, y + 64), fill=color)
    draw.text((x + 82, y + 14), str(value), fill=INK, font=font_value)
    draw.text((x + 82, y + 50), label, fill=BODY_MUTED, font=font_label)


def signal_card(payload, out):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)
    brand_font = font(26, True)
    title_font = font(54, True)
    h_font = font(34, True)
    body_font = font(30)
    body_bold = font(30, True)
    small_font = font(22)
    tiny_font = font(19)

    card = (28, 26, WIDTH - 28, HEIGHT - 26)
    draw.rounded_rectangle(card, radius=34, fill=PANEL, outline=(220, 229, 224), width=2)

    hero = (28, 26, WIDTH - 28, 390)
    draw.rounded_rectangle(hero, radius=34, fill=HERO)
    draw.rectangle((28, 330, WIDTH - 28, 390), fill=HERO)
    for i in range(0, 260, 18):
        shade = (
            min(HERO_2[0] + i // 7, 38),
            min(HERO_2[1] + i // 4, 130),
            min(HERO_2[2] + i // 5, 108),
        )
        draw.rounded_rectangle((64 + i, 88 + i // 10, WIDTH - 92 - i // 3, 322 - i // 9), radius=90, outline=shade, width=2)

    draw.text((72, 58), "YUBIT", fill=TEXT, font=brand_font)
    draw.text((WIDTH - 205, 58), payload.get("badge", "SIGNAL"), fill=(103, 232, 211), font=brand_font)

    chip = payload.get("heroChip", "Market Signal Ready")
    chip_w = min(text_width(draw, chip, h_font) + 128, WIDTH - 190)
    chip_x = (WIDTH - chip_w) // 2
    draw.rounded_rectangle((chip_x, 142, chip_x + chip_w, 240), radius=48, fill=(24, 92, 79), outline=(65, 134, 118), width=2)
    draw.ellipse((chip_x + 34, 166, chip_x + 82, 214), fill=(86, 194, 255))
    draw.line((chip_x + 48, 191, chip_x + 60, 203, chip_x + 76, 176), fill=INK, width=7, joint="curve")
    draw.text((chip_x + 104, 172), chip, fill=TEXT, font=h_font)

    draw.text((72, 432), payload.get("section", "Signal snapshot"), fill=INK, font=title_font)
    draw_wrapped(
        draw,
        payload.get("actionText", "Tap the button below to open the market and review the latest setup."),
        (72, 504),
        42,
        INK,
        body_font,
        line_gap=12,
        max_lines=2,
    )
    draw.text((72, 620), payload["time"], fill=BODY_MUTED, font=small_font)

    summary = payload.get("summary", {})
    draw_signal_pill(draw, (72, 672), "Bullish", summary.get("bullish", 0), GREEN, small_font, h_font)
    draw_signal_pill(draw, (400, 672), "Bearish", summary.get("bearish", 0), RED, small_font, h_font)
    draw_signal_pill(draw, (728, 672), "Fresh crosses", summary.get("crosses", 0), CYAN, small_font, h_font)

    rows = payload.get("rows", [])[:4]
    y = 812
    draw.text((72, y), "Top signals", fill=INK, font=h_font)
    y += 58
    for idx, row in enumerate(rows, 1):
        color = GREEN if "Bullish" in row["signal"] else RED if "Bearish" in row["signal"] else BODY_MUTED
        draw.rounded_rectangle((72, y, WIDTH - 72, y + 76), radius=18, fill=(249, 251, 250), outline=BODY_LINE, width=2)
        draw.rounded_rectangle((72, y, 88, y + 76), radius=8, fill=color)
        draw.text((108, y + 22), f"{idx:02d}", fill=BODY_MUTED, font=small_font)
        draw.text((170, y + 17), ellipsize(draw, row["symbol"], body_bold, 185), fill=INK, font=body_bold)
        draw.text((390, y + 17), ellipsize(draw, row["signal"], body_font, 210), fill=color, font=body_font)
        draw.text((630, y + 16), f"Last {row['last']}", fill=BODY_MUTED, font=small_font)
        draw.text((630, y + 45), f"1h {row['changePct']}%", fill=color, font=tiny_font)
        draw.text((805, y + 29), f"SMA {row['fast']} / {row['slow']}", fill=BODY_MUTED, font=tiny_font)
        y += 88

    footer_y = HEIGHT - 112
    draw.line((72, footer_y - 24, WIDTH - 72, footer_y - 24), fill=BODY_LINE, width=2)
    draw.text((72, footer_y), "Informational only. Not investment advice. Manage risk.", fill=BODY_MUTED, font=small_font)
    img.save(out, "PNG")


def news_card(payload, out):
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(img)
    title_font = font(42, True)
    h_font = font(25, True)
    body_font = font(22)
    small_font = font(18)

    draw.rounded_rectangle((36, 32, WIDTH - 36, HEIGHT - 32), radius=24, fill=PANEL, outline=LINE, width=2)
    draw.text((68, 62), payload["title"], fill=TEXT, font=title_font)
    draw.text((68, 118), payload["time"], fill=MUTED, font=small_font)

    y = 172
    for idx, article in enumerate(payload.get("articles", [])[:5], 1):
        draw.rounded_rectangle((68, y, WIDTH - 68, y + 88), radius=14, fill=(16, 24, 20), outline=LINE)
        draw.text((92, y + 18), f"{idx}", fill=GREEN, font=h_font)
        draw_wrapped(draw, article.get("title", "Untitled"), (138, y + 16), 78, TEXT, body_font, line_gap=4, max_lines=2)
        draw.text((138, y + 62), article.get("source", "source")[:70], fill=MUTED, font=small_font)
        y += 105

    draw.text((68, HEIGHT - 72), payload.get("note", "Use official sources where possible."), fill=MUTED, font=small_font)
    img.save(out, "PNG")


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: render-card.py <signal|news> <payload.json> <out.png>")
    kind, payload_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    payload = json.loads(Path(payload_path).read_text())
    if kind == "signal":
        signal_card(payload, out)
    elif kind == "news":
        news_card(payload, out)
    else:
        raise SystemExit(f"unknown card kind: {kind}")


if __name__ == "__main__":
    main()
