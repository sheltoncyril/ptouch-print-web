/* ptouch-print WebSerial UI.
   Renders labels in-browser and streams Brother ESC/P raster to a PT-P300BT over a
   Bluetooth SPP serial port. Mirrors server/ptouch/raster.py — keep the two in sync. */
"use strict";

const RASTER_WIDTH = 128;
const BYTES_PER_LINE = 16;
const HEAT_SHRINK_TYPES = new Set([0x11, 0x17]);      // tube -> read from outside, do NOT mirror
const MEDIA_NAMES = { 0x01: "laminated", 0x03: "non-laminated", 0x11: "heat-shrink 2:1", 0x17: "heat-shrink 3:1" };
const KNOWN_PRINTABLE = { 6: 32, 9: 50, 12: 64, 18: 64, 24: 64 };   // P300BT caps print at ~9mm (64 dots)
const DPMM = 180 / 25.4;                               // printer dots per millimetre
const CUT_GAP_DOTS = 12;                               // blank margin either side of a cut line (~1.7mm)
const CUT_LINE_DOTS = 1;                               // cut-line thickness along the tape (~0.14mm) — thin
const CUT_DASH = 2;                                    // dotted line: dot pitch across the width

// "Logo + QR": the logo is supplied by the person using the page (file picker) and kept only in THIS
// browser's localStorage — no logo or brand asset ships with this app.
const LOGO_KEY = "ptouch.logo", LOGO_NAME_KEY = "ptouch.logoName", LOGO_URL_KEY = "ptouch.logoUrl";
const LEAN_DEG = 22;                                   // forward lean of the "Lean" option; keep equal to raster.LEAN_DEG
const LOGO_MAX_H = 256;                                // stored/working logo height (4x the 64-dot print band)
const LOGO_MAX_SRC = 2048;                             // longest source side we ever read pixels from (big photos are scaled first)
const QR_MIN_MODULE_DOTS = 2;                          // below this thermal bleed makes a QR unscannable
const QR_ALNUM = /^[0-9A-Z $%*+\-./:]+$/;
const URL_HOST = /^(https?):\/\/([A-Za-z0-9.-]+(?::\d+)?)(?=[/?#]|$)/i;
let logoCanvas = null;                                 // the user's logo: ink-trimmed, <= LOGO_MAX_H tall
let logoName = "";
let logoGen = 0;                                       // bumped on every pick/removal so a slower earlier load can't overwrite it

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
function renderText(text, family = "Arial, sans-serif", weight = "bold", boxPx = 64, slant = false) {
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
  const tan = slant ? Math.tan(LEAN_DEG * Math.PI / 180) : 0;   // lean about the baseline: tops move right
  const w = Math.max(1, Math.ceil(left + right + tan * (asc + desc))) + padX * 2;
  const h = Math.max(1, Math.ceil(asc + desc)) + padY * 2;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000"; ctx.font = fontStr; ctx.textBaseline = "alphabetic";
  ctx.translate(padX + left + tan * desc, padY + asc);          // descenders lean left, so start tan*desc in
  ctx.transform(1, 0, -tan, 1, 0, 0);
  ctx.fillText(text, 0, 0);
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

/* ---- Logo + QR: [ pad | logo | gap | QR | pad ], exactly h dots tall. Mirrors raster.render_logo_qr.
   QR modules are whole dots (fractional scaling is what makes 1-bit thermal QR codes unreadable). ---- */
function qrPayload(data) {                             // upper-case scheme+host so the QR can use alphanumeric mode
  const m = URL_HOST.exec(data);                       // (both are case-insensitive; the path is left as typed)
  return m ? m[1].toUpperCase() + "://" + m[2].toUpperCase() + data.slice(m[0].length) : data;
}
function qrModules(data) {
  if (typeof qrcode === "undefined") throw new Error("QR library not loaded (offline?)");
  const qr = qrcode(0, "M");
  qr.addData(data, QR_ALNUM.test(data) ? "Alphanumeric" : "Byte");
  qr.make();
  return { n: qr.getModuleCount(), dark: (r, c) => qr.isDark(r, c) };
}
/* Flatten an uploaded image onto white, trim to its ink, and (step-wise) downscale to <= LOGO_MAX_H.
   Mirrors raster.load_logo's trim; accepts PNG/JPG/SVG with or without transparency. */
function prepLogo(img) {
  const nw = img.naturalWidth || 1024, nh = img.naturalHeight || 1024;
  const k = Math.min(1, LOGO_MAX_SRC / Math.max(nw, nh));        // bound the work BEFORE allocating / reading pixels
  const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 231) {      // anything not near-white is ink
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error("that image has no dark pixels to print");
  let cur = document.createElement("canvas"); cur.width = x1 - x0 + 1; cur.height = y1 - y0 + 1;
  cur.getContext("2d").drawImage(c, x0, y0, cur.width, cur.height, 0, 0, cur.width, cur.height);
  while (cur.height > LOGO_MAX_H) {                      // halve repeatedly: a single big jump aliases thin strokes
    const nh = Math.max(LOGO_MAX_H, Math.ceil(cur.height / 2));
    const nw = Math.max(1, Math.round(cur.width * nh / cur.height));
    const n = document.createElement("canvas"); n.width = nw; n.height = nh;
    const g = n.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, nw, nh);
    cur = n;
  }
  return cur;
}
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("couldn't read that image"));
    im.src = src;
  });
}

