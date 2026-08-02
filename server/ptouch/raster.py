"""
Brother PT-P300BT ESC/P raster rendering (transport-agnostic, no serial here).

The exact same pipeline is reimplemented in docs/app.js for the WebSerial path;
keep the two in sync. Uncompressed raster (M 0) to avoid packbits bugs.
"""
from __future__ import annotations

RASTER_WIDTH = 128                       # dots across the print head
BYTES_PER_LINE = RASTER_WIDTH // 8       # 16
HEAT_SHRINK_TYPES = {0x11, 0x17}         # HS 2:1 / 3:1 -> printed on the outside, do NOT mirror
_KNOWN_PRINTABLE = {6: 32, 9: 50, 12: 64, 18: 64, 24: 64}     # P300BT caps print height at ~9mm (64 dots) on any tape >= 9mm
CUT_GAP_DOTS = 12                        # blank margin either side of a cut line (~1.7mm)
CUT_LINE_DOTS = 3                        # cut-line thickness along the tape (~0.4mm)


def printable_dots(width_mm: int) -> int:
    if width_mm in _KNOWN_PRINTABLE:
        return _KNOWN_PRINTABLE[width_mm]
    return max(8, min(RASTER_WIDTH, round(width_mm * 180 / 25.4 * 0.80)))


def resolve_flip(flip, media_type: int) -> bool:
    """laminated tape must be mirrored to read right; heat-shrink must not."""
    if flip in (True, "on"):
        return True
    if flip in (False, "off"):
        return False
    return media_type not in HEAT_SHRINK_TYPES          # auto: by media type


def render_text(text, font_path=None, height=48):
    from PIL import Image, ImageDraw, ImageFont
    font = None
    if font_path:
        font = ImageFont.truetype(font_path, height)
    else:
        for cand in ("arialbd.ttf", "arial.ttf", "segoeui.ttf", "DejaVuSans-Bold.ttf"):
            try:
                font = ImageFont.truetype(cand, height)
                break
            except OSError:
                continue
        if font is None:
            font = ImageFont.load_default()
    bbox = ImageDraw.Draw(Image.new("1", (10, 10), 1)).textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    img = Image.new("1", (w + 8, h + 4), 1)
    ImageDraw.Draw(img).text((4 - bbox[0], 2 - bbox[1]), text, font=font, fill=0)
    return img


