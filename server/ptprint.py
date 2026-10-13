#!/usr/bin/env python3
"""Command-line label printer for the Brother PT-P300BT. Thin wrapper over the ptouch package.

  python ptprint.py --text "BOX-A"                 # auto-detect tape, print to COM6
  python ptprint.py --qr "https://parts.d3n.sh/loc/42" --tape 12
  python ptprint.py --text "SHRINK" --flip off --tape 6      # heat-shrink: no mirror
  python ptprint.py --text "BOX-A" --dry preview.png --tape 6
  python ptprint.py --logo ./logo.png --qr "https://example.com"   # your logo + QR (needs tape >= 9mm)
  python ptprint.py --status
"""
import argparse

from ptouch import printer, raster


def main():
    ap = argparse.ArgumentParser(prog="ptprint")
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument("--text")
    g.add_argument("--qr")
    ap.add_argument("--logo", metavar="PATH",
                    help="print your own logo image (PNG/JPG; flattened onto white, trimmed, thresholded), "
                         "alone or beside --qr. Not combinable with --text")
    ap.add_argument("--port", default=printer.DEFAULT_PORT)
    ap.add_argument("--tape", type=int, choices=[6, 9, 12],
                    help="loaded tape width mm — P300BT supports 6/9/12 (omit = auto-detect)")
    ap.add_argument("--flip", choices=["auto", "on", "off"], default="auto",
                    help="mirror the image: auto (by detected media), on (laminated), off (heat-shrink)")
    ap.add_argument("--chain", dest="save_tape", action="store_true",
                    help="chain printing (batch tape-saving); a single label stays inside until the next print")
    ap.add_argument("--cut", action="store_true", help="print a thin dotted cut-line guide (reading-left)")
    ap.add_argument("--font", metavar="NAME|PATH",
                    help=f"font file path, or a bundled font: {' | '.join(raster.FONT_FILES)} "
                         "(default: Arial Bold / system fallback)")
    ap.add_argument("--slant", action="store_true",
                    help=f"lean the text {raster.LEAN_DEG} degrees forward (techno / trace-style lettering)")
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--size", type=float, default=1.0,
                    help="text height as a fraction of the tape (1=fit, 0.5=half)")
    ap.add_argument("--align", choices=["center", "top", "bottom"], default="center",
                    help="position across the tape width when below fit")
    ap.add_argument("--dry", metavar="PNG", help="render a preview PNG, do not print")
    ap.add_argument("--status", action="store_true", help="query loaded tape/media and exit")
    ap.add_argument("--feed", action="store_true",
                    help="feed/eject tape (push out a label held by a no-feed batch) and exit")
    a = ap.parse_args()

    if a.status:
        st = printer.status(a.port)
        print(st if st else "no status response (printer may not support ESC i S)")
        return

    if a.feed:
        print(printer.feed_out(a.port))
        return

    if not (a.text or a.qr or a.logo):
        ap.error("one of --text, --qr or --logo is required")
    if a.logo and a.text:
        ap.error("--logo can't be combined with --text (use --logo with --qr, or alone)")

    if a.dry:
        from PIL import Image
        tape = a.tape or 12
        try:
            comp = raster.compose(text=a.text, qr=a.qr, tape=tape, flip=a.flip,
                                  font=a.font, height=a.height, save_tape=a.save_tape, cut=a.cut,
                                  scale=a.size, align=a.align, logo=a.logo, slant=a.slant)
        except (ValueError, FileNotFoundError) as e:
            ap.error(str(e))
        c = comp["canvas"]
        c.resize((raster.RASTER_WIDTH * 4, c.size[1] * 4), Image.NEAREST).save(a.dry)
        print(f"DRY tape={tape}mm flip={'on' if comp['flip'] else 'off'} "
              f"{comp['lines']} lines -> {a.dry}")
        return

    try:
        print(printer.print_label(text=a.text, qr=a.qr, tape=a.tape, flip=a.flip,
                                  font=a.font, height=a.height, port=a.port, save_tape=a.save_tape, cut=a.cut,
                                  scale=a.size, align=a.align, logo=a.logo, slant=a.slant))
    except (ValueError, FileNotFoundError) as e:
        ap.error(str(e))


if __name__ == "__main__":
    main()
