# ptouch-print — session handoff (updated 2026-08-02)

Goal: reliable label printing to a **Brother PT-P300BT** (P-touch Cube) over Bluetooth SPP.

## ✅ SOLVED: the "stall on cut marks / long labels" was WEAK BATTERIES

The long-standing stall — cut marks, long labels, dense jobs printing "almost to the end"
then going **red** — was **not** a raster/protocol bug. It was the printer **browning out**:
the thermal head draws big current bursts per line; partly-drained AAAs sag under a long/dense
print until the head trips Brother's **weak-battery fault (status error1 bit `0x08`)**, always
near the end. Short/sparse labels finish before the sag, so they always worked.

**Fix: fresh alkaline AAAs (all 6) or a solid 5V wall charger.** With fresh cells, everything
that used to stall prints first try — confirmed on hardware:
- Plain `BOX` (138 lines) ✓   - Cut `A1` (136 lines) ✓   - Cut `OK` (152 lines) ✓
- **Compression `M 0x02`** (TIFF/PackBits) ✓ — `ZIP` compressed, 102 lines, 1156 B

## Red herrings we chased (ALL were the battery)
Every one of these "failures" happened on the dying batteries and showed `err 0x08`:
- "Uncompressed raster overflows a small input buffer" — **false**. 1593 B prints, 842 B stalled
  (battery), byte-count was never the axis.
- "M 0x02 compression is unsupported / my packbits is wrong" — **false**. `_packbits` is
  byte-identical to the reference `packbits` PyPI module (4004-case round-trip + direct diff),
  and compression prints fine on fresh batteries. A byte-exact replica of stecman's known-good
  driver still "stalled" — because the batteries were flat.
- "Line-count cap ~90", "send too fast/slow", "feed-margin", "null-flush handshake" — all noise.

**Lesson: on a red/stall, read `err1` (status offset 8) FIRST. `0x08` = replace batteries.**

## What works now (reliable, on good power)
- Plain + QR + **cut marks** + **long labels**, uncompressed or compressed.
- Tape auto-detect (`ESC i S`), mm-ruler web preview, sequential batch with ready-gate + open-retry.
- CLI / MCP / REST / static WebSerial front-end. `raster.py` ↔ `docs/app.js` kept in sync.
- **`printer.reset()`** clears a red/stalled printer WITHOUT a physical power-cycle (Brother
  null-flush idiom: raster-mode + `ESC @`, drain status, 64× `0x00`, `ESC @`). `print_label`
  calls it on open, so a prior stall self-heals.
- **Weak-battery guard**: `print_label` reads status on open and refuses with a clear
  "replace batteries" error before wasting a label; `read_status()` returns `err1/err2/error/
  weak_battery`, and `decode_error()` maps the bits.

## Compression (`M 0x02`, TIFF/PackBits) — now proven good
- `raster._packbits()` = standard TIFF PackBits, verified identical to the `packbits` module.
- `build_job(..., compress=?)` toggles it. Per-line: `47 <lenLE16> <packbits>`, global `M 02`.
- Benefit: ~half the bytes → less time under load → **less brownout risk** + longer labels fit.
- **Recommended default: ON** (flip `build_job(compress=True)` once legibility is eyeballed).
  Currently defaults to `False` (known-good uncompressed) pending that confirmation.

## Diagnostics (still useful)
```
# read the TRUE state (ESC i S only — do NOT send ESC @, which resets & hides a stall):
python - <<'PY'
import time, serial
p = serial.Serial("COM6", 9600, timeout=2, write_timeout=10); time.sleep(2)
for i in range(6):
    p.reset_input_buffer(); p.write(bytes([0x1B,0x69,0x53])); p.flush(); time.sleep(0.3)
    d = p.read(32)
    print(i, "phase=0x%02x err1=0x%02x err2=0x%02x" % (d[19], d[8], d[9]) if len(d)>=20 else "no-status")
    time.sleep(1)
p.close()
PY
# err1 0x08 -> WEAK BATTERIES. phase stuck 0x01 -> mid-print. Recover: printer.reset(ser) (no power-cycle).
```

## Hardware facts (P300BT Cube)
- Classic-BT **SPP**, **COM6** on this PC (MAC `986EE84B2268`). NOT BLE. "Driver unavailable" is
  normal — we write raw bytes to the COM port. BT link can drop after a job → `open_port` retries
  (WinError 121 "semaphore timeout" = link re-establishing).
- Powered by **6× AAA** (or 5V USB). **Keep them fresh** — low batteries = the stall above.
- Max print height ~9 mm even on 12 mm tape → `printable` capped at 64 dots for tape ≥ 9 mm.
- Only `1A` (print+eject) terminator works; `0C` (no-feed) and chained/`FF` multi-page stall
  (those may also have been battery — not re-tested, low priority; single ejecting jobs are fine).
- Test tape loaded = 12 mm laminated.

## Architecture
`server/ptouch/raster.py` (render + ESC/P + packbits), `server/ptouch/printer.py` (serial,
`reset`, `wait_ready`, `read_status`+error decode, open-retry), `server/ptprint.py` (CLI),
`server/mcp_server.py` (MCP), `server/api.py` (REST). `docs/` = static WebSerial UI
(`app.js` mirrors `raster.py`). See `README.md`.