function renderLogoQR(logoImg, url, h) {
  let grid = null, m = 0;
  if (url) {
    grid = qrModules(qrPayload(url));
    m = Math.floor(h / grid.n);
    if (m < QR_MIN_MODULE_DOTS)
      throw new Error(`QR is ${grid.n} modules wide but the band is only ${h} dots (< ${QR_MIN_MODULE_DOTS} dots/module): use wider tape (>= 9 mm) or a shorter URL`);
  }
  const mw = logoImg ? Math.max(1, Math.round(logoImg.width * h / logoImg.height)) : 0;
  const pad = m ? 4 * m : 8;                           // >= 4 modules of quiet zone at each end
  const gap = (mw && m) ? 6 * m : 0;
  const qw = grid ? grid.n * m : 0;
  const c = document.createElement("canvas"); c.width = pad + mw + gap + qw + pad; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, h);
  let x = pad;
  if (logoImg) {
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(logoImg, x, 0, mw, h);
    x += mw + gap;
  }
  if (grid) {
    ctx.fillStyle = "#000";
    const y0 = Math.floor((h - qw) / 2);
    for (let r = 0; r < grid.n; r++)
      for (let col = 0; col < grid.n; col++)
        if (grid.dark(r, col)) ctx.fillRect(x + col * m, y0 + r * m, m, m);
  }
  const id = ctx.getImageData(0, 0, c.width, c.height), d = id.data;   // 1-bit, as the printer will see it
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3 < 128 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return { canvas: c, qrModules: grid ? grid.n : 0, moduleDots: m };
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
  // The Media mode only decides MIRRORING. The media-type byte in the print info always describes the
  // loaded cartridge (the detected type), exactly as Auto sends it — a manual pick used to force
  // 0x01/0x11 there, so it printed a different job than Auto for the very same tape.
  const flip = media === "laminated" ? "on" : media === "heatshrink" ? "off" : "auto";
  const mediaType = detectedType || (media === "heatshrink" ? 0x11 : 0x01);
  const tape = tapeSel === "auto" ? (detectedTape || 12) : parseInt(tapeSel, 10);
  const saveTape = $("nofeed").checked;                // 0C terminator: print + hold (no auto-feed)
  const font = $("font").value;
  const weight = $("bold").checked ? "bold" : "normal";
  const scale = parseFloat($("size").value) || 1;
  const align = $("valign").value;
  const slant = $("slant").checked;
  return { mode, tape, flip, mediaType, saveTape, font, weight, scale, align, slant };
}

// Canvas draws with a webfont only once it has loaded (until then it silently uses a fallback), so make
// sure the selected face is ready before previewing/printing; 'loadingdone' re-renders when it lands.
function ensureFont() {
  if (!document.fonts) return Promise.resolve();
  const { font, weight } = currentParams();
  return document.fonts.load(`${weight} 40px ${font}`, $("data").value || "A").catch(() => []);
}

