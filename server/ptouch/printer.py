"""Serial transport for the PT-P300BT (pyserial). Talks to the Bluetooth SPP COM port."""
from __future__ import annotations

import time

from . import raster

DEFAULT_PORT = "COM6"
DEFAULT_BAUD = 9600


def open_port(port=DEFAULT_PORT, timeout=3, write_timeout=10, attempts=6, delay=1.0):
    import serial
    last = None
    for _ in range(attempts):
        try:
            ser = serial.Serial(port, DEFAULT_BAUD, timeout=timeout, write_timeout=write_timeout)
            time.sleep(2.0)      # let the Bluetooth SPP link come up before use
            return ser
        except serial.SerialException as e:
            last = e             # transient BT states after a prior job: port busy / link tearing down
            time.sleep(delay)
    raise last


# 32-byte status block error bits. err1 = offset 8, err2 = offset 9.
# NB: err1 0x08 = weak batteries. A dense/long print sags weak AAAs until the head trips this
# and reds "near the end" — it looks exactly like a raster/buffer stall but is pure power.
ERR1 = {0x01: "no media", 0x02: "end of media", 0x04: "cutter jam",
        0x08: "WEAK BATTERIES (replace all 6 AAA / use a 5V wall charger)",
        0x10: "printer in use", 0x40: "high-voltage adapter"}
ERR2 = {0x01: "replace media", 0x02: "expansion buffer full", 0x04: "comm error",
        0x08: "comm buffer full", 0x10: "cover open", 0x20: "overheated",
        0x40: "black mark not found", 0x80: "system error"}


def decode_error(err1, err2):
    msgs = [v for b, v in ERR1.items() if err1 & b] + [v for b, v in ERR2.items() if err2 & b]
    return ", ".join(msgs)


def read_status(ser):
    """ESC i S -> 32-byte status block. Returns dict (incl. decoded 'error') or None.
    Queries TWICE and keeps the last: right after a tape swap the first read can still
    report the PREVIOUS cartridge (stale), the second reports the current one."""
    data = b""
    try:
        for _ in range(2):
            ser.reset_input_buffer()
            ser.write(bytes([0x1B, 0x40, 0x1B, 0x69, 0x53]))     # ESC @ then ESC i S
            ser.flush()
            time.sleep(0.4)
            d = ser.read(32)
            if len(d) >= 12 and d[0] == 0x80:
                data = d
    except Exception:
        pass
    if len(data) >= 12 and data[0] == 0x80:
        e1, e2 = (data[8], data[9]) if len(data) >= 10 else (0, 0)
        return {
            "width": data[10],
            "type": data[11],
            "heat_shrink": data[11] in raster.HEAT_SHRINK_TYPES,
            "err": e1 | e2,
            "err1": e1, "err2": e2,
            "error": decode_error(e1, e2),
            "weak_battery": bool(e1 & 0x08),
            "phase": data[19] if len(data) >= 20 else 0,
            "raw": bytes(data).hex(),
        }
    return None


def reset(ser):
    """Clear a stalled/red printer WITHOUT a physical power-cycle (Brother null-flush idiom):
    invalidate + init, drain status, 64 NUL bytes to flush the command parser, init again."""
    try:
        ser.write(bytes([0x1B, 0x69, 0x61, 0x01, 0x1B, 0x40])); ser.flush()   # raster mode + ESC @
        ser.reset_input_buffer()
        ser.write(bytes([0x1B, 0x69, 0x53])); ser.flush(); time.sleep(0.3); ser.read(32)
        ser.write(bytes(64)); ser.flush()                                     # 64 NUL -> flush parser
        ser.write(bytes([0x1B, 0x40])); ser.flush(); time.sleep(0.2)          # ESC @ init
    except Exception:
        pass


def wait_ready(ser, timeout=15.0):
    """Poll status (ESC i S) until the printer is idle and error-free.
    Returns True if ready, False on error (red) or timeout."""
    for _ in range(max(1, int(timeout / 0.5))):
        try:
            ser.reset_input_buffer()
            ser.write(bytes([0x1B, 0x69, 0x53]))     # ESC i S only (no ESC @ — don't reset a busy printer)
            ser.flush()
            time.sleep(0.3)
            data = ser.read(32)
        except Exception:
            data = b""
        if len(data) >= 20 and data[0] == 0x80:
            if (data[8] | data[9]) != 0:
                return False                          # error / red light
            if data[19] == 0:                         # phase == 0 -> ready/waiting
                return True
        time.sleep(0.5)
    return False


