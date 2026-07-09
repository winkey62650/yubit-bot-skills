#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


INK = (5, 7, 8)
PANEL = (13, 22, 24)
PANEL_2 = (18, 33, 37)
WHITE = (248, 252, 253)
MUTED = (150, 169, 172)
LINE = (36, 65, 70)
GREEN = (46, 217, 138)

PALETTES = {
    "cyan_gold": {
        "name": "Cyan Gold",
        "primary": "#00E5FF",
        "secondary": "#F39917",
        "accent": "#FF2A1F",
        "bg": "#040809",
        "panel": "#0D1618",
    },
    "emerald_platinum": {
        "name": "Emerald Platinum",
        "primary": "#18E3A2",
        "secondary": "#E7EEF0",
        "accent": "#F2C94C",
        "bg": "#05100D",
        "panel": "#0F1F1A",
    },
    "royal_violet": {
        "name": "Royal Violet",
        "primary": "#9D7CFF",
        "secondary": "#20D7E8",
        "accent": "#FF4D8D",
        "bg": "#070711",
        "panel": "#141426",
    },
    "graphite_lime": {
        "name": "Graphite Lime",
        "primary": "#B6FF45",
        "secondary": "#00D5FF",
        "accent": "#FF6B35",
        "bg": "#070A09",
        "panel": "#141817",
    },
    "sapphire_copper": {
        "name": "Sapphire Copper",
        "primary": "#2F80ED",
        "secondary": "#C47C3C",
        "accent": "#00E5B0",
        "bg": "#050A12",
        "panel": "#0D1726",
    },
}

DEFAULT_AGENT = {
    "brand": "YUBIT",
    "agent": "Ricky",
    "academy": "Ricky Trading Academy",
    "handle": "@ricky_yubit",
    "subscribers": "1,221",
    "photo": "",
    "palette": "cyan_gold",
    "promise": "Daily market context, verified onboarding, and a repeatable trading routine.",
    "audience": "new futures traders",
    "cta": "START WITH UID VERIFICATION",
    "bot_name": "YUBIT Verify Bot",
    "channel_name": "Ricky Academy",
    "premium_name": "Ricky Academy PREMIUM",
}


def rgb(hex_value):
    value = str(hex_value).strip().lstrip("#")
    if len(value) != 6:
        return (0, 229, 255)
    return tuple(int(value[index : index + 2], 16) for index in (0, 2, 4))


def shade(color, factor):
    return tuple(max(0, min(255, int(channel * factor))) for channel in color)


def font(size, weight="regular"):
    names = {
        "black": [
            "/System/Library/Fonts/Supplemental/Arial Black.ttf",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        ],
        "bold": [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf",
        ],
        "regular": [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        ],
    }
    for path in names.get(weight, names["regular"]):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def text_size(draw, text, font_obj):
    bbox = draw.textbbox((0, 0), str(text), font=font_obj)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def fit_font(draw, text, max_width, start_size, min_size=18, weight="black"):
    for size in range(start_size, min_size - 1, -2):
        candidate = font(size, weight)
        if text_size(draw, text, candidate)[0] <= max_width:
            return candidate
    return font(min_size, weight)


def wrap_by_width(draw, text, font_obj, max_width):
    words = str(text).split()
    lines = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if text_size(draw, trial, font_obj)[0] <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def draw_wrapped(draw, text, xy, max_width, font_obj, fill, line_gap=10, max_lines=None):
    x, y = xy
    lines = []
    for paragraph in str(text).splitlines():
        lines.extend(wrap_by_width(draw, paragraph, font_obj, max_width))
    if max_lines:
        lines = lines[:max_lines]
    for line in lines:
        draw.text((x, y), line, font=font_obj, fill=fill)
        y += font_obj.size + line_gap
    return y


