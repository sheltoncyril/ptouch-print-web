"""
Brother PT-P300BT ESC/P raster rendering (transport-agnostic, no serial here).

The exact same pipeline is reimplemented in docs/app.js for the WebSerial path;
keep the two in sync. Raster is sent UNCOMPRESSED (M 0x00): the P300BT Cube stalls
on TIFF/PackBits (M 0x02) — it can't decode it (confirmed 2026-08-02: an 842 B
compressed plain label stalls, the same 1593 B uncompressed one prints). The
_packbits encoder is kept for full PT models that do support mode 2.
"""
from __future__ import annotations

RASTER_WIDTH = 128                       # dots across the print head
BYTES_PER_LINE = RASTER_WIDTH // 8       # 16
HEAT_SHRINK_TYPES = {0x11, 0x17}         # HS 2:1 / 3:1 tube -> read from the outside, do NOT mirror
_KNOWN_PRINTABLE = {6: 32, 9: 50, 12: 64, 18: 64, 24: 64}     # P300BT caps print height at ~9mm (64 dots) on any tape >= 9mm
CUT_GAP_DOTS = 12                        # blank margin either side of a cut line (~1.7mm)
CUT_LINE_DOTS = 1                        # cut-line thickness along the tape (~0.14mm) — thin guide
CUT_DASH = 2                             # dotted line: dot pitch across the width (2 = every other dot)


def printable_dots(width_mm: int) -> int:
    if width_mm in _KNOWN_PRINTABLE:
        return _KNOWN_PRINTABLE[width_mm]
    return max(8, min(RASTER_WIDTH, round(width_mm * 180 / 25.4 * 0.80)))


def resolve_flip(flip, media_type: int) -> bool:
    """This printer needs the image mirrored to read right on every tape EXCEPT heat-shrink
    tube (read from the outside after shrinking). Verified on hardware: laminated (0x01) AND
    non-laminated (0x03) both need the mirror; only 0x11/0x17 skip it."""
    if flip in (True, "on"):
        return True
    if flip in (False, "off"):
        return False
    return media_type not in HEAT_SHRINK_TYPES          # auto: mirror unless heat-shrink tube


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


def _packbits(data: bytes) -> bytes:
    """TIFF/PackBits RLE (Brother compression mode 2). Replicate runs >=2, else literals.
    control byte: 0..127 = copy next (c+1) literal bytes; 257-L = repeat next byte L times."""
    out = bytearray()
    n = len(data)
    i = 0
    while i < n:
        j = i
        while j < n - 1 and data[j] == data[j + 1]:              # extend a run of equal bytes
            j += 1
        if j > i:                                                # replicate run data[i..j]
            runlen = j - i + 1
            while runlen > 0:
                chunk = min(runlen, 128)
                out.append((257 - chunk) & 0xFF)                 # -(chunk-1) as signed int8
                out.append(data[i])
                runlen -= chunk
            i = j + 1
        else:                                                    # literal run up to the next >=2 run
            k = i
            while k < n - 1 and data[k] != data[k + 1]:
                k += 1
            if k == n - 1:
                k = n
            while k > i:
                chunk = min(k - i, 128)
                out.append(chunk - 1)
                out += data[i:i + chunk]
                i += chunk
    return bytes(out)


def _raster_cmd(row, compress):
    """G raster-transfer command for one line. 47 n1 n2 <data> (n = data byte count, LE16)."""
    if compress:
        packed = _packbits(row)
        return bytes([0x47, len(packed) & 0xFF, (len(packed) >> 8) & 0xFF]) + packed
    return bytes([0x47, BYTES_PER_LINE, 0x00]) + row


def _render_sized(text, qr, font, height, printable, scale):
    """Render content AT its final dot height so it stays crisp (no downscale + 1-bit mush):
    text at a scaled font size, QR block-resized with nearest-neighbour."""
    base_h = height or max(8, printable - 4)
    render_h = max(8, min(printable, round(base_h * max(0.05, scale))))
    if qr:
        img = render_qr(qr)
        if scale < 1.0:
            from PIL import Image
            th = max(8, round(printable * scale))
            cw, ch = img.size
            img = img.resize((max(1, round(cw * th / ch)), th), Image.NEAREST)
        return img
    return render_text(text, font, render_h)


