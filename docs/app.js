/* ptouch-print WebSerial UI.
   Renders labels in-browser and streams Brother ESC/P raster to a PT-P300BT over a
   Bluetooth SPP serial port. Mirrors server/ptouch/raster.py — keep the two in sync. */
"use strict";

const RASTER_WIDTH = 128;
const BYTES_PER_LINE = 16;
const HEAT_SHRINK_TYPES = new Set([0x11, 0x17]);      // tube -> read from outside, do NOT mirror
const KNOWN_PRINTABLE = { 6: 32, 9: 50, 12: 64, 18: 64, 24: 64 };   // P300BT caps print at ~9mm (64 dots)
const DPMM = 180 / 25.4;                               // printer dots per millimetre
const CUT_GAP_DOTS = 12;                               // blank margin either side of a cut line (~1.7mm)
const CUT_LINE_DOTS = 1;                               // cut-line thickness along the tape (~0.14mm) — thin
const CUT_DASH = 2;                                    // dotted line: dot pitch across the width

let port = null;
let detectedTape = null;
let detectedType = null;                              // last-detected media type byte (for auto mirror)
let busy = false;                                     // guard: one serial op at a time (detect/print/feed) — no overlap

const $ = (id) => document.getElementById(id);
function log(msg) { const el = $("log"); el.textContent += msg + "\n"; el.scrollTop = el.scrollHeight; }

function printableDots(mm) {
  return KNOWN_PRINTABLE[mm] || Math.max(8, Math.min(RASTER_WIDTH, Math.round(mm * DPMM * 0.80)));
}
function resolveFlip(flip, mediaType) {
  if (flip === "on") return true;
  if (flip === "off") return false;
  return !HEAT_SHRINK_TYPES.has(mediaType);            // auto: mirror unless heat-shrink tube (verified)
}
function printableSpan(printable) { return Math.floor((RASTER_WIDTH - printable) / 2); }   // x0

/* ---- render content to a tight black-on-white canvas ---- */
// Render text AT its final dot height (boxPx tall incl. margin) so it stays crisp — no big
// render then downscale (which + 1-bit = mush). Font size is chosen to hit the glyph height.
function renderText(text, family = "Arial, sans-serif", weight = "bold", boxPx = 64) {
  const padX = 4, padY = 6;                            // margin so anti-aliased glyph edges aren't clipped
  const glyphPx = Math.max(6, boxPx - padY * 2);
  const ref = 256;                                     // measure at a big ref, then scale the font size
  const rctx = document.createElement("canvas").getContext("2d");
  rctx.font = `${weight} ${ref}px ${family}`;
  const rm = rctx.measureText(text);
  const gH = (rm.actualBoundingBoxAscent + rm.actualBoundingBoxDescent) || ref;
  const F = Math.max(6, Math.round(ref * glyphPx / gH));
  const fontStr = `${weight} ${F}px ${family}`;
  const meas = document.createElement("canvas").getContext("2d");
  meas.font = fontStr;
  const m = meas.measureText(text);
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const w = Math.max(1, Math.ceil(left + right)) + padX * 2;
  const h = Math.max(1, Math.ceil(asc + desc)) + padY * 2;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000"; ctx.font = fontStr; ctx.textBaseline = "alphabetic";
  ctx.fillText(text, padX + left, padY + asc);
  return c;
}

function resizeNearest(img, targetH) {                 // crisp block-scale (QR modules stay sharp)
  const w = Math.max(1, Math.round(img.width * targetH / img.height));
  const c = document.createElement("canvas"); c.width = w; c.height = targetH;
  const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, targetH);
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

/* ---- align content across the tape width (no scaling). Returns a printable-tall canvas
   so the existing rotate/pack pipeline below is untouched. ---- */
