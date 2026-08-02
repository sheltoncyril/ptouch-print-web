# ptouch-print — session handoff (2026-08-02)

Goal: reliable label printing to a **Brother PT-P300BT** (P-touch Cube) over Bluetooth SPP.
This doc hands a fresh session everything learned so it can go straight at the open problem.

## What works (reliable)
- **Plain short single labels** (text + QR) — prints clean every time.
- Tape **auto-detect** via `ESC i S` (width + media type). Works on this unit.
- **mm-ruler reading-view preview** in the web app.
- **Sequential job-by-job** printing with a **ready-gate** (`printer.wait_ready`) + open-retry.
- CLI / MCP / REST / static WebSerial front-end all built; JS mirrors `raster.py`.

## What's BROKEN on the P300BT — all the same failure: a STALL, not a fault
- **Cut marks** (adds solid full-width lines + blank gap rows → ~136 lines) → stall
- **Chained multi-page batch** (`raster.build_batch_job`) → stall
- **No-feed / "save tape"** (`0C` terminator) → stall (removed from UI/CLI)
- **Upscaled content** (always-scale to `printable`) → blank (reverted)

## The core unsolved problem
Any job beyond a short plain label makes the printer **stall**:
- Status read **with `ESC i S` only (NO `ESC @`)** shows the **phase byte (offset 19) stuck at `0x01` ("printing")** indefinitely.
- Error bytes (offsets 8, 9) are **`0x00`** — no hardware fault. The red LED = this stall.
- The printer is **waiting for raster data it was promised** (the `ESC i z` line count) but never fully got/processed.

Confirmed on hardware:
- Plain `A1`/`10k`/`A2` (~90 lines, ~1745 B): clean, phase returns to `0x00`.
- Cut `A1` (~136 lines, ~2619 B): stalls (phase stuck `0x01` for 8s+).
- Slowing the send to ~850 B/s (128-byte chunks, 150 ms) did **NOT** help.
- **GOTCHA:** `read_status()` / `ptprint --status` send `ESC @` first, which **resets the printer and clears the stall**, so they always show `phase 0 / err 0`. To see the real stalled state you MUST send `ESC i S` only.

## Fixes to try next — RANKED
1. **Compression (TIFF/packbits, `M 0x02`).** ← almost certainly the fix.
   We currently send **uncompressed** raster (`M 0x00`), 19 bytes/line. Large jobs overflow the
   Cube's small input buffer → stall. The Brother app uses compression; solid/blank lines
   (cut marks, gaps) compress to almost nothing. Implement PackBits per raster line, send `M 0x02`.
   Expect this to make cut marks + longer labels fit and print.
2. **Continuous stream (drop the inter-chunk delays).** The 150 ms pacing gaps may make the
   printer think the stream ended → stall. Try one `write()` of the whole job (or ~no delay).
   (The earlier WebSerial single-big-write truncation looked like a WebSerial buffer quirk, not
   the printer — pyserial can likely stream it whole.)
3. **Max raster lines per job.** Binary-search the threshold (90 works, 136 stalls → test
   100/110/120). If there's a hard cap, keep labels under it.

## How to reproduce / diagnose
```
# reproduce the stall:
python server/ptprint.py --text "A1" --tape 12 --cut --port COM6

# read the TRUE state (catches the stall; ESC i S only, no reset):
python - <<'PY'
import time, serial
p = serial.Serial("COM6", 9600, timeout=2, write_timeout=10); time.sleep(2)
for i in range(8):
    p.reset_input_buffer(); p.write(bytes([0x1B,0x69,0x53])); p.flush(); time.sleep(0.3)
    d = p.read(32)
    print(i, "phase=0x%02x err=0x%02x/0x%02x" % (d[19], d[8], d[9]) if len(d)>=20 else "no-status")
    time.sleep(1)
p.close()
PY
# phase stuck 0x01 + err 0 = stalled waiting for data. Power-cycle (or send ESC @) to clear.
```

## Hardware facts (P300BT Cube)
- Classic-BT **SPP**, **COM6** on this PC (MAC `986EE84B2268`). NOT BLE. No Windows driver
  ("driver unavailable" is normal — we write raw bytes to the COM port).
- Multiple printers paired here — match by name/MAC. "Sir PrintsALot" (MAC `66328A501F75`,
  COM3) is a DIFFERENT printer. The P300BT advertises **`PT-P300BT9735`**.
- Max print height **~9 mm even on 12 mm tape** → `printable` capped at **64 dots** for tape ≥ 9 mm.
- Only `1A` (print+eject) works; `0C` (no-feed) and chained pages stall.
- Test tape loaded = 12 mm laminated.

## Architecture
`server/ptouch/raster.py` (render + ESC/P), `server/ptouch/printer.py` (serial, `wait_ready`,
open-retry), `server/ptprint.py` (CLI), `server/mcp_server.py` (MCP), `server/api.py` (REST).
`docs/` = static WebSerial UI (`app.js` mirrors `raster.py`). See `README.md`.
