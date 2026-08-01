"""
Brother PT-P300BT ESC/P raster rendering (transport-agnostic, no serial here).

The exact same pipeline is reimplemented in docs/app.js for the WebSerial path;
keep the two in sync. Uncompressed raster (M 0) to avoid packbits bugs.
"""
from __future__ import annotations

RASTER_WIDTH = 128                       # dots across the print head
BYTES_PER_LINE = RASTER_WIDTH // 8       # 16
HEAT_SHRINK_TYPES = {0x11, 0x17}         # HS 2:1 / 3:1 -> printed on the outside, do NOT mirror
_KNOWN_PRINTABLE = {6: 32, 9: 50, 12: 70, 18: 112, 24: 128}   # dots on the tape-width axis


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
                       error_correction=qrcode.constants.ERROR_CORRECTION_M)
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image(fill_color="black", back_color="white").convert("1")


def to_raster(content_img, printable, flip=True):
    from PIL import Image
    if flip:
        content_img = content_img.transpose(Image.FLIP_LEFT_RIGHT)
    cw, ch = content_img.size
    if ch > printable:
        s = printable / ch
        content_img = content_img.resize((max(1, int(cw * s)), printable), Image.LANCZOS).convert("1")
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


def build_job(rows, tape_mm, media_type=0x01):
    n = len(rows)
    job = bytearray()
    job += bytes([0x1B, 0x40])                                   # ESC @  init/reset
    job += bytes([0x1B, 0x69, 0x61, 0x01])                       # ESC i a  raster mode
    job += bytes([0x1B, 0x69, 0x7A, 0xC4, media_type & 0xFF,     # ESC i z  print info:
                  tape_mm & 0xFF, 0x00,                          #   media type + width mm
                  n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF,
                  0x00, 0x00])
    job += bytes([0x1B, 0x69, 0x4B, 0x08])                       # ESC i K  advanced: no chain
    job += bytes([0x1B, 0x69, 0x4D, 0x00])                       # ESC i M  no mirror/autocut
    job += bytes([0x1B, 0x69, 0x64, 0x1C, 0x00])                 # ESC i d  feed margin = 28
    job += bytes([0x4D, 0x00])                                   # M 0  compression OFF
    for r in rows:
        job += bytes([0x47, BYTES_PER_LINE, 0x00]) + r           # G  raster transfer
    job += bytes([0x1A])                                         # SUB  print + feed
    return bytes(job)


def compose(text=None, qr=None, tape=12, media_type=0x01, flip="auto", font=None, height=0):
    printable = printable_dots(tape)
    do_flip = resolve_flip(flip, media_type)
    h = height or max(8, printable - 4)
    content = render_qr(qr) if qr else render_text(text, font, h)
    rows, canvas = to_raster(content, printable, do_flip)
    return {
        "rows": rows, "canvas": canvas, "job": build_job(rows, tape, media_type),
        "flip": do_flip, "tape": tape, "media_type": media_type, "lines": len(rows),
    }
