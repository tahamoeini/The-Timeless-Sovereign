"""Generate Lorethra's Tauri icon set using only the Python standard library."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
SUPERSAMPLE = 4
DESIGN_SIZE = 256
CANVAS_SIZE = DESIGN_SIZE * SUPERSAMPLE

TRANSPARENT = (0, 0, 0, 0)
INK = (21, 39, 33, 255)
PAPER = (239, 230, 209, 255)
GOLD = (212, 185, 126, 255)
SAGE = (166, 197, 172, 255)
INK_LINE = (91, 111, 95, 255)


def set_pixel(canvas: bytearray, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= x < CANVAS_SIZE and 0 <= y < CANVAS_SIZE:
        offset = (y * CANVAS_SIZE + x) * 4
        canvas[offset : offset + 4] = bytes(color)


def fill_round_rect(
    canvas: bytearray, x: int, y: int, width: int, height: int, radius: int,
    color: tuple[int, int, int, int],
) -> None:
    x0, y0, x1, y1, r = (value * SUPERSAMPLE for value in (x, y, x + width, y + height, radius))
    for py in range(y0, y1):
        cy = min(max(py + 0.5, y0 + r), y1 - r)
        reach = (r * r - (py + 0.5 - cy) ** 2) ** 0.5
        left, right = round(x0 + r - reach), round(x1 - r + reach)
        row = bytes(color) * max(0, right - left)
        start = (py * CANVAS_SIZE + left) * 4
        canvas[start : start + len(row)] = row


def fill_polygon(canvas: bytearray, points: list[tuple[int, int]], color: tuple[int, int, int, int]) -> None:
    scaled = [(x * SUPERSAMPLE, y * SUPERSAMPLE) for x, y in points]
    minimum_y = max(0, min(y for _, y in scaled))
    maximum_y = min(CANVAS_SIZE, max(y for _, y in scaled))
    for py in range(minimum_y, maximum_y):
        scan_y = py + 0.5
        crossings: list[float] = []
        for index, (x1, y1) in enumerate(scaled):
            x2, y2 = scaled[(index + 1) % len(scaled)]
            if (y1 <= scan_y < y2) or (y2 <= scan_y < y1):
                crossings.append(x1 + (scan_y - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        for left, right in zip(crossings[::2], crossings[1::2]):
            x0, x1 = max(0, round(left)), min(CANVAS_SIZE, round(right))
            row = bytes(color) * max(0, x1 - x0)
            start = (py * CANVAS_SIZE + x0) * 4
            canvas[start : start + len(row)] = row


def stroke_line(
    canvas: bytearray, start: tuple[int, int], end: tuple[int, int], width: int,
    color: tuple[int, int, int, int],
) -> None:
    x0, y0 = (value * SUPERSAMPLE for value in start)
    x1, y1 = (value * SUPERSAMPLE for value in end)
    radius = max(1, width * SUPERSAMPLE // 2)
    steps = max(abs(x1 - x0), abs(y1 - y0), 1)
    for step in range(steps + 1):
        cx = round(x0 + (x1 - x0) * step / steps)
        cy = round(y0 + (y1 - y0) * step / steps)
        for py in range(cy - radius, cy + radius + 1):
            for px in range(cx - radius, cx + radius + 1):
                if (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius:
                    set_pixel(canvas, px, py, color)


def render_icon(size: int) -> bytes:
    canvas = bytearray(bytes(TRANSPARENT) * (CANVAS_SIZE * CANVAS_SIZE))
    fill_round_rect(canvas, 16, 16, 224, 224, 58, INK)

    # Two open pages and a center fold form the book mark.
    fill_polygon(canvas, [(43, 94), (101, 101), (128, 119), (128, 197), (104, 181), (47, 173)], PAPER)
    fill_polygon(canvas, [(213, 94), (155, 101), (128, 119), (128, 197), (152, 181), (209, 173)], PAPER)
    stroke_line(canvas, (43, 94), (101, 101), 4, GOLD)
    stroke_line(canvas, (101, 101), (128, 119), 4, GOLD)
    stroke_line(canvas, (128, 119), (128, 197), 4, GOLD)
    stroke_line(canvas, (213, 94), (155, 101), 4, GOLD)
    stroke_line(canvas, (155, 101), (128, 119), 4, GOLD)
    stroke_line(canvas, (47, 173), (104, 181), 4, GOLD)
    stroke_line(canvas, (104, 181), (128, 197), 4, GOLD)
    stroke_line(canvas, (209, 173), (152, 181), 4, GOLD)
    stroke_line(canvas, (152, 181), (128, 197), 4, GOLD)

    # Quiet page lines keep the mark legible at small sizes.
    for y, right_edge in ((128, 108), (143, 112), (158, 116)):
        stroke_line(canvas, (58, y), (right_edge, y + 3), 2, INK_LINE)
        stroke_line(canvas, (198, y), (256 - right_edge, y + 3), 2, INK_LINE)

    # A small four-point spark suggests an unfolding story.
    fill_polygon(canvas, [(128, 45), (136, 58), (149, 66), (136, 74), (128, 87), (120, 74), (107, 66), (120, 58)], SAGE)

    # Box-filter the supersampled image for clean edges at installer sizes.
    factor = CANVAS_SIZE // size
    output = bytearray()
    for y in range(size):
        source_y = y * factor
        for x in range(size):
            source_x = x * factor
            sums = [0, 0, 0, 0]
            for dy in range(factor):
                for dx in range(factor):
                    offset = ((source_y + dy) * CANVAS_SIZE + source_x + dx) * 4
                    for channel in range(4):
                        sums[channel] += canvas[offset + channel]
            count = factor * factor
            output.extend(value // count for value in sums)
    return png_bytes(size, size, bytes(output))


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_bytes(width: int, height: int, rgba: bytes) -> bytes:
    stride = width * 4
    rows = b"".join(b"\0" + rgba[row * stride : (row + 1) * stride] for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(rows, 9)) + png_chunk(b"IEND", b"")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    icons = {
        "icon.png": 512,
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
    }
    generated = {name: render_icon(size) for name, size in icons.items()}
    for name, data in generated.items():
        (OUTPUT / name).write_bytes(data)
    png = generated["128x128@2x.png"]
    ico_header = struct.pack("<HHH", 0, 1, 1)
    ico_entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    (OUTPUT / "icon.ico").write_bytes(ico_header + ico_entry + png)
    print(f"Generated {len(generated) + 1} Lorethra app icons in {OUTPUT}")


if __name__ == "__main__":
    main()
