#!/usr/bin/env python3
"""Mask private text in the README screenshots.

The captures come from a real GUI, so they carry real session titles, working
directories, tag names and a first message. All of it is private. Every run of
private text is replaced by a neutral placeholder drawn in the same place, at
the same size and colour, so the layout stays readable while the text stops
being readable.

Rows are located by their separator lines rather than by scanning for glyphs:
the list draws a 1px rule between rows, which gives exact row bands even when a
row's text is short or a badge sits beside it. Within a band the title line and
the workspace sub-line are found by their own colour (dark vs grey).
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]

TITLE = (31, 35, 40)
SUB = (107, 114, 128)
BG = (255, 255, 255)


def font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def paint(draw, box, text, size, color):
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return
    draw.rectangle(box, fill=BG)
    f = font(size)
    ty = y0 + max(0, ((y1 - y0) - size) / 2) - 1
    draw.text((x0, ty), text, font=f, fill=color)


def separators(img, x0, x1, y0, y1):
    """y positions of the 1px rules the list draws between rows."""
    out = []
    step = max(1, (x1 - x0) // 20)
    for y in range(y0, y1):
        vals = [img.getpixel((x, y)) for x in range(x0, x1, step)]
        grey = sum(1 for v in vals if 200 < sum(v) / 3 < 250)
        if grey > len(vals) * 0.8:
            out.append(y)
    return out


def text_lines(img, x0, x1, y0, y1):
    """(start, end, is_dark) for each run of text inside a band."""
    out = []
    start = None
    dark = False
    for y in range(y0, y1):
        row_dark = any(sum(img.getpixel((x, y))) < 420 for x in range(x0, x1))
        row_grey = any(sum(img.getpixel((x, y))) < 640 for x in range(x0, x1))
        if row_grey and start is None:
            start = y
            dark = row_dark
        elif not row_grey and start is not None:
            out.append((start, y, dark))
            start = None
        elif row_grey and row_dark:
            dark = True
    if start is not None:
        out.append((start, y1, dark))
    return out


def mask_list(img, x0, x1, y0, y1, label, title_size=13, sub_size=11):
    """Mask every row of a session list between y0 and y1."""
    draw = ImageDraw.Draw(img)
    seps = separators(img, x0, x1, y0, y1)
    bounds = [y0] + seps + [y1]
    count = 0
    for i in range(len(bounds) - 1):
        top, bottom = bounds[i], bounds[i + 1]
        if bottom - top < 12:
            continue
        lines = text_lines(img, x0, x1, top + 1, bottom)
        if not lines:
            continue
        count += 1
        # The first line is the title (with any badge/chip beside it); a second
        # line, if present, is the workspace path.
        first = lines[0]
        paint(draw, (x0, first[0] - 1, x1, first[1] + 3), '%s %d' % (label, count), title_size, TITLE)
        if len(lines) > 1:
            second = lines[1]
            paint(draw, (x0, second[0] - 1, x1, second[1] + 1), 'workspace-%d' % count, sub_size, SUB)
        # A row can carry a third line: the tag chips under the workspace path.
        for extra in lines[2:]:
            paint(draw, (x0, extra[0] - 1, x1, extra[1] + 1), 'tag-%d' % count, sub_size, SUB)
    return count


def mask_region(img, box, text, size, color):
    paint(ImageDraw.Draw(img), box, text, size, color)
