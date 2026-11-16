"""Render website/images/og-cover.png (1200x630) from the same layout as og-cover.svg.

Run from desktop/:  python scripts/gen-og-cover.py
Requires Pillow and the Windows Microsoft YaHei / Consolas fonts.
"""

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
S = 2  # supersample for crisp edges
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "website", "images", "og-cover.png")

FONT_DIR = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
YAHEI = os.path.join(FONT_DIR, "msyh.ttc")
YAHEI_BOLD = os.path.join(FONT_DIR, "msyhbd.ttc")
CONSOLAS = os.path.join(FONT_DIR, "consola.ttf")


def font(path, size, index=0):
    return ImageFont.truetype(path, size * S, index=index)


def canvas():
    img = Image.new("RGB", (W * S, H * S), "#07080d")
    draw = ImageDraw.Draw(img)
    stops = [(0.0, (7, 8, 13)), (0.55, (11, 13, 22)), (1.0, (13, 16, 32))]
    for y in range(H * S):
        t = y / (H * S - 1)
        color = stops[0][1]
        for i in range(len(stops) - 1):
            t0, c0 = stops[i]
            t1, c1 = stops[i + 1]
            if t0 <= t <= t1:
                k = (t - t0) / (t1 - t0)
                color = tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
        draw.line([(0, y), (W * S, y)], fill=color)

    glow = Image.radial_gradient("L").resize((1400 * S, 900 * S))
    glow = glow.point([255 - v for v in range(256)])
    for pos, size, color, alpha in (
        ((-260 * S, -420 * S), (1400 * S, 900 * S), (124, 108, 255), 90),
        ((760 * S, -380 * S), (1200 * S, 820 * S), (34, 211, 238), 45),
    ):
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        mask = glow.resize(size)
        solid = Image.new("RGBA", size, color + (0,))
        solid.putalpha(mask.point([v * alpha // 255 for v in range(256)]))
        layer.paste(solid, pos, solid)
        img = Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB")

    draw = ImageDraw.Draw(img, "RGBA")
    step = 64 * S
    for x in range(0, W * S, step):
        draw.line([(x, 0), (x, H * S)], fill=(255, 255, 255, 7))
    for y in range(0, H * S, step):
        draw.line([(0, y), (W * S, y)], fill=(255, 255, 255, 7))
    return img, draw


def draw_brand(draw):
    draw.rounded_rectangle(
        (80 * S, 84 * S, 138 * S, 142 * S),
        radius=14 * S,
        fill=(16, 18, 28),
        outline=(124, 108, 255, 128),
        width=2 * S,
    )
    draw.line([(96 * S, 103 * S), (122 * S, 103 * S)], fill="#a78bfa", width=5 * S)
    draw.line([(103 * S, 103 * S), (103 * S, 123 * S)], fill="#a78bfa", width=5 * S)
    draw.line([(115 * S, 103 * S), (115 * S, 123 * S)], fill="#a78bfa", width=5 * S)
    draw.line([(91 * S, 113 * S), (98 * S, 113 * S)], fill="#22d3ee", width=4 * S)
    draw.line([(120 * S, 113 * S), (127 * S, 113 * S)], fill="#22d3ee", width=4 * S)

    draw.text((156 * S, 122 * S), "Tiger ", font=font(YAHEI_BOLD, 30), fill="#e9ebf5", anchor="ls")
    w = draw.textlength("Tiger ", font=font(YAHEI_BOLD, 30))
    draw.text((156 * S + w, 122 * S), "Agent", font=font(YAHEI_BOLD, 30), fill="#a78bfa", anchor="ls")


def gradient_text(img, xy, text, size, start, end):
    f = font(YAHEI_BOLD, size)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=f, fill=255, anchor="ls")
    grad = Image.new("RGB", img.size, start)
    gd = ImageDraw.Draw(grad)
    for x in range(img.size[0]):
        t = x / (img.size[0] - 1)
        color = tuple(round(start[i] + (end[i] - start[i]) * t) for i in range(3))
        gd.line([(x, 0), (x, img.size[1])], fill=color)
    img.paste(grad, (0, 0), mask)


def pill(draw, x, y, w, text, color, alpha=36):
    draw.rounded_rectangle(
        (x * S, y * S, (x + w) * S, (y + 46) * S),
        radius=23 * S,
        fill=color + (alpha,),
        outline=color + (110,),
        width=1 * S,
    )
    draw.text(
        ((x + w / 2) * S, (y + 23) * S),
        text,
        font=font(YAHEI, 19),
        fill="#b3b9cc",
        anchor="mm",
    )


def terminal(draw):
    x, y, w, h = 700 * S, 150 * S, 430 * S, 250 * S
    draw.rounded_rectangle((x, y, x + w, y + h), radius=16 * S, fill=(13, 15, 24), outline=(255, 255, 255, 36), width=1 * S)
    for i, color in enumerate(((255, 95, 87), (254, 188, 46), (40, 200, 64))):
        cx = x + (26 + i * 22) * S
        draw.ellipse((cx - 6 * S, y + 18 * S, cx + 6 * S, y + 30 * S), fill=color)
    draw.text((x + 94 * S, y + 29 * S), "tigerAgent · server", font=font(CONSOLAS, 13), fill="#7f879e")
    draw.line([(x, y + 46 * S), (x + w, y + 46 * S)], fill=(255, 255, 255, 20), width=1 * S)

    mono_l = font(YAHEI, 14)
    lines = [
        ("$ ", "#7f879e", "tigerAgent --host tcp://…", "#e9ebf5"),
        ("", "", "tigerAgent://…?fp=sha256:…&token=…", "#34d399"),
        ("", "", "OK  TLS 1.3 · token ready", "#34d399"),
        ("", "", "you › 重构 src/auth 并补测试", "#22d3ee"),
        ("> ", "#a78bfa", "view   src/auth/*.go", "#a78bfa"),
        ("> ", "#a78bfa", "edit   +42 −18", "#a78bfa"),
        ("> ", "#a78bfa", "bash   go test ./internal/auth", "#a78bfa"),
    ]
    ty = y + 76 * S
    for prefix, pcolor, body, bcolor in lines:
        px = x + 26 * S
        if prefix:
            pf = font(CONSOLAS, 14) if prefix.strip().isascii() else mono_l
            draw.text((px, ty), prefix, font=pf, fill=pcolor, anchor="ls")
            px += draw.textlength(prefix, font=pf)
        bf = font(CONSOLAS, 14) if body.isascii() else mono_l
        draw.text((px, ty), body, font=bf, fill=bcolor, anchor="ls")
        ty += 24 * S


def main():
    img, draw = canvas()
    draw_brand(draw)

    draw.text((80 * S, 268 * S), "服务端跑 Agent", font=font(YAHEI_BOLD, 66), fill="#f2f3fa", anchor="ls")
    gradient_text(img, (80 * S, 352 * S), "界面留在桌面端", 66, (167, 139, 250), (34, 211, 238))
    draw.text(
        (80 * S, 420 * S),
        "独立构建 · 独立升级 · 一个服务端多设备接入 · 模型由你决定",
        font=font(YAHEI, 24),
        fill="#b3b9cc",
        anchor="ls",
    )

    pill(draw, 80, 470, 188, "27 个内置工具", (124, 108, 255))
    pill(draw, 288, 470, 220, "服务端 / 桌面端分离", (124, 108, 255))
    pill(draw, 528, 470, 140, "独立升级", (34, 211, 238), 26)
    pill(draw, 688, 470, 168, "多设备接入", (34, 211, 238), 26)

    terminal(draw)

    bottom = font(YAHEI, 19)
    draw.text((80 * S, 588 * S), "tiger.kuda520.com", font=bottom, fill="#7f879e", anchor="ls")
    draw.text((1120 * S, 588 * S), "Windows · macOS · Linux", font=bottom, fill="#7f879e", anchor="rs")

    img = img.resize((W, H), Image.Resampling.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, optimize=True)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
