# ptouch-print-web

# A web based printing application for the Brother P300BT

# ptouch-print

Print labels to a **Brother PT-P300BT** (P-touch Cube) from a web page, an agent (MCP),
a REST call, or the command line. Reverse-engineered Brother ESC/P raster over the
printer's Bluetooth **SPP serial** link — no Brother driver or app required.

The P300BT is classic-Bluetooth SPP (not BLE); Windows exposes it as an outgoing COM port.
"Driver unavailable" in Bluetooth settings is normal — we write raw bytes to the port.

## Two ways to print

|                        | Runtime                    | Printing                         | Use it for                                                                       |
| ---------------------- | -------------------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| **Web** (`docs/`)      | static page (GitHub Pages) | browser **WebSerial** → COM port | quick manual labels from any Chromium browser on a machine paired to the printer |
| **Server** (`server/`) | Python + pyserial          | direct COM port                  | agents (**MCP**), scripts (**REST**/CLI), batch/automation                       |

Both render the identical raster; the ESC/P logic is mirrored in `server/ptouch/raster.py`
(Python) and `docs/app.js` (JS).

## Web app (GitHub Pages)

1. Settings → Pages → Deploy from branch → `main` / `/docs`.
2. Visit the page in **Chrome or Edge** (WebSerial is Chromium-only, needs HTTPS — Pages is).
3. **Connect** → pick the printer's serial port → **Detect tape** (or choose width) → **Print**.

Local dev: serve `docs/` over `http://localhost` (WebSerial needs a secure context — `file://`
will not work), e.g. `python -m http.server -d docs 8000`.

## Server (MCP / REST / CLI)

```bash
cd server
python -m venv .venv && .venv/Scripts/activate     # Windows; use bin/activate on *nix
pip install -r requirements.txt
```

CLI:

```bash
python ptprint.py --status                          # what tape is loaded?
python ptprint.py --text "BOX-A"                    # auto-detect tape, print to COM6
python ptprint.py --qr "https://parts.d3n.sh/loc/42" --tape 12
python ptprint.py --text "SHRINK" --flip off --tape 6     # heat-shrink: no mirror
python ptprint.py --text "BOX-A" --dry preview.png --tape 6
python ptprint.py --logo ./logo.png --qr "https://example.com"  # your logo + QR (see below)
```

MCP server (stdio) — exposes `printer_status`, `print_text`, `print_qr`:

```bash
python mcp_server.py
```

Register with an MCP client (adjust paths/port):

```json
{
  "mcpServers": {
    "ptouch": {
      "command": "python",
      "args": ["mcp_server.py"],
      "cwd": "D:/Projects/ptouch-print/server",
      "env": { "PTOUCH_PORT": "COM6" }
    }
  }
}
```

REST API:

```bash
uvicorn api:app --host 127.0.0.1 --port 8088
# GET  /status
# POST /print   {"text":"BOX-A","tape":6,"flip":"auto"}
```

## Logo + QR label

Prints **your own** logo — alone or beside a QR code. No logo or brand asset ships with this
project: you supply the image, so nothing personal ends up in the public repo or the Pages site.

- **Web:** Label → **Logo + QR**, choose a logo image (PNG/JPG/SVG) and enter the URL (blank = logo
  only). The logo and URL are kept in *your browser's* localStorage only and never uploaded.
- **CLI:** `python ptprint.py --logo ./logo.png --qr "https://example.com"` — `--logo` takes any
  image file (flattened onto white, trimmed to its ink, thresholded). Combine with `--tape`,
  `--size`, `--align`, `--cut`, `--dry`.

How it's laid out: logo and QR share the full printable band (64 dots ≈ 9 mm on 12 mm tape).
The QR uses **whole dots per module** (3 dots = 0.42 mm for a 21-module code on 12 mm tape, 2 dots
on 9 mm) — fractional scaling is what makes thermal QR codes unscannable. The URL's scheme and host
are upper-cased in the payload so a short URL fits QR version 1 in alphanumeric mode (they're
case-insensitive, so it opens identically; the path is left as typed). Needs **≥ 9 mm tape**; a URL
too long for ≥ 2 dots/module is refused with a clear error rather than printed unreadable.
A wide logo + QR label is long and dense — use fresh batteries or 5V power.

## Printer notes (learned the hard way)

- **Tape width must match the loaded tape** or the printer throws a **red blinking light**
  (media mismatch). Omit `--tape` / use _Detect_ to auto-read it via `ESC i S`.
- An error blink **latches** — power-cycle the printer to clear it.
- **Laminated tape prints mirrored** and is auto-flipped to read correctly; **heat-shrink
  must NOT be flipped** (`flip=off` / media=heat-shrink). `auto` picks by detected media type.
- QR needs **≥ 9mm** tape; 6mm is too dense to scan.

## Protocol (uncompressed raster)

`ESC @` init · `ESC i a 01` raster mode · `ESC i z` print-info (media type + width mm +
line count) · `ESC i K/M/d` mode/margins · `M 00` compression off · per line `G 10 00` +
16 bytes (128 dots, MSB-first, bit set = black) · `1A` print+feed.

## Credits

Protocol derived from community reverse-engineering of the PT-P300BT
(stecman, Ircama, kacpi2442). MIT licensed.
