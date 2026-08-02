/* ptouch-print WebSerial UI.
   Renders labels in-browser and streams Brother ESC/P raster to a PT-P300BT over a
   Bluetooth SPP serial port. Mirrors server/ptouch/raster.py — keep the two in sync. */
"use strict";

const RASTER_WIDTH = 128;
const BYTES_PER_LINE = 16;
const HEAT_SHRINK_TYPES = new Set([0x11, 0x17]);
const KNOWN_PRINTABLE = { 6: 32, 9: 50, 12: 64, 18: 64, 24: 64 };   // P300BT caps print at ~9mm (64 dots)
const DPMM = 180 / 25.4;                               // printer dots per millimetre
const CUT_GAP_DOTS = 12;                               // blank margin either side of a cut line (~1.7mm)
const CUT_LINE_DOTS = 3;                               // cut-line thickness along the tape (~0.4mm)

let port = null;
let detectedTape = null;

const $ = (id) => document.getElementById(id);
function log(msg) { const el = $("log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; }

function printableDots(mm) {
  return KNOWN_PRINTABLE[mm] || Math.max(8, Math.min(RASTER_WIDTH, Math.round(mm * DPMM * 0.80)));
}
function resolveFlip(flip, mediaType) {
  if (flip === "on") return true;
  if (flip === "off") return false;
  return !HEAT_SHRINK_TYPES.has(mediaType);            // auto: laminated flips, heat-shrink doesn't
}
function printableSpan(printable) { return Math.floor((RASTER_WIDTH - printable) / 2); }   // x0

/* ---- render content to a tight black-on-white canvas ---- */
function renderText(text) {
  const F = 128;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = `bold ${F}px Arial, sans-serif`;
  const m = meas.measureText(text);
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const w = Math.max(1, Math.ceil(left + right));
  const h = Math.max(1, Math.ceil(asc + desc));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000"; ctx.font = `bold ${F}px Arial, sans-serif`; ctx.textBaseline = "alphabetic";
  ctx.fillText(text, left, asc);
  return c;
}
function renderQR(data) {
  if (typeof qrcode === "undefined") throw new Error("QR library not loaded (offline?)");
  const qr = qrcode(0, "M"); qr.addData(data); qr.make();
  const n = qr.getModuleCount();
  const c = document.createElement("canvas"); c.width = n; c.height = n;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) ctx.fillRect(col, r, 1, 1);
  return c;
}

/* ---- scale to printable height, flip/rotate/center, pack into 16-byte raster rows ----
   Matches PIL: flip LR -> scale to printable height -> rotate(-90) -> centre in 128 dots. */
function buildRows(content, printable, flip) {
  const Ws = Math.max(1, Math.round(content.width * printable / content.height));
  const sc = document.createElement("canvas"); sc.width = Ws; sc.height = printable;
  const sctx = sc.getContext("2d"); sctx.imageSmoothingEnabled = true;
  sctx.drawImage(content, 0, 0, Ws, printable);
  const px = sctx.getImageData(0, 0, Ws, printable).data;
  const dark = (r, c) => { const i = (r * Ws + c) * 4; return px[i + 3] > 10 && (px[i] + px[i + 1] + px[i + 2]) / 3 < 128; };
  const x0 = printableSpan(printable);
  const rows = [];
  for (let c = 0; c < Ws; c++) {
    const cc = flip ? (Ws - 1 - c) : c;               // FLIP_LEFT_RIGHT = mirror the reading axis
    const line = new Uint8Array(BYTES_PER_LINE);
    for (let r = 0; r < printable; r++) {
      if (dark(r, cc)) {
        const x = x0 + (printable - 1 - r);           // rotate(-90) into the centred head
        if (x >= 0 && x < RASTER_WIDTH) line[x >> 3] |= (0x80 >> (x & 7));
      }
    }
    rows.push(line);
  }
  return rows;
}

/* ---- optional cut lines: solid line across the printable width at each end, + margins ---- */
function blankRows(n) { const a = []; for (let i = 0; i < n; i++) a.push(new Uint8Array(BYTES_PER_LINE)); return a; }
function solidRows(n, printable) {
  const x0 = printableSpan(printable), a = [];
  for (let i = 0; i < n; i++) {
    const l = new Uint8Array(BYTES_PER_LINE);
    for (let x = x0; x < x0 + printable; x++) l[x >> 3] |= (0x80 >> (x & 7));
    a.push(l);
  }
  return a;
}
function assemble(contentRows, printable, cut) {
  if (!cut) return { rows: contentRows, contentLen: contentRows.length, total: contentRows.length, cut: false };
  const G = CUT_GAP_DOTS, L = CUT_LINE_DOTS;
  const rows = [].concat(
    blankRows(G), solidRows(L, printable), blankRows(G),
    contentRows,
    blankRows(G), solidRows(L, printable), blankRows(G),
  );
  return { rows, contentLen: contentRows.length, total: rows.length, cut: true, G, L };
}

function buildJob(rows, tapeMm, mediaType, saveTape) {
  const n = rows.length, out = [];
  const push = (...b) => out.push(...b);
  push(0x1B, 0x40);                                    // init
  push(0x1B, 0x69, 0x61, 0x01);                        // raster mode
  push(0x1B, 0x69, 0x7A, 0xC4, mediaType & 0xFF, tapeMm & 0xFF, 0x00,   // print info
       n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF, 0x00, 0x00);
  push(0x1B, 0x69, 0x4B, 0x08);                        // no chain — P300BT requires a full eject
  push(0x1B, 0x69, 0x4D, 0x00);
  push(0x1B, 0x69, 0x64, 0x1C, 0x00);
  push(0x4D, 0x00);                                    // compression off
  for (const r of rows) { push(0x47, BYTES_PER_LINE, 0x00); for (const b of r) push(b); }
  push(0x1A);                                          // SUB = print + eject (0C/no-feed reds the P300BT)
  return new Uint8Array(out);
}

/* Reading view with a tape-width ruler (mm) and (optional) cut-line marks. Upright, never
   mirrored — the flip/rotate the raster needs are applied only on the print path. */
function drawPreview(content, tapeMm, printable, asm) {
  const PXMM = 10;
  const d2p = (d) => d / DPMM * PXMM;                  // printer dots -> display px
  const tapeWpx = Math.round(tapeMm * PXMM);
  const printablePx = Math.round(printable / DPMM * PXMM);
  const Ws = asm.contentLen;
  const lengthPx = Math.max(1, Math.round(d2p(asm.total)));
  const gutter = 42, padT = 10, padB = 20, padR = 12;

  const cv = $("preview");
  cv.width = gutter + lengthPx + padR;
  cv.height = padT + tapeWpx + padB;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);

  const bx = gutter, by = padT, cbTop = by + (tapeWpx - printablePx) / 2;
  ctx.fillStyle = "#fff"; ctx.fillRect(bx, by, lengthPx, tapeWpx);        // tape band
  ctx.strokeStyle = "#bbb"; ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, lengthPx, tapeWpx);

  const contentX = bx + Math.round(d2p(asm.cut ? asm.G + asm.L + asm.G : 0));
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(content, contentX, cbTop, Math.max(1, Math.round(d2p(Ws))), printablePx);

  if (asm.cut) {                                        // cut-line marks at both ends
    ctx.fillStyle = "#000";
    const lw = Math.max(1, Math.round(d2p(asm.L)));
    ctx.fillRect(bx + Math.round(d2p(asm.G)), cbTop, lw, printablePx);
    ctx.fillRect(bx + Math.round(d2p(asm.G + asm.L + asm.G + Ws + asm.G)), cbTop, lw, printablePx);
  }

  // vertical ruler = tape width in mm
  ctx.strokeStyle = "#888"; ctx.fillStyle = "#888";
  ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "right";
  const axisX = gutter - 6;
  ctx.beginPath(); ctx.moveTo(axisX + 0.5, by); ctx.lineTo(axisX + 0.5, by + tapeWpx); ctx.stroke();
  for (let mm = 0; mm <= tapeMm; mm++) {
    const y = by + mm * PXMM, major = mm % 5 === 0 || mm === tapeMm;
    ctx.beginPath();
    ctx.moveTo(axisX - (major ? 6 : 3) + 0.5, y + 0.5); ctx.lineTo(axisX + 0.5, y + 0.5); ctx.stroke();
    if (major) ctx.fillText(String(mm), axisX - 9, y);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText(`${tapeMm} mm wide · ≈ ${Math.round(asm.total / DPMM)} mm long`, bx, by + tapeWpx + 14);
}