def rounded(draw, box, radius, fill, outline=None, width=1):
    radius = int(min(radius, (box[2] - box[0]) / 2, (box[3] - box[1]) / 2))
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def chip(draw, xy, text, fill, ink=INK, px=22, py=12, radius=999, text_font=None):
    text_font = text_font or font(24, "black")
    x, y = xy
    tw, th = text_size(draw, text, text_font)
    box = (x, y, x + tw + px * 2, y + th + py * 2)
    rounded(draw, box, radius, fill)
    draw.text((x + px, y + py - 1), text, font=text_font, fill=ink)
    return box


def resolve_photo(agent):
    photo = str(agent.get("photo", "")).strip()
    if not photo:
        return None
    path = Path(photo)
    if not path.is_absolute():
        path = Path(agent.get("_config_dir", ".")).joinpath(path)
    return path if path.exists() else None


def cover_image(path, size):
    img = Image.open(path).convert("RGB")
    return ImageOps.fit(img, size, method=Image.Resampling.LANCZOS, centering=(0.5, 0.35))


def paste_rounded(base, image, box, radius):
    x1, y1, x2, y2 = [int(v) for v in box]
    image = ImageOps.fit(image, (x2 - x1, y2 - y1), method=Image.Resampling.LANCZOS)
    mask = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, image.size[0], image.size[1]), radius=radius, fill=255)
    base.paste(image, (x1, y1), mask)


