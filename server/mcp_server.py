#!/usr/bin/env python3
"""MCP server exposing the PT-P300BT label printer as agent-callable tools.

Run:   python mcp_server.py         (stdio; from the server/ directory)
Env:   PTOUCH_PORT  overrides the default COM port (default COM6).
"""
import os

from mcp.server.fastmcp import FastMCP

from ptouch import printer

DEFAULT_PORT = os.environ.get("PTOUCH_PORT", printer.DEFAULT_PORT)
mcp = FastMCP("ptouch")


@mcp.tool()
def printer_status(port: str = DEFAULT_PORT) -> dict:
    """Read the loaded tape width (mm) and media type from the printer. Use before printing
    if you are unsure which tape is loaded."""
    return printer.status(port) or {
        "error": "no status response (printer off/asleep, or does not support ESC i S)"
    }


@mcp.tool()
def print_text(text: str, tape: int | None = None, flip: str = "auto",
               port: str = DEFAULT_PORT) -> dict:
    """Print a text label. Omit `tape` to auto-detect the loaded width. `flip`: auto|on|off
    (use 'off' for heat-shrink tube). Returns what was printed."""
    return printer.print_label(text=text, tape=tape, flip=flip, port=port)


@mcp.tool()
def print_qr(data: str, tape: int | None = None, flip: str = "auto",
             port: str = DEFAULT_PORT) -> dict:
    """Print a QR-code label encoding `data` (e.g. a Part-DB location URL). Use tape >= 9mm;
    QR on 6mm is too dense to scan reliably."""
    return printer.print_label(qr=data, tape=tape, flip=flip, port=port)


if __name__ == "__main__":
    mcp.run()