function currentParams() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const tapeSel = $("tape").value;
  const media = $("media").value;
  const flip = media === "laminated" ? "on" : media === "heatshrink" ? "off" : "auto";
  const mediaType = media === "heatshrink" ? 0x11 : 0x01;
  const tape = tapeSel === "auto" ? (detectedTape || 12) : parseInt(tapeSel, 10);
  return { mode, tape, flip, mediaType };
}

function compose() {
  const { mode, tape, flip, mediaType } = currentParams();
  const printable = printableDots(tape);
  const doFlip = resolveFlip(flip, mediaType);
  const text = $("data").value || " ";
  const content = mode === "qr" ? renderQR(text) : renderText(text);
  const asm = assemble(buildRows(content, printable, doFlip), printable, $("cutlines").checked);
  drawPreview(content, tape, printable, asm);
  return { rows: asm.rows, tape, mediaType, doFlip };
}

/* ---- WebSerial ---- */
async function connect() {
  if (!("serial" in navigator)) { log("WebSerial unsupported — use Chrome/Edge over https or localhost."); return; }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    log("connected.");
    $("printBtn").disabled = false; $("detectBtn").disabled = false;
    port.addEventListener("disconnect", () => {
      port = null;
      $("printBtn").disabled = true; $("detectBtn").disabled = true;
      log("printer disconnected — reconnect to print again.");
    });
    await new Promise((r) => setTimeout(r, 400));      // let the SPP link settle
    await detectTape();                                // proactive detect on connect
  } catch (e) { log("connect failed: " + e.message); }
}

