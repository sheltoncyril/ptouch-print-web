#!/usr/bin/env python3
"""Command-line label printer for the Brother PT-P300BT. Thin wrapper over the ptouch package.

  python ptprint.py --text "BOX-A"                 # auto-detect tape, print to COM6
  python ptprint.py --qr "https://parts.d3n.sh/loc/42" --tape 12
  python ptprint.py --text "SHRINK" --flip off --tape 6      # heat-shrink: no mirror
  python ptprint.py --text "BOX-A" --dry preview.png --tape 6
  python ptprint.py --status
"""
import argparse

from ptouch import printer, raster


def main():
    ap = argparse.ArgumentParser(prog="ptprint")
    g = ap.add_mutually_exclusive_group(required=False)
    g.add_argument("--text")
    g.add_argument("--qr")
    ap.add_argument("--port", default=printer.DEFAULT_PORT)
    ap.add_argument("--tape", type=int, choices=[6, 9, 12, 18, 24],
                    help="loaded tape width mm (omit = auto-detect)")
    ap.add_argument("--flip", choices=["auto", "on", "off"], default="auto",
                    help="de-mirror: auto (by media), on (laminated), off (heat-shrink)")
    ap.add_argument("--chain", dest="save_tape", action="store_true",
                    help="chain printing (batch tape-saving); a single label stays inside until the next print")
    ap.add_argument("--cut", action="store_true", help="print cut-line marks at both ends")
    ap.add_argument("--font")
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--dry", metavar="PNG", help="render a preview PNG, do not print")
    ap.add_argument("--status", action="store_true", help="query loaded tape/media and exit")
    a = ap.parse_args()

    if a.status:
        st = printer.status(a.port)
        print(st if st else "no status response (printer may not support ESC i S)")
        return

    if not (a.text or a.qr):
        ap.error("one of --text or --qr is required")

    if a.dry:
        from PIL import Image
        tape = a.tape or 12
        comp = raster.compose(text=a.text, qr=a.qr, tape=tape, flip=a.flip,
                              font=a.font, height=a.height, save_tape=a.save_tape, cut=a.cut)
        c = comp["canvas"]
        c.resize((raster.RASTER_WIDTH * 4, c.size[1] * 4), Image.NEAREST).save(a.dry)
        print(f"DRY tape={tape}mm flip={'on' if comp['flip'] else 'off'} "
              f"{comp['lines']} lines -> {a.dry}")
        return

    print(printer.print_label(text=a.text, qr=a.qr, tape=a.tape, flip=a.flip,
                              font=a.font, height=a.height, port=a.port, save_tape=a.save_tape, cut=a.cut))


if __name__ == "__main__":
    main()
