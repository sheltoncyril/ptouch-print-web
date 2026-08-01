/* ptouch-print WebSerial UI.
   Renders labels in-browser and streams Brother ESC/P raster to a PT-P300BT over a
   Bluetooth SPP serial port. Mirrors server/ptouch/raster.py — keep the two in sync. */
"use strict";

const RASTER_WIDTH = 128;
const BYTES_PER_LINE = 16;
const HEAT_SHRINK_TYPES = new Set([0x11, 0x17]);
const KNOWN_PRINTABLE = { 6: 32, 9: 50, 12: 70, 18: 112, 24: 128 };

let port = null;
let detectedTape = null;

const $ = (id) => document.getElementById(id);
function log(msg) { const el = $("log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; }

function printableDots(mm) {
  return KNOWN_PRINTABLE[mm] || Math.max(8, Math.min(RASTER_WIDTH, Math.round(mm * 180 / 25.4 * 0.80)));
}
function resolveFlip(flip, mediaType) {
  if (flip === "on") return true;
  if (flip === "off") return false;
  return !HEAT_SHRINK_TYPES.has(mediaType);            // auto: laminated flips, heat-shrink doesn't
}

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
  const x0 = Math.floor((RASTER_WIDTH - printable) / 2);
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

function buildJob(rows, tapeMm, mediaType) {
  const n = rows.length, out = [];
  const push = (...b) => out.push(...b);
  push(0x1B, 0x40);                                    // init
  push(0x1B, 0x69, 0x61, 0x01);                        // raster mode
  push(0x1B, 0x69, 0x7A, 0xC4, mediaType & 0xFF, tapeMm & 0xFF, 0x00,   // print info
       n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF, 0x00, 0x00);
  push(0x1B, 0x69, 0x4B, 0x08);
  push(0x1B, 0x69, 0x4D, 0x00);
  push(0x1B, 0x69, 0x64, 0x1C, 0x00);
  push(0x4D, 0x00);                                    // compression off
  for (const r of rows) { push(0x47, BYTES_PER_LINE, 0x00); for (const b of r) push(b); }
  push(0x1A);                                          // print + feed
  return new Uint8Array(out);
}

function drawPreview(rows) {
  const s = 3, cv = $("preview");
  cv.width = RASTER_WIDTH * s; cv.height = Math.max(1, rows.length) * s;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = "#000";
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < RASTER_WIDTH; x++)
      if (rows[y][x >> 3] & (0x80 >> (x & 7))) ctx.fillRect(x * s, y * s, s, s);
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
  const rows = buildRows(content, printable, doFlip);
  drawPreview(rows);
  return { rows, tape, mediaType, doFlip };
}

/* ---- WebSerial ---- */
async function connect() {
  if (!("serial" in navigator)) { log("WebSerial unsupported — use Chrome/Edge over https or localhost."); return; }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    log("connected.");
    $("printBtn").disabled = false; $("detectBtn").disabled = false;
  } catch (e) { log("connect failed: " + e.message); }
}

async function writeBytes(bytes) {
  const writer = port.writable.getWriter();
  try { await writer.write(bytes); } finally { writer.releaseLock(); }
}

async function detectTape() {
  if (!port) { log("connect first."); return; }
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
      compose();
    } else {
      log("no status response (printer off/asleep, or model lacks ESC i S). Pick tape manually.");
    }
  } catch (e) { log("detect failed: " + e.message); }
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
  $("connectBtn").addEventListener("click", connect);
  $("detectBtn").addEventListener("click", detectTape);
  $("printBtn").addEventListener("click", printLabel);
  const refresh = () => { try { compose(); } catch (e) { /* QR offline etc. */ } };
  ["data", "tape", "media"].forEach((id) => $(id).addEventListener("input", refresh));
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", refresh));
  if (!("serial" in navigator)) log("WebSerial not available. Use Chrome/Edge over https or localhost.");
  refresh();
});