def place_in_band(img, printable, align="center"):
    """Position content across the tape width (NO scaling — content is already rendered at its
    target size, so no downscale/threshold mush). Returns a printable-tall image so to_raster
    centres/rotates it unchanged. Mirrors app.js placeInBand."""
    from PIL import Image
    cw, ch = img.size
    if ch >= printable:
        return img
    canvas = Image.new("1", (cw, printable), 1)
    y = 0 if align == "top" else (printable - ch) if align == "bottom" else (printable - ch) // 2
    canvas.paste(img.convert("1"), (0, y))
    return canvas


def build_job(rows, tape_mm, media_type=0x01, save_tape=False, compress=False):
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
    job += bytes([0x1B, 0x69, 0x64, 0x00, 0x00])                 # ESC i d  feed margin = 0 (tight butting; was 28)
    job += bytes([0x4D, 0x02 if compress else 0x00])            # M  TIFF/PackBits (0x02) vs none
    for r in rows:
        job += _raster_cmd(r, compress)                          # G  raster transfer
    # 0x1A (SUB) = print + eject; 0x0C (FF) = print + HOLD (no auto-feed) so the next label butts
    # up against this one (save-tape). Use feed()/the Feed button to push a held strip out to tear.
    job += bytes([0x0C if save_tape else 0x1A])
    return bytes(job)


def _blank_rows(n):
    return [bytes(BYTES_PER_LINE) for _ in range(n)]


def _cut_rows(n, printable):
    """A thin DOTTED cut-guide line spanning the printable width (n rows thick along the tape)."""
    x0 = (RASTER_WIDTH - printable) // 2
    line = bytearray(BYTES_PER_LINE)
    for i in range(printable):
        if i % CUT_DASH == 0:                        # dotted: light every CUT_DASH-th dot
            x = x0 + i
            line[x >> 3] |= (0x80 >> (x & 7))
    return [bytes(line) for _ in range(n)]


def assemble_cut(rows, printable, flip=False):
    """Add ONE cut-line + margins at the reading-LEFT end. In a strip each label's left cut line
    doubles as the previous label's right boundary, so one per label is enough and labels butt
    tightly: ...content | gap CUT gap | content...

    The laminated mirror (flip) reverses the raster's length axis: with flip OFF raster row 0 is
    the reading-left edge (prepend the cut), with flip ON row 0 is reading-right (append it) so
    the cut still lands on the LEFT of the finished, correctly-reading label."""
    g, ln = CUT_GAP_DOTS, CUT_LINE_DOTS
    cut = _blank_rows(g) + _cut_rows(ln, printable) + _blank_rows(g)
    return (list(rows) + cut) if flip else (cut + list(rows))


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
            save_tape=False, cut=False, scale=1.0, align="center"):
    printable = printable_dots(tape)
    do_flip = resolve_flip(flip, media_type)
    content = _render_sized(text, qr, font, height, printable, scale)   # rendered AT target size
    content = place_in_band(content, printable, align)
    rows, _ = to_raster(content, printable, do_flip)
    if cut:
        rows = assemble_cut(rows, printable, do_flip)
    canvas = rows_to_image(rows)
    return {
        "rows": rows, "canvas": canvas, "job": build_job(rows, tape, media_type, save_tape),
        "flip": do_flip, "tape": tape, "media_type": media_type, "lines": len(rows),
    }


def compose_rows(text=None, qr=None, tape=12, media_type=0x01, flip="auto", font=None, height=0,
                 cut=False, scale=1.0, align="center"):
    """Raster rows for a single label (no job wrapper) — used by batch printing."""
    printable = printable_dots(tape)
    do_flip = resolve_flip(flip, media_type)
    content = _render_sized(text, qr, font, height, printable, scale)
    content = place_in_band(content, printable, align)
    rows, _ = to_raster(content, printable, do_flip)
    if cut:
        rows = assemble_cut(rows, printable, do_flip)
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
        job += bytes([0x4D, 0x00])                               # M  uncompressed (P300BT can't decode 0x02)
        for r in rows:
            job += _raster_cmd(r, False)
        job += bytes([0x1A if i == len(pages) - 1 else 0x0C])    # eject after last; FF between
    return bytes(job)