async function writeBytes(bytes) {
  if (!port || !port.writable) throw new Error("printer port is not open — reconnect");
  const writer = port.writable.getWriter();
  try {
    const CHUNK = 512;                                 // pace delivery like the CLI — BT SPP starves on one big write
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await writer.write(bytes.slice(i, i + CHUNK));
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));      // let the tail flush before releasing the lock
  } finally { writer.releaseLock(); }
}

async function detectTape() {
  if (!port || !port.readable || !port.writable) { log("connect first (port not open)."); return; }
  try {
    await writeBytes(new Uint8Array([0x1B, 0x40, 0x1B, 0x69, 0x53]));   // ESC @  ESC i S
    const reader = port.readable.getReader();
    const chunks = []; let total = 0;
    const timeout = new Promise((res) => setTimeout(() => res("t"), 1200));
    try {
      while (total < 32) {
        const r = await Promise.race([reader.read(), timeout]);
        if (r === "t" || r.done) break;
        chunks.push(r.value); total += r.value.length;
      }
    } finally { try { await reader.cancel(); } catch (e) {} reader.releaseLock(); }
    const data = new Uint8Array(total); let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
    if (data.length >= 12 && data[0] === 0x80) {
      const width = data[10], type = data[11], hs = HEAT_SHRINK_TYPES.has(type);
      detectedTape = width;
      if (KNOWN_PRINTABLE[width]) $("tape").value = String(width);
      $("media").value = hs ? "heatshrink" : "auto";
      log(`detected tape=${width}mm type=0x${type.toString(16)}${hs ? " (heat-shrink)" : ""}`);
    } else {
      log("no status response (printer off/asleep, or model lacks ESC i S). Pick tape manually.");
    }
  } catch (e) { log("detect failed: " + e.message); }
  try { compose(); } catch (e) { /* QR offline etc. */ }
}

async function printLabel() {
  if (!port) { log("connect first."); return; }
  try {
    const { rows, tape, mediaType, doFlip } = compose();
    const job = buildJob(rows, tape, mediaType);
    log(`printing tape=${tape}mm flip=${doFlip ? "on" : "off"} ${rows.length} lines, ${job.length} bytes...`);
    await writeBytes(job);
    log("done. (red blink = tape-width mismatch: fix tape, power-cycle, retry)");
  } catch (e) { log("print failed: " + e.message); }
}

window.addEventListener("DOMContentLoaded", () => {
  const refresh = () => { try { compose(); } catch (e) { /* QR offline etc. */ } };
  $("connectBtn").addEventListener("click", connect);
  $("detectBtn").addEventListener("click", detectTape);
  $("printBtn").addEventListener("click", printLabel);
  $("data").addEventListener("input", refresh);
  $("cutlines").addEventListener("change", refresh);
  // switching width/media to "auto" re-detects (if connected); otherwise just re-render
  ["tape", "media"].forEach((id) => $(id).addEventListener("change", () => {
    if ($(id).value === "auto" && port) { detectTape(); } else { refresh(); }
  }));
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", refresh));
  if (!("serial" in navigator)) log("WebSerial not available. Use Chrome/Edge over https or localhost.");
  if (typeof qrcode === "undefined") {
    const qrRadio = document.querySelector('input[name="mode"][value="qr"]');
    if (qrRadio) qrRadio.disabled = true;
    log("QR library did not load (offline?) — QR disabled; text labels still work.");
  }
  refresh();
});
