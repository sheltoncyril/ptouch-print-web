#!/usr/bin/env python3
"""Optional REST API for the label printer.

Run:  uvicorn api:app --host 127.0.0.1 --port 8088   (from the server/ directory)
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from ptouch import printer

app = FastAPI(title="ptouch-print", version="0.1.0")


class Label(BaseModel):
    text: str | None = None
    qr: str | None = None
    tape: int | None = None          # omit to auto-detect
    flip: str = "auto"               # auto | on | off
    port: str = printer.DEFAULT_PORT


@app.get("/status")
def status(port: str = printer.DEFAULT_PORT):
    st = printer.status(port)
    if not st:
        raise HTTPException(503, "no status response from printer")
    return st


@app.post("/print")
def print_label(label: Label):
    if not (label.text or label.qr):
        raise HTTPException(400, "text or qr is required")
    try:
        return printer.print_label(text=label.text, qr=label.qr, tape=label.tape,
                                   flip=label.flip, port=label.port)
    except Exception as e:
        raise HTTPException(500, str(e))