def draw_agent_photo(base, draw, box, agent, primary, mode="circle"):
    path = resolve_photo(agent)
    x1, y1, x2, y2 = [int(v) for v in box]
    if path:
        img = cover_image(path, (x2 - x1, y2 - y1))
        if mode == "circle":
            mask = Image.new("L", img.size, 0)
            ImageDraw.Draw(mask).ellipse((0, 0, img.size[0] - 1, img.size[1] - 1), fill=255)
            base.paste(img, (x1, y1), mask)
            draw.ellipse((x1, y1, x2, y2), outline=primary, width=max(5, (x2 - x1) // 30))
        else:
            paste_rounded(base, img, box, 26)
            rounded(draw, box, 26, None, outline=primary, width=3)
        return

    if mode == "circle":
        rounded(draw, box, (x2 - x1) // 2, (231, 239, 240), outline=primary, width=max(5, (x2 - x1) // 28))
    else:
        rounded(draw, box, 26, (231, 239, 240), outline=primary, width=3)
    initial = str(agent.get("agent", "A"))[:1].upper()
    f = font(max(32, (x2 - x1) // 2), "black")
    tw, th = text_size(draw, initial, f)
    draw.text(((x1 + x2 - tw) / 2, (y1 + y2 - th) / 2 - (x2 - x1) * 0.04), initial, font=f, fill=INK)


def bg_pattern(draw, w, h, agent, primary, bg):
    draw.rectangle((0, 0, w, h), fill=bg)
    pattern = str(agent.get("agent") or agent.get("academy") or agent.get("brand") or "ACADEMY").upper()
    pattern_font = font(38, "black")
    pattern_fill = shade(primary, 0.12)
    for y in range(-80, h + 80, 56):
        for x in range(-180, w + 180, max(220, len(pattern) * 28)):
            draw.text((x + (y % 124), y), pattern, font=pattern_font, fill=pattern_fill)
    for i in range(0, w, 32):
        alpha = i / max(w, 1)
        color = (
            int(bg[0] + primary[0] * 0.08 * (1 - alpha)),
            int(bg[1] + primary[1] * 0.08 * (1 - alpha)),
            int(bg[2] + primary[2] * 0.08 * (1 - alpha)),
        )
        draw.line((i, 0, i - 360, h), fill=color, width=1)


def palette_for(agent):
    palette = dict(PALETTES.get(agent.get("palette", "cyan_gold"), PALETTES["cyan_gold"]))
    for key in ("primary", "secondary", "accent", "bg", "panel"):
        if agent.get(key):
            palette[key] = agent[key]
    return palette


def base_canvas(size, agent):
    palette = palette_for(agent)
    primary = rgb(palette["primary"])
    secondary = rgb(palette["secondary"])
    accent = rgb(palette["accent"])
    bg = rgb(palette["bg"])
    panel = rgb(palette["panel"])
    img = Image.new("RGB", size, bg)
    draw = ImageDraw.Draw(img)
    bg_pattern(draw, size[0], size[1], agent, primary, bg)
    return img, draw, primary, secondary, accent, bg, panel


def draw_logo(draw, xy, agent, primary, small=False):
    x, y = xy
    f = font(28 if small else 42, "black")
    mark = 42 if small else 58
    rounded(draw, (x, y, x + mark, y + mark), mark // 2, primary)
    draw.polygon(
        [
            (x + mark * 0.25, y + mark * 0.5),
            (x + mark * 0.72, y + mark * 0.28),
            (x + mark * 0.52, y + mark * 0.74),
        ],
        fill=INK,
    )
    draw.text((x + mark + 14, y + mark * 0.18), agent["brand"], font=f, fill=WHITE)


def save(img, out_dir, filename):
    out = out_dir / filename
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG")
    return out


def welcome_banner(agent, out_dir):
    w, h = 1280, 720
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    draw.ellipse((760, -150, 1380, 470), fill=shade(primary, 0.36))
    draw.ellipse((880, 235, 1320, 760), fill=shade(secondary, 0.34))
    rounded(draw, (60, 52, 1220, 668), 34, shade(panel, 0.78), outline=shade(primary, 0.36), width=2)
    draw_logo(draw, (100, 92), agent, primary)
    chip(draw, (100, 178), "PRIVATE TRADING ACADEMY", primary, text_font=font(22, "black"))
    draw_wrapped(draw, f"Welcome to {agent['academy']}", (100, 238), 620, font(58, "black"), WHITE, line_gap=7, max_lines=3)
    draw_wrapped(draw, agent["promise"], (104, 424), 600, font(27), (202, 222, 224), line_gap=11, max_lines=3)
    stats = [("Verified UID", "Access"), ("Daily", "Market Context"), ("Risk First", "No Hype")]
    for index, (top, bottom) in enumerate(stats):
        x = 100 + index * 190
        rounded(draw, (x, 535, x + 168, 604), 18, PANEL_2, outline=LINE, width=2)
        draw.text((x + 18, 548), top, font=font(18, "black"), fill=primary)
        draw.text((x + 18, 574), bottom, font=font(17), fill=MUTED)
    rounded(draw, (724, 136, 1160, 586), 30, shade(panel, 1.15), outline=primary, width=3)
    draw_agent_photo(img, draw, (833, 181, 1043, 391), agent, primary, mode="circle")
    draw.text((790, 430), agent["handle"], font=fit_font(draw, agent["handle"], 320, 34, weight="black"), fill=WHITE)
    draw.text((790, 478), f"{agent['subscribers']} members learning in public", font=font(19), fill=MUTED)
    chip(draw, (790, 526), agent.get("cta", DEFAULT_AGENT["cta"]), secondary, text_font=font(18, "black"), px=18, py=10)
    return save(img, out_dir, "01-welcome-banner-1280x720.png")


def channel_cover(agent, out_dir):
    w, h = 1280, 720
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (70, 70, 1210, 650), 36, shade(panel, 0.82), outline=shade(primary, 0.45), width=2)
    draw_logo(draw, (112, 108), agent, primary)
    chip(draw, (112, 202), "TELEGRAM CHANNEL", primary, text_font=font(22, "black"))
    draw.text((112, 278), agent["channel_name"], font=fit_font(draw, agent["channel_name"], 620, 64, 36, "black"), fill=WHITE)
    draw_wrapped(draw, "Lessons, market context, signal notes, and weekly recaps in one verified channel.", (116, 366), 590, font(28), (205, 225, 227), line_gap=12, max_lines=3)
    draw_agent_photo(img, draw, (780, 132, 1118, 560), agent, primary, mode="rounded")
    chip(draw, (112, 552), f"{agent['subscribers']} subscribers  ·  {agent['handle']}", secondary, text_font=font(21, "black"))
    return save(img, out_dir, "02-channel-cover-1280x720.png")


def verification_card(agent, out_dir):
    w, h = 1080, 1080
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (54, 54, 1026, 1026), 34, shade(panel, 0.82), outline=shade(primary, 0.45), width=2)
    draw_logo(draw, (96, 92), agent, primary, small=True)
    draw.text((96, 170), "Get Verified Before You Trade", font=font(58, "black"), fill=WHITE)
    draw_wrapped(draw, "A simple access path keeps the community cleaner, safer, and easier to trust.", (100, 246), 760, font(28), (194, 216, 218), max_lines=2)
    steps = [
        ("01", "Join Telegram", "Read the pinned rules and community disclaimer."),
        ("02", "Complete UID Check", f"Use {agent['bot_name']} before entering premium topics."),
        ("03", "Enter Academy", "Follow lessons, signals, contests, and live updates."),
    ]
    y = 380
    for number, title, desc in steps:
        rounded(draw, (112, y, 968, y + 145), 24, PANEL, outline=shade(primary, 0.65), width=2)
        rounded(draw, (144, y + 30, 224, y + 110), 24, primary)
        draw.text((162, y + 52), number, font=font(24, "black"), fill=INK)
        draw.text((256, y + 30), title, font=font(32, "black"), fill=WHITE)
        draw_wrapped(draw, desc, (258, y + 78), 610, font(24), MUTED, line_gap=8, max_lines=2)
        if y < 670:
            draw.line((540, y + 145, 540, y + 180), fill=primary, width=4)
            draw.polygon([(526, y + 174), (554, y + 174), (540, y + 194)], fill=primary)
        y += 190
    chip(draw, (264, 926), "No spam. No fake admins. No fund requests.", secondary, text_font=font(22, "black"))
    return save(img, out_dir, "03-uid-verification-1080x1080.png")


def onboarding_flow(agent, out_dir):
    w, h = 1080, 1350
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (54, 44, 1026, 1306), 34, shade(panel, 0.82), outline=shade(primary, 0.45), width=2)
    draw.text((110, 92), "Academy Access Flow", font=font(58, "black"), fill=WHITE)
    draw_wrapped(draw, "Use this pinned flow to make new members feel guided from the first minute.", (114, 165), 820, font(25), MUTED, max_lines=2)
    steps = [
        ("Traffic", "User comes from social, YouTube, partner, or invite link.", primary),
        ("Landing / Intro", "They see the academy promise and official account handles.", secondary),
        ("UID Verification", "The verify bot filters access and reduces low-quality noise.", primary),
        ("Onboarding", "Welcome message, rules, starter lessons, and first task.", accent),
        ("Private Channel", "Lessons, signal context, events, and retention routines.", GREEN),
    ]
    y = 265
    for index, (title, desc, color) in enumerate(steps, 1):
        rounded(draw, (130, y, 950, y + 150), 24, PANEL, outline=shade(color, 0.75), width=2)
        rounded(draw, (160, y + 36, 238, y + 114), 22, color)
        draw.text((184, y + 58), f"{index}", font=font(28, "black"), fill=INK if color != accent else WHITE)
        draw.text((270, y + 30), title, font=font(34, "black"), fill=WHITE)
        draw_wrapped(draw, desc, (272, y + 80), 600, font(23), MUTED, line_gap=7, max_lines=2)
        if index < len(steps):
            draw.line((540, y + 150, 540, y + 185), fill=primary, width=4)
            draw.polygon([(526, y + 178), (554, y + 178), (540, y + 198)], fill=primary)
        y += 190
    draw_agent_photo(img, draw, (110, 1164, 220, 1274), agent, primary, mode="circle")
    draw.text((250, 1185), agent["academy"], font=font(34, "black"), fill=WHITE)
    draw.text((252, 1230), "A professional funnel before a professional community.", font=font(22), fill=MUTED)
    return save(img, out_dir, "04-onboarding-flow-1080x1350.png")


def telegram_channel_set(agent, out_dir):
    w, h = 1280, 720
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    draw.text((72, 68), "Telegram Channel System", font=font(54, "black"), fill=WHITE)
    draw.text((76, 132), "Channel, verification bot, and premium access should look like one trusted product.", font=font(24), fill=MUTED)
    tiles = [
        ("CHANNEL", agent["channel_name"], "Pinned updates, lessons, signal notes.", primary),
        ("VERIFY BOT", agent["bot_name"], "UID check before premium access.", secondary),
        ("PREMIUM", agent["premium_name"], "Private learning and active trader topics.", accent),
    ]
    status_labels = ["PINNED UPDATES", "START VERIFY", "PREMIUM ACCESS"]
    for index, (label, name, desc, color) in enumerate(tiles):
        x = 72 + index * 404
        rounded(draw, (x, 220, x + 350, 630), 28, shade(panel, 1.05), outline=shade(color, 0.8), width=3)
        chip(draw, (x + 34, 252), f"TELEGRAM {label}", color, text_font=font(17, "black"), px=16, py=9)
        draw_agent_photo(img, draw, (x + 124, 326, x + 226, 428), agent, color, mode="circle")
        name_font = fit_font(draw, name, 270, 28, 18, "black")
        draw.text((x + 40, 462), name, font=name_font, fill=WHITE)
        draw_wrapped(draw, desc, (x + 42, 505), 250, font(20), MUTED, line_gap=7, max_lines=3)
        rounded(draw, (x + 40, 572, x + 310, 604), 16, (25, 45, 50), outline=shade(color, 0.55), width=1)
        label_font = fit_font(draw, status_labels[index], 220, 15, 11, "black")
        tw, th = text_size(draw, status_labels[index], label_font)
        draw.text((x + 175 - tw / 2, 580), status_labels[index], font=label_font, fill=color)
    return save(img, out_dir, "05-telegram-channel-system-1280x720.png")


def weekly_schedule(agent, out_dir):
    w, h = 1080, 1350
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (54, 44, 1026, 1306), 34, shade(panel, 0.82), outline=shade(primary, 0.45), width=2)
    draw.text((150, 88), "What a Week Inside Looks Like", font=font(52, "black"), fill=WHITE)
    draw.text((250, 150), "Signals, lessons, recaps, and market context in one place.", font=font(24), fill=MUTED)
    timeline_x = 150
    draw.line((timeline_x, 250, timeline_x, 1130), fill=primary, width=4)
    items = [
        ("Mon", "Market Insight", "Range view, key levels, and the one chart to watch before taking risk.", primary),
        ("Wed", "Signal Context", "Entry zone, invalidation, take-profit levels, and why the setup matters.", secondary),
        ("Fri", "Live Trading", "A live session with market analysis, execution notes, and a clean recap.", accent),
        ("Sat", "Trading Lesson", "A practical lesson that turns the week into a repeatable trading routine.", primary),
    ]
    y = 230
    for index, (day, title, desc, color) in enumerate(items, 1):
        draw.ellipse((timeline_x - 12, y + 42, timeline_x + 12, y + 66), fill=color)
        draw.text((210, y), f"{day} · Day {index}", font=font(28, "black"), fill=WHITE)
        chip(draw, (212, y + 48), title.upper(), color, text_font=font(14, "black"), px=16, py=8)
        rounded(draw, (430, y - 8, 930, y + 165), 22, PANEL, outline=shade(primary, 0.68), width=2)
        draw_wrapped(draw, desc, (462, y + 30), 400, font(24), (209, 228, 230), line_gap=9, max_lines=3)
        rounded(draw, (694, y + 92, 898, y + 137), 18, (23, 44, 48), outline=(34, 83, 90), width=1)
        draw.text((718, y + 105), agent["academy"], font=fit_font(draw, agent["academy"], 160, 15, 11, "bold"), fill=primary)
        y += 225
    draw_agent_photo(img, draw, (145, 1155, 255, 1265), agent, primary, mode="circle")
    draw.text((280, 1176), agent["academy"], font=font(34, "black"), fill=WHITE)
    draw.text((282, 1221), "A structured trading community, not a random signal feed.", font=font(22), fill=MUTED)
    return save(img, out_dir, "06-weekly-schedule-1080x1350.png")


def risk_rules(agent, out_dir):
    w, h = 1080, 1350
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (58, 54, 1022, 1296), 36, (247, 251, 252), outline=(215, 229, 231), width=2)
    draw.text((104, 105), "Trust Rules", font=font(70, "black"), fill=INK)
    draw.text((108, 184), "Before reading any setup, read this first.", font=font(30), fill=(83, 102, 106))
    rules = [
        ("Education first", "Market ideas are shared for learning and discussion, not as financial advice."),
        ("Risk before profit", "Every setup needs invalidation, position sizing, and a clear reason to stop."),
        ("No fund handling", "Admins will never ask for passwords, seed phrases, transfers, or managed accounts."),
        ("Verify identities", "Trust official bots, pinned links, and verified admin handles only."),
        ("Think in routines", "The goal is better decision-making, not blind entries or emotional chasing."),
    ]
    y = 292
    for index, (title, desc) in enumerate(rules, 1):
        rounded(draw, (110, y, 970, y + 150), 24, WHITE, outline=(222, 233, 235), width=2)
        color = primary if index != 3 else accent
        rounded(draw, (138, y + 34, 218, y + 114), 24, color)
        draw.text((163, y + 56), f"{index}", font=font(30, "black"), fill=INK if index != 3 else WHITE)
        draw.text((250, y + 30), title, font=font(34, "black"), fill=INK)
        draw_wrapped(draw, desc, (252, y + 79), 640, font(23), (84, 103, 107), line_gap=7, max_lines=2)
        y += 174
    rounded(draw, (108, 1192, 972, 1252), 24, INK)
    draw.text((143, 1208), f"{agent['brand']} reminder: information only. Manage your own risk.", font=font(24, "black"), fill=WHITE)
    return save(img, out_dir, "07-trust-rules-1080x1350.png")


def content_matrix(agent, out_dir):
    w, h = 1280, 720
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (48, 42, 1232, 678), 32, shade(panel, 0.82), outline=shade(primary, 0.45), width=2)
    draw.text((90, 86), "Inside the Academy", font=font(60, "black"), fill=WHITE)
    draw.text((94, 158), "A cleaner Telegram structure for learning, signals, events, and retention.", font=font(26), fill=MUTED)
    cards = [
        ("Education", "Beginner lessons, chart reading, risk habits.", primary),
        ("Signals", "Regular setups with context and invalidation.", secondary),
        ("Live Events", "Market sessions, recaps, and walkthroughs.", accent),
        ("Community", "Questions, contests, and weekly accountability.", GREEN),
    ]
    for index, (title, desc, color) in enumerate(cards):
        x = 88 + index * 296
        rounded(draw, (x, 260, x + 252, 560), 28, PANEL, outline=shade(primary, 0.62), width=2)
        rounded(draw, (x + 26, 292, x + 88, 354), 18, color)
        draw.text((x + 47, 310), str(index + 1), font=font(24, "black"), fill=INK if color != accent else WHITE)
        draw.text((x + 26, 396), title, font=fit_font(draw, title, 198, 34, 24, "black"), fill=WHITE)
        draw_wrapped(draw, desc, (x + 28, 448), 190, font(21), MUTED, line_gap=6, max_lines=4)
    chip(draw, (90, 602), f"{agent['academy']}  ·  {agent['handle']}", primary, text_font=font(22, "black"))
    return save(img, out_dir, "08-content-matrix-1280x720.png")


