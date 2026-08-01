"""Serial transport for the PT-P300BT (pyserial). Talks to the Bluetooth SPP COM port."""
from __future__ import annotations

import time

from . import raster

DEFAULT_PORT = "COM6"
DEFAULT_BAUD = 9600


def open_port(port=DEFAULT_PORT, timeout=3, write_timeout=10):
    import serial
    ser = serial.Serial(port, DEFAULT_BAUD, timeout=timeout, write_timeout=write_timeout)
    time.sleep(2.0)          # let the Bluetooth SPP link come up before use
    return ser


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
                "raw": bytes(data).hex(),
            }
    except Exception:
        pass
    return None


def send_job(ser, job, chunk=512):
    for i in range(0, len(job), chunk):
        ser.write(job[i:i + chunk])
        ser.flush()
        time.sleep(0.02)
    time.sleep(1.0)


def status(port=DEFAULT_PORT):
    ser = open_port(port)
    try:
        return read_status(ser)
    finally:
        ser.close()


def print_label(text=None, qr=None, tape=None, flip="auto", font=None, height=0,
                port=DEFAULT_PORT, media_type=None):
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
        comp = raster.compose(text=text, qr=qr, tape=tape, media_type=media_type,
                              flip=flip, font=font, height=height)
        send_job(ser, comp["job"])
        return {
            "printed": True, "tape": tape, "flip": comp["flip"],
            "media_type": media_type, "lines": comp["lines"],
            "bytes": len(comp["job"]), "detected": detected,
        }
    finally:
        ser.close()