function placeInBand(content, printable, align) {
  if (content.height >= printable) return content;     // already fills the band
  const c = document.createElement("canvas"); c.width = content.width; c.height = printable;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, content.width, printable);
  const y = align === "top" ? 0 : align === "bottom" ? (printable - content.height)
                                                      : Math.round((printable - content.height) / 2);
  ctx.drawImage(content, 0, y);                        // no scaling — content already sized
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
function cutRows(n, printable) {                       // thin DOTTED cut-guide across the width
  const x0 = printableSpan(printable), a = [];
  for (let i = 0; i < n; i++) {
    const l = new Uint8Array(BYTES_PER_LINE);
    for (let j = 0; j < printable; j++) if (j % CUT_DASH === 0) { const x = x0 + j; l[x >> 3] |= (0x80 >> (x & 7)); }
    a.push(l);
  }
  return a;
}
function assemble(contentRows, printable, cut, flip) {
  if (!cut) return { rows: contentRows, contentLen: contentRows.length, total: contentRows.length, cut: false };
  // ONE cut line at the reading-LEFT — in a strip it doubles as the previous label's boundary,
  // so labels butt tightly (|1|1). The mirror (flip) reverses the raster length axis, so prepend
  // when flip is OFF and append when ON to keep the line on the LEFT of the reading view.
  const G = CUT_GAP_DOTS, L = CUT_LINE_DOTS;
  const mark = [].concat(blankRows(G), cutRows(L, printable), blankRows(G));
  const rows = flip ? [].concat(contentRows, mark) : [].concat(mark, contentRows);
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
  push(0x1B, 0x69, 0x64, 0x00, 0x00);                  // feed margin = 0 (tight butting; was 28)
  push(0x4D, 0x00);                                    // compression off
  for (const r of rows) { push(0x47, BYTES_PER_LINE, 0x00); for (const b of r) push(b); }
  push(saveTape ? 0x0C : 0x1A);                        // 0C = print + HOLD (no auto-feed); 1A = print + eject
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

  if (asm.cut) {                                        // single DOTTED cut mark at the LEFT
    ctx.fillStyle = "#000";
    const lw = Math.max(1, Math.round(d2p(asm.L)));
    const mx = bx + Math.round(d2p(asm.G));
    const step = Math.max(2, Math.round(d2p(CUT_DASH)));
    for (let y = 0; y < printablePx; y += step) ctx.fillRect(mx, cbTop + y, lw, Math.max(1, lw));
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
  let flip, mediaType;
  if (media === "laminated") { flip = "on"; mediaType = 0x01; }
  else if (media === "heatshrink") { flip = "off"; mediaType = 0x11; }
  else { flip = "auto"; mediaType = detectedType || 0x01; }   // auto: mirror off the DETECTED type
  const tape = tapeSel === "auto" ? (detectedTape || 12) : parseInt(tapeSel, 10);
  const saveTape = $("nofeed").checked;                // 0C terminator: print + hold (no auto-feed)
  const font = $("font").value;
  const weight = $("bold").checked ? "bold" : "normal";
  const scale = parseFloat($("size").value) || 1;
  const align = $("valign").value;
  return { mode, tape, flip, mediaType, saveTape, font, weight, scale, align };
}

function compose() {
  const { mode, tape, flip, mediaType, saveTape, font, weight, scale, align } = currentParams();
  const printable = printableDots(tape);
  const doFlip = resolveFlip(flip, mediaType);
  const text = $("data").value || " ";
  const boxPx = Math.max(8, Math.round(printable * scale));      // target content height in dots
  const raw = mode === "qr" ? resizeNearest(renderQR(text), boxPx) : renderText(text, font, weight, boxPx);
  const content = placeInBand(raw, printable, align);            // vertical align (no scaling)
  const asm = assemble(buildRows(content, printable, doFlip), printable, $("cutlines").checked, doFlip);
  drawPreview(content, tape, printable, asm);
  return { rows: asm.rows, tape, mediaType, doFlip, saveTape };
}

/* ---- WebSerial ---- */
async function connect() {
  if (!("serial" in navigator)) { log("WebSerial unsupported — use Chrome/Edge over https or localhost."); return; }
  try {
    port = await navigator.serial.requestPort();
    let opened = false, lastErr;
    for (let i = 0; i < 4 && !opened; i++) {           // BT SPP port is often busy for a moment after pairing/wake
      try { await port.open({ baudRate: 9600 }); opened = true; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 700)); }
    }
    if (!opened) throw lastErr;
    log("connected.");
    $("printBtn").disabled = false; $("detectBtn").disabled = false; $("feedBtn").disabled = false;
    $("connectBtn").disabled = true; $("disconnectBtn").disabled = false;
    port.addEventListener("disconnect", () => {
      port = null;
      $("printBtn").disabled = true; $("detectBtn").disabled = true; $("feedBtn").disabled = true;
      $("connectBtn").disabled = false; $("disconnectBtn").disabled = true;
      log("printer disconnected — reconnect to print again.");
    });
    await new Promise((r) => setTimeout(r, 900));      // let the SPP link settle before the first status read
    await detectTape();                                // proactive detect on connect
  } catch (e) { log("connect failed: " + e.message); }
}