function compose() {
  const { mode, tape, flip, mediaType, saveTape, font, weight, scale, align, slant } = currentParams();
  const printable = printableDots(tape);
  const doFlip = resolveFlip(flip, mediaType);
  const text = $("data").value || " ";
  const boxPx = Math.max(8, Math.round(printable * scale));      // target content height in dots
  let raw, info = "";
  if (mode === "logo") {
    const url = $("logoUrl").value.trim();
    if (!logoCanvas && !url) throw new Error("choose a logo image and/or enter a URL");
    const r = renderLogoQR(logoCanvas, url, boxPx);
    raw = r.canvas;
    info = [logoCanvas ? `logo: ${logoName || "saved logo"}` : "no logo chosen (QR only)",
            r.qrModules ? `QR ${r.qrModules}×${r.qrModules} modules at ${r.moduleDots} dots each (${(r.moduleDots * 25.4 / 180).toFixed(2)} mm)`
                        : "no QR"].join(" · ");
  } else {
    raw = mode === "qr" ? resizeNearest(renderQR(text), boxPx) : renderText(text, font, weight, boxPx, slant);
  }
  const content = placeInBand(raw, printable, align);            // vertical align (no scaling)
  const asm = assemble(buildRows(content, printable, doFlip), printable, $("cutlines").checked, doFlip);
  drawPreview(content, tape, printable, asm);
  $("logoInfo").textContent = info;
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
    log(`detected tape=${width}mm type=0x${type.toString(16)} (${MEDIA_NAMES[type] || "unknown media"}) — mirror ${hs ? "OFF" : "ON"}`);
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
    await ensureFont();                                // never print with a not-yet-loaded webfont's fallback
    const { rows, tape, mediaType, doFlip, saveTape } = compose();
    const job = buildJob(rows, tape, mediaType, saveTape);
    log(`printing tape=${tape}mm type=0x${mediaType.toString(16)} flip=${doFlip ? "on" : "off"} ${rows.length} lines, ${job.length} bytes${saveTape ? " (no auto-feed)" : ""}...`);
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
  const curMode = () => document.querySelector('input[name="mode"]:checked').value;
  const syncMode = () => {                              // show only the controls the current mode uses
    const m = curMode();
    $("data").hidden = m === "logo";
    $("fontRow").hidden = m !== "text";
    $("logoOpts").hidden = m !== "logo";
  };
  const refresh = () => {
    try { compose(); }
    catch (e) {                                         // QR offline etc.; in logo mode say WHY (e.g. QR too dense)
      if (curMode() === "logo") {
        $("logoInfo").textContent = e.message;
        const cv = $("preview"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);   // don't leave a stale label
      }
    }
  };
  $("connectBtn").addEventListener("click", connect);
  $("disconnectBtn").addEventListener("click", disconnect);
  $("detectBtn").addEventListener("click", detectTape);
  $("printBtn").addEventListener("click", printLabel);
  $("feedBtn").addEventListener("click", feedOut);
  $("data").addEventListener("input", refresh);
  $("cutlines").addEventListener("change", refresh);
  const fontChanged = () => { refresh(); ensureFont().then(refresh); };   // draw now, redraw once the face loads
  $("font").addEventListener("change", fontChanged);
  $("bold").addEventListener("change", fontChanged);
  $("slant").addEventListener("change", refresh);
  if (document.fonts) document.fonts.addEventListener("loadingdone", refresh);
  $("size").addEventListener("change", refresh);
  $("valign").addEventListener("change", refresh);
  // switching width/media to "auto" re-detects (if connected); otherwise just re-render
  ["tape", "media"].forEach((id) => $(id).addEventListener("change", () => {
    if ($(id).value === "auto" && port) { detectTape(); } else { refresh(); }
  }));
  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", () => { syncMode(); refresh(); }));
  // Logo + QR: logo + URL are the user's own and live only in this browser (localStorage).
  const store = (k, v) => {                             // true when the write/removal actually happened
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; }
    catch (e) { return false; }                         // private mode / quota
  };
  const fetchStored = (k) => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const setLogo = (canvas, name) => {
    logoCanvas = canvas; logoName = canvas ? name : "";
    $("logoClear").hidden = !canvas;
    refresh();
  };
  $("logoFile").addEventListener("change", async () => {
    const f = $("logoFile").files[0];
    if (!f) return;
    const gen = ++logoGen;                              // supersedes any pending restore or earlier pick
    const u = URL.createObjectURL(f);
    try {
      const c = prepLogo(await loadImage(u));
      if (gen !== logoGen) return;                      // a newer pick/removal happened while this one decoded
      if (store(LOGO_KEY, c.toDataURL("image/png"))) {
        store(LOGO_NAME_KEY, f.name);
      } else {                                          // don't leave an OLD stored image under the new file's name
        store(LOGO_KEY, null); store(LOGO_NAME_KEY, null);
        log("logo not saved (browser storage is full or unavailable) — it's used for this session only.");
      }
      setLogo(c, f.name);
    } catch (e) { log("logo not loaded: " + e.message); }
    finally { URL.revokeObjectURL(u); $("logoFile").value = ""; }
  });
  $("logoClear").addEventListener("click", () => { logoGen++; store(LOGO_KEY, null); store(LOGO_NAME_KEY, null); setLogo(null); });
  $("logoUrl").addEventListener("input", () => { store(LOGO_URL_KEY, $("logoUrl").value); refresh(); });
  $("logoUrl").value = fetchStored(LOGO_URL_KEY);
  const savedLogo = fetchStored(LOGO_KEY);
  if (savedLogo) {
    const gen = logoGen;                                // a pick/removal made before this resolves wins
    loadImage(savedLogo).then((im) => { if (gen === logoGen) setLogo(prepLogo(im), fetchStored(LOGO_NAME_KEY)); })
      .catch(() => { if (gen === logoGen) { store(LOGO_KEY, null); store(LOGO_NAME_KEY, null); } });
  }
  if (!("serial" in navigator)) log("WebSerial not available. Use Chrome/Edge over https or localhost.");
  if (typeof qrcode === "undefined") {
    const qrRadio = document.querySelector('input[name="mode"][value="qr"]');
    if (qrRadio) qrRadio.disabled = true;
    log("QR library did not load (offline?) — QR disabled; text labels still work.");
  }
  syncMode();
  refresh();
});