def funnel_map(agent, out_dir):
    w, h = 1280, 720
    img, draw, primary, secondary, accent, bg, panel = base_canvas((w, h), agent)
    rounded(draw, (48, 42, 1232, 678), 32, (4, 8, 9), outline=shade(primary, 0.45), width=2)
    draw.text((430, 74), "Telegram Funnel", font=font(46, "black"), fill=WHITE)
    stages = [
        ("Traffic", "Social / YouTube / Partners"),
        ("Landing", "Promise + proof"),
        ("Verify", "UID access check"),
        ("Onboard", "Rules + starter task"),
        ("Academy", "Lessons + signals"),
        ("Retain", "Events + community"),
    ]
    xs = [92, 282, 472, 662, 852, 1042]
    y = 192
    for index, ((title, desc), x) in enumerate(zip(stages, xs)):
        color = [primary, secondary, primary, accent, primary, GREEN][index]
        rounded(draw, (x, y, x + 146, y + 126), 18, PANEL, outline=shade(color, 0.75), width=2)
        rounded(draw, (x + 20, y + 18, x + 64, y + 62), 14, color)
        draw.text((x + 36, y + 30), str(index + 1), font=font(16, "black"), fill=INK if color != accent else WHITE)
        draw.text((x + 20, y + 74), title, font=font(19, "black"), fill=WHITE)
        draw_wrapped(draw, desc, (x + 20, y + 99), 106, font(11), MUTED, line_gap=3, max_lines=2)
        if index < len(xs) - 1:
            draw.line((x + 146, y + 63, xs[index + 1] - 12, y + 63), fill=primary, width=3)
            draw.polygon([(xs[index + 1] - 16, y + 53), (xs[index + 1] - 16, y + 73), (xs[index + 1], y + 63)], fill=primary)
    lanes = [
        ("Education Content", "Beginner lessons, chart reading, risk habits.", primary),
        ("Trading Signals", "Signal context, invalidation, and recap.", secondary),
        ("Community Engine", "Questions, contests, and retention.", GREEN),
    ]
    for index, (title, desc, color) in enumerate(lanes):
        x = 156 + index * 340
        rounded(draw, (x, 410, x + 286, 540), 22, shade(color, 0.88), outline=color, width=2)
        draw.text((x + 24, 438), title, font=font(24, "black"), fill=INK if color != accent else WHITE)
        draw_wrapped(draw, desc, (x + 24, 478), 230, font(18), INK if color != accent else WHITE, line_gap=5, max_lines=2)
    rounded(draw, (360, 586, 920, 632), 23, PANEL, outline=primary, width=2)
    retention = f"Active Trader / Retention · {agent['academy']}"
    retention_font = fit_font(draw, retention, 500, 19, 14, "black")
    tw, th = text_size(draw, retention, retention_font)
    draw.text((640 - tw / 2, 598), retention, font=retention_font, fill=WHITE)
    return save(img, out_dir, "09-telegram-funnel-1280x720.png")