async function disconnect() {
  if (!port) return;
  const p = port; port = null;                         // stop new ops, then close (releases the COM port)
  busy = false;
  try { await p.close(); } catch (e) { /* a read/write may be briefly locked mid-op — ignore */ }
  $("printBtn").disabled = true; $("detectBtn").disabled = true; $("feedBtn").disabled = true;
  $("connectBtn").disabled = false; $("disconnectBtn").disabled = true;
  log("disconnected.");
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

async function readStatusOnce(settleMs) {
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  const reader = port.readable.getReader();            // attach the reader BEFORE querying, or the reply is lost
  try {
    const writer = port.writable.getWriter();          // ESC i S = live status (no ESC @ reset transient)
    try { await writer.write(new Uint8Array([0x1B, 0x69, 0x53])); } finally { writer.releaseLock(); }
    const chunks = []; let total = 0;
    const timeout = new Promise((res) => setTimeout(() => res("t"), 2000));
    while (total < 32) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r === "t" || r.done) break;
      chunks.push(r.value); total += r.value.length;
    }
    const data = new Uint8Array(total); let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
    return data;
  } finally { try { await reader.cancel(); } catch (e) {} reader.releaseLock(); }
}

async function detectTape() {
  if (!port || !port.readable || !port.writable) { log("connect first (port not open)."); return; }
  if (busy) return;                                     // never overlap — concurrent ops lock the streams
  busy = true;
  let data = null;                                      // last valid 0x80 status frame (width 0 = no tape)
  for (let i = 0; i < 3; i++) {                         // retry: BT read can be slow to wake; keep the freshest read
    try {
      const d = await readStatusOnce(i ? 250 : 0);      // a swap-stale first read gets overwritten by a later one
      if (d.length >= 12 && d[0] === 0x80) { data = d; if (d[10] > 0 && i >= 1) break; }
    } catch (e) { /* transient stream lock / read error — try again */ }
  }
  busy = false;
  if (data && data[10] > 0) {                           // real tape
    const width = data[10], type = data[11], hs = HEAT_SHRINK_TYPES.has(type);
    detectedTape = width; detectedType = type;
    if (KNOWN_PRINTABLE[width]) $("tape").value = String(width);
    $("media").value = hs ? "heatshrink" : "auto";
    log(`detected tape=${width}mm type=0x${type.toString(16)} — ${!hs ? "mirrored" : "heat-shrink (no mirror)"}`);
  } else if (data) {                                    // printer answered but reports no cartridge
    log("no tape in the printer — insert a cartridge, or pick the width manually.");
  } else {                                              // nothing came back at all
    log("no status response (printer asleep, or the WebSerial read didn't return). Pick tape manually.");
  }
  try { compose(); } catch (e) { /* QR offline etc. */ }
}

async function printLabel() {
  if (!port) { log("connect first."); return; }
  if (busy) { log("printer busy — wait for the current job to finish."); return; }
  busy = true;
  try {
    const { rows, tape, mediaType, doFlip, saveTape } = compose();
    const job = buildJob(rows, tape, mediaType, saveTape);
    log(`printing tape=${tape}mm flip=${doFlip ? "on" : "off"} ${rows.length} lines, ${job.length} bytes${saveTape ? " (no auto-feed)" : ""}...`);
    await writeBytes(job);
    log(saveTape ? "done — label held inside; hit Feed / eject when finished." : "done.");
  } catch (e) { log("print failed: " + e.message); }
  finally { await new Promise((r) => setTimeout(r, 2000)); busy = false; }   // let it finish feeding before the next job
}

// Feed/eject: a tiny blank job ending in the 1A eject, to push out a label held inside by a
// no-feed batch so it can be torn off. Tape width doesn't matter for blank feed; use current.
async function feedOut() {
  if (!port) { log("connect first."); return; }
  if (busy) { log("printer busy — wait for the current job to finish."); return; }
  busy = true;
  try {
    const { tape, mediaType } = currentParams();
    log("feeding out...");
    await writeBytes(buildJob(blankRows(8), tape, mediaType));
    log("fed.");
  } catch (e) { log("feed failed: " + e.message); }
  finally { await new Promise((r) => setTimeout(r, 2000)); busy = false; }
}

window.addEventListener("DOMContentLoaded", () => {
  const refresh = () => { try { compose(); } catch (e) { /* QR offline etc. */ } };
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", disconnect);
  $("detectBtn").addEventListener("click", detectTape);
  $("printBtn").addEventListener("click", printLabel);
  $("feedBtn").addEventListener("click", feedOut);
  $("data").addEventListener("input", refresh);
  $("cutlines").addEventListener("change", refresh);
  $("font").addEventListener("change", refresh);
  $("bold").addEventListener("change", refresh);
  $("size").addEventListener("change", refresh);
  $("valign").addEventListener("change", refresh);
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