def send_job(ser, job, pace=False, chunk=128, gap=0.15):
    # Stream the whole job in ONE write; Bluetooth RFCOMM flow-controls it to the printer's pace.
    # (The old 128 B / 150 ms throttle was cargo-culted against a "buffer overflow" that turned
    # out to be weak batteries — see docs/HANDOFF.md. Continuous is simpler and fine.)
    if pace:                                    # legacy throttled path, kept for A/B testing
        for i in range(0, len(job), chunk):
            ser.write(job[i:i + chunk]); ser.flush(); time.sleep(gap)
    else:
        ser.write(job); ser.flush()             # continuous; RFCOMM paces it
    time.sleep(3.5)          # let the printer finish feeding before the port closes / next job opens


def feed(ser):
    """Advance + eject tape without printing — pushes out any label held inside by a no-feed
    (0C) job so it can be torn off. A tiny blank raster ending in the 1A print+eject."""
    reset(ser)                                          # clear any red, init
    st = read_status(ser) or {}
    tape = st.get("width") or 12
    media_type = st.get("type") or 0x01
    job = raster.build_job(raster._blank_rows(8), tape, media_type, compress=False)
    send_job(ser, job)
    return {"fed": True, "tape": tape}


def status(port=DEFAULT_PORT):
    ser = open_port(port)
    try:
        return read_status(ser)
    finally:
        ser.close()


def feed_out(port=DEFAULT_PORT):
    """Open the port, feed/eject tape, close. Used by the CLI/REST 'feed' button."""
    ser = open_port(port)
    try:
        return feed(ser)
    finally:
        ser.close()


def print_label(text=None, qr=None, tape=None, flip="auto", font=None, height=0,
                port=DEFAULT_PORT, media_type=None, save_tape=False, cut=False,
                scale=1.0, align="center"):
    """Compose and print. Omit `tape` to auto-detect width+media from the printer."""
    if not (text or qr):
        raise ValueError("text or qr is required")
    ser = open_port(port)
    try:
        reset(ser)                                    # clear any prior stall/red without a power-cycle
        detected = read_status(ser)
        if detected and detected.get("weak_battery"):
            # fail before wasting a label — a dense/long print will brown out and red mid-feed
            raise RuntimeError("weak batteries: replace all 6 AAA (fresh alkaline) or run off a 5V "
                               "wall charger, then retry — this is the usual cause of end-of-label reds")
        if media_type is None:
            media_type = detected["type"] if (detected and detected["type"]) else 0x01
        if tape is None:
            if detected and detected["width"]:
                tape = detected["width"]
            else:
                raise RuntimeError("could not detect tape width; pass tape=<mm> "
                                   "(and flip='off' for heat-shrink)")
        if not wait_ready(ser):
            st = read_status(ser)
            why = (st and st.get("error")) or "busy/red — power-cycle if red, else wait and retry"
            raise RuntimeError(f"printer not ready: {why}")
        comp = raster.compose(text=text, qr=qr, tape=tape, media_type=media_type,
                              flip=flip, font=font, height=height, save_tape=save_tape, cut=cut,
                              scale=scale, align=align)
        send_job(ser, comp["job"])
        return {
            "printed": True, "tape": tape, "flip": comp["flip"],
            "media_type": media_type, "lines": comp["lines"],
            "bytes": len(comp["job"]), "detected": detected,
        }
    finally:
        ser.close()


def print_batch(items, port=DEFAULT_PORT, tape=None, flip="auto", media_type=None, cut=False):
    """Print several labels as SEPARATE sequential jobs (one eject each).

    The PT-P300BT (Cube) red-blinks on chained multi-page / FF jobs, so each label is its
    own job; open_port's retry + send_job's settle handle the spacing between them. A blank
    gap between labels is unavoidable on this hardware (it can't chain).
    items: list of str (text) or dicts {text|qr, cut?}."""
    if not items:
        raise ValueError("no items to print")
    results = []
    for it in items:
        if isinstance(it, str):
            it = {"text": it}
        if not (it.get("text") or it.get("qr")):
            raise ValueError("each batch item needs 'text' or 'qr'")
        results.append(print_label(text=it.get("text"), qr=it.get("qr"), tape=tape,
                                    flip=flip, media_type=media_type, cut=it.get("cut", cut), port=port))
    return {"printed": len(results), "results": results}