def render_qr(data, box=2, border=1):
    import qrcode
    qr = qrcode.QRCode(border=border, box_size=box,
                       error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white").convert("1")


def to_raster(content_img, printable, flip=True):
    from PIL import Image
    if flip:
        content_img = content_img.transpose(Image.FLIP_LEFT_RIGHT)
    cw, ch = content_img.size
    if ch > printable:                               # downscale only — upscaling overflows the P300BT head -> blank
        content_img = content_img.resize((max(1, round(cw * printable / ch)), printable), Image.LANCZOS)
    content_img = content_img.convert("1")
    rot = content_img.rotate(-90, expand=True)
    rw, rh = rot.size
    canvas = Image.new("1", (RASTER_WIDTH, rh), 1)
    canvas.paste(rot, ((RASTER_WIDTH - rw) // 2, 0))
    px = canvas.load()
    rows = []
    for y in range(rh):
        line = bytearray(BYTES_PER_LINE)
        for x in range(RASTER_WIDTH):
            if px[x, y] == 0:
                line[x >> 3] |= (0x80 >> (x & 7))
        rows.append(bytes(line))
    return rows, canvas


def build_job(rows, tape_mm, media_type=0x01, save_tape=False):
    n = len(rows)
    job = bytearray()
    job += bytes([0x1B, 0x40])                                   # ESC @  init/reset
    job += bytes([0x1B, 0x69, 0x61, 0x01])                       # ESC i a  raster mode
    job += bytes([0x1B, 0x69, 0x7A, 0xC4, media_type & 0xFF,     # ESC i z  print info:
                  tape_mm & 0xFF, 0x00,                          #   media type + width mm
                  n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF,
                  0x00, 0x00])
    job += bytes([0x1B, 0x69, 0x4B, 0x08])                       # ESC i K  no chain — P300BT requires a full eject
    job += bytes([0x1B, 0x69, 0x4D, 0x00])                       # ESC i M  no mirror/autocut
    job += bytes([0x1B, 0x69, 0x64, 0x1C, 0x00])                 # ESC i d  feed margin = 28
    job += bytes([0x4D, 0x00])                                   # M 0  compression OFF
    for r in rows:
        job += bytes([0x47, BYTES_PER_LINE, 0x00]) + r           # G  raster transfer
    job += bytes([0x1A])                                         # SUB  print + eject (0C/no-feed reds the P300BT)
    return bytes(job)


def _blank_rows(n):
    return [bytes(BYTES_PER_LINE) for _ in range(n)]


def _solid_rows(n, printable):
    x0 = (RASTER_WIDTH - printable) // 2
    line = bytearray(BYTES_PER_LINE)
    for x in range(x0, x0 + printable):
        line[x >> 3] |= (0x80 >> (x & 7))
    return [bytes(line) for _ in range(n)]


def assemble_cut(rows, printable):
    """Prepend/append a cut-line + margin at each end (line spans the printable width)."""
    g, ln = CUT_GAP_DOTS, CUT_LINE_DOTS
    return (_blank_rows(g) + _solid_rows(ln, printable) + _blank_rows(g)
            + list(rows)
            + _blank_rows(g) + _solid_rows(ln, printable) + _blank_rows(g))


def rows_to_image(rows):
    from PIL import Image
    img = Image.new("1", (RASTER_WIDTH, max(1, len(rows))), 1)
    px = img.load()
    for y, row in enumerate(rows):
        for x in range(RASTER_WIDTH):
            if row[x >> 3] & (0x80 >> (x & 7)):
                px[x, y] = 0
    return img


def compose(text=None, qr=None, tape=12, media_type=0x01, flip="auto", font=None, height=0,
            save_tape=False, cut=False):
    printable = printable_dots(tape)
    do_flip = resolve_flip(flip, media_type)
    h = height or max(8, printable - 4)
    content = render_qr(qr) if qr else render_text(text, font, h)
    rows, _ = to_raster(content, printable, do_flip)
    if cut:
        rows = assemble_cut(rows, printable)
    canvas = rows_to_image(rows)
    return {
        "rows": rows, "canvas": canvas, "job": build_job(rows, tape, media_type, save_tape),
        "flip": do_flip, "tape": tape, "media_type": media_type, "lines": len(rows),
    }


def compose_rows(text=None, qr=None, tape=12, media_type=0x01, flip="auto", font=None, height=0, cut=False):
    """Raster rows for a single label (no job wrapper) — used by batch printing."""
    printable = printable_dots(tape)
    do_flip = resolve_flip(flip, media_type)
    h = height or max(8, printable - 4)
    content = render_qr(qr) if qr else render_text(text, font, h)
    rows, _ = to_raster(content, printable, do_flip)
    if cut:
        rows = assemble_cut(rows, printable)
    return rows


def build_batch_job(pages, tape_mm, media_type=0x01):
    """Chain several label rasters in ONE job: FF (print + minimal feed) between pages,
    SUB (print + full eject) after the last so the whole strip feeds out to be cut off.

    NOTE: the PT-P300BT (Cube) rejects chained/FF jobs (red-blinks) — this is for full PT
    models that support chain printing. print_batch() uses sequential jobs on the Cube."""
    job = bytearray()
    job += bytes([0x1B, 0x40])                                   # ESC @  init once
    job += bytes([0x1B, 0x69, 0x61, 0x01])                       # ESC i a  raster mode
    job += bytes([0x1B, 0x69, 0x4B, 0x00])                       # ESC i K  chain across the batch
    job += bytes([0x1B, 0x69, 0x4D, 0x00])                       # ESC i M
    job += bytes([0x1B, 0x69, 0x64, 0x1C, 0x00])                 # ESC i d
    for i, rows in enumerate(pages):
        n = len(rows)
        job += bytes([0x1B, 0x69, 0x7A, 0xC4, media_type & 0xFF, tape_mm & 0xFF, 0x00,
                      n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF, 0x00, 0x00])
        job += bytes([0x4D, 0x00])                               # compression off
        for r in rows:
            job += bytes([0x47, BYTES_PER_LINE, 0x00]) + r
        job += bytes([0x1A if i == len(pages) - 1 else 0x0C])    # eject after last; FF between
    return bytes(job)