def load_agent(config_path, palette):
    agent = dict(DEFAULT_AGENT)
    if config_path:
        path = Path(config_path)
        data = json.loads(path.read_text())
        agent.update(data)
        agent["_config_dir"] = str(path.parent)
    else:
        agent["_config_dir"] = "."
    if palette:
        agent["palette"] = palette
    chosen = palette_for(agent)
    agent.update({key: chosen[key] for key in ("primary", "secondary", "accent", "bg", "panel")})
    return agent


def main():
    parser = argparse.ArgumentParser(description="Render Telegram academy decoration assets.")
    parser.add_argument("--agent-config", help="JSON file with brand, agent, academy, photo, palette, and copy.")
    parser.add_argument("--palette", choices=sorted(PALETTES.keys()), help="Override the palette from config.")
    parser.add_argument("--out-dir", default="generated/academy-assets", help="Output directory.")
    parser.add_argument("--list-palettes", action="store_true", help="Print the five premium palettes and exit.")
    args = parser.parse_args()

    if args.list_palettes:
        print(json.dumps(PALETTES, indent=2))
        return

    agent = load_agent(args.agent_config, args.palette)
    out_dir = Path(args.out_dir)
    outputs = [
        welcome_banner(agent, out_dir),
        channel_cover(agent, out_dir),
        verification_card(agent, out_dir),
        onboarding_flow(agent, out_dir),
        telegram_channel_set(agent, out_dir),
        weekly_schedule(agent, out_dir),
        risk_rules(agent, out_dir),
        content_matrix(agent, out_dir),
        funnel_map(agent, out_dir),
    ]
    print(json.dumps({"ok": True, "palette": agent["palette"], "outputs": [str(path) for path in outputs]}, indent=2))


if __name__ == "__main__":
    main()
