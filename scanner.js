/* =========================================================================
   ULTRAFIT photo scanner — reads the barcodes off the roll boxes in the
   checkout photo, so the roll codes get submitted with the checkout.

   Usage (from a checkout page):

     const result = await UFScanner.scan(fileOrDataUrl, {
       onProgress: (msg) => { ... },   // status line updates
       prefix: 'W',                    // keep only codes starting with this
     });
     // result = { barcodes: [{ value, format }] }

   Each box carries more than one barcode; the one that matters is the
   bottom one, which starts with a known prefix (tint rolls: "W"). The
   prefix filter keeps just those. Codes are also ordered bottom-first
   whenever the decoder reports positions, as an extra safety net.

   Decoding: native BarcodeDetector when the browser has it (Chrome on
   Android — the shop phones), with the ZXing library as a fallback for
   everything else. ZXing loads lazily from a CDN only when needed.
   ========================================================================= */
(function () {
  "use strict";

  const CDN = {
    zxing: "https://cdn.jsdelivr.net/npm/@zxing/library@0.23.0/umd/index.min.js",
  };

  // ---- tiny script loader (cached) ----
  const loaded = {};
  function loadScript(url) {
    if (loaded[url]) return loaded[url];
    loaded[url] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + url));
      document.head.appendChild(s);
    });
    return loaded[url];
  }

  // ---- image helpers ----
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not read the photo"));
      img.src = src;
    });
  }

  // Draw the image onto a canvas, optionally rotated / cropped / scaled.
  // rot is 0, 90, 180 or 270 (degrees clockwise).
  function toCanvas(img, opts) {
    opts = opts || {};
    const rot = opts.rot || 0;
    const crop = opts.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const maxDim = opts.maxDim || 1600;

    const scale = Math.min(1, maxDim / Math.max(crop.w, crop.h));
    const w = Math.max(1, Math.round(crop.w * scale));
    const h = Math.max(1, Math.round(crop.h * scale));

    const canvas = document.createElement("canvas");
    if (rot === 90 || rot === 270) { canvas.width = h; canvas.height = w; }
    else { canvas.width = w; canvas.height = h; }

    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, -w / 2, -h / 2, w, h);
    ctx.restore();
    return canvas;
  }

  // ---- barcode decoding ----
  // Every found code carries y: its rough vertical position in the photo
  // (0 = top, 1 = bottom), when the decoder can tell. Used to sort
  // bottom-most first.
  async function detectNative(img) {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const detector = new window.BarcodeDetector();
      const found = await detector.detect(img);
      const H = img.naturalHeight || 1;
      return found.map((b) => ({
        value: b.rawValue,
        format: b.format,
        y: b.boundingBox ? (b.boundingBox.y + b.boundingBox.height / 2) / H : null,
      }));
    } catch (e) {
      return null; // fall through to ZXing
    }
  }

  function zxingDecodeCanvas(canvas) {
    const ZX = window.ZXing;
    const source = new ZX.HTMLCanvasElementLuminanceSource(canvas);
    const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(source));
    const hints = new Map();
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    const reader = new ZX.MultiFormatReader();
    reader.setHints(hints);
    try {
      const r = reader.decode(bitmap);
      return { value: r.getText(), format: String(r.getBarcodeFormat()) };
    } catch (e) {
      return null; // NotFoundException — no code in this view
    }
  }

  async function detectZXing(img, onProgress) {
    await loadScript(CDN.zxing);
    const found = [];
    const seen = new Set();
    const push = (r, y) => {
      if (r && !seen.has(r.value)) {
        seen.add(r.value);
        r.y = typeof y === "number" ? y : null;
        found.push(r);
      }
    };

    // Pass 1: whole image at each rotation (labels can face any way)
    for (const rot of [0, 90, 270, 180]) {
      push(zxingDecodeCanvas(toCanvas(img, { rot: rot })), null);
    }

    // Pass 2: a 3-row band split plus a 2x2 grid — finds codes that are too
    // small a share of the full frame, and gives a vertical position.
    if (onProgress) onProgress("Scanning photo for barcodes…");
    const W = img.naturalWidth, H = img.naturalHeight;
    for (let band = 0; band < 3; band++) {
      const crop = { x: 0, y: (band * H) / 3, w: W, h: H / 3 };
      push(zxingDecodeCanvas(toCanvas(img, { crop: crop })), (band + 0.5) / 3);
    }
    for (let gy = 0; gy < 2; gy++) {
      for (let gx = 0; gx < 2; gx++) {
        const crop = { x: (gx * W) / 2, y: (gy * H) / 2, w: W / 2, h: H / 2 };
        for (const rot of [0, 90]) {
          push(zxingDecodeCanvas(toCanvas(img, { crop: crop, rot: rot })), (gy + 0.5) / 2);
        }
      }
    }
    return found;
  }

  // ---- public API ----
  async function scan(src, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const img = await loadImage(src);

    onProgress("Scanning photo for barcodes…");
    let barcodes = await detectNative(img);
    if (!barcodes || !barcodes.length) {
      try {
        barcodes = await detectZXing(img, onProgress);
      } catch (e) {
        console.warn("Barcode scan unavailable:", e);
        barcodes = barcodes || [];
      }
    }

    // Keep only the codes that matter (e.g. tint rolls start with "W");
    // if none match the prefix, return everything so the page can say so.
    if (opts.prefix) {
      const want = barcodes.filter((b) =>
        String(b.value).toUpperCase().indexOf(String(opts.prefix).toUpperCase()) === 0);
      if (want.length) barcodes = want;
      else barcodes.forEach((b) => { b.offPrefix = true; });
    }

    // Bottom-most code first, when positions are known
    barcodes.sort((a, b) => (b.y === null ? -1 : b.y) - (a.y === null ? -1 : a.y));

    return { barcodes: barcodes };
  }

  window.UFScanner = { scan: scan, _cdn: CDN };
})();
