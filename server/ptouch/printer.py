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


def read_status(ser):
    """ESC i S -> 32-byte status block. Returns {'width','type','heat_shrink','raw'} or None."""
    try:
        ser.reset_input_buffer()
        ser.write(bytes([0x1B, 0x40, 0x1B, 0x69, 0x53]))     # ESC @ then ESC i S
        ser.flush()
        time.sleep(0.4)
        data = ser.read(32)
        if len(data) >= 12 and data[0] == 0x80:
            return {
                "width": data[10],
                "type": data[11],
                "heat_shrink": data[11] in raster.HEAT_SHRINK_TYPES,
                "err": (data[8] | data[9]) if len(data) >= 10 else 0,
                "phase": data[19] if len(data) >= 20 else 0,
                "raw": bytes(data).hex(),
            }
    except Exception:
        pass
    return None


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


def send_job(ser, job, chunk=128):
    # Pace WELL below the ~9mm head's print rate (~2-3 KB/s) so the printer's small input
    # buffer never overflows. Overflowing drops the tail -> printer stalls waiting for the
    # raster lines it was promised (ESC i z count) -> red. ~850 B/s here.
    for i in range(0, len(job), chunk):
        ser.write(job[i:i + chunk])
        ser.flush()
        time.sleep(0.15)
    time.sleep(3.5)          # let the printer finish feeding before the port closes / next job opens


def status(port=DEFAULT_PORT):
    ser = open_port(port)
    try:
        return read_status(ser)
    finally:
        ser.close()


def print_label(text=None, qr=None, tape=None, flip="auto", font=None, height=0,
                port=DEFAULT_PORT, media_type=None, save_tape=False, cut=False):
    """Compose and print. Omit `tape` to auto-detect width+media from the printer."""
    if not (text or qr):
        raise ValueError("text or qr is required")
    ser = open_port(port)
    try:
        detected = None
        if tape is None or flip == "auto" or media_type is None:
            detected = read_status(ser)
        if media_type is None:
            media_type = detected["type"] if (detected and detected["type"]) else 0x01
        if tape is None:
            if detected and detected["width"]:
                tape = detected["width"]
            else:
                raise RuntimeError("could not detect tape width; pass tape=<mm> "
                                   "(and flip='off' for heat-shrink)")
        if not wait_ready(ser):
            raise RuntimeError("printer busy or in error (red light) — power-cycle if red, else wait and retry")
        comp = raster.compose(text=text, qr=qr, tape=tape, media_type=media_type,
                              flip=flip, font=font, height=height, save_tape=save_tape, cut=cut)
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
