/* =========================================================================
   ULTRAFIT photo scanner — reads barcodes AND printed text from the
   checkout photo, so rolls can be auto-filled into the form.

   Usage (from a checkout page):

     const result = await UFScanner.scan(fileOrDataUrl, {
       onProgress: (msg) => { ... }          // status line updates
     });
     // result = {
     //   barcodes: [{ value, format }],      // every barcode found
     //   text:     "raw OCR text",           // printed text on the labels
     //   skuMatches: [{ code, product, variant, sku }]  // barcodes/SKUs that
     //                                       // matched live Shopify inventory
     // }

   Barcode decoding: native BarcodeDetector when the browser has it
   (Chrome on Android — i.e. the shop phones), with the ZXing library as a
   fallback for everything else. Text: Tesseract.js OCR. Both libraries are
   loaded lazily from a CDN only when a photo is actually scanned, so the
   pages stay fast.
   ========================================================================= */
(function () {
  "use strict";

  const CDN = {
    zxing: "https://cdn.jsdelivr.net/npm/@zxing/library@0.23.0/umd/index.min.js",
    tesseract: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
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
  async function detectNative(img) {
    if (!("BarcodeDetector" in window)) return null;
    try {
      const detector = new window.BarcodeDetector();
      const found = await detector.detect(img);
      return found.map((b) => ({ value: b.rawValue, format: b.format }));
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
    const push = (r) => {
      if (r && !seen.has(r.value)) { seen.add(r.value); found.push(r); }
    };

    // Pass 1: whole image at each rotation (labels can face any way)
    for (const rot of [0, 90, 270, 180]) {
      push(zxingDecodeCanvas(toCanvas(img, { rot: rot })));
    }

    // Pass 2: a 2x2 grid of crops — catches several rolls in one photo,
    // where each barcode is too small a share of the full frame to decode.
    if (onProgress) onProgress("Scanning photo for barcodes…");
    const W = img.naturalWidth, H = img.naturalHeight;
    for (let gy = 0; gy < 2; gy++) {
      for (let gx = 0; gx < 2; gx++) {
        const crop = { x: (gx * W) / 2, y: (gy * H) / 2, w: W / 2, h: H / 2 };
        for (const rot of [0, 90]) {
          push(zxingDecodeCanvas(toCanvas(img, { crop: crop, rot: rot })));
        }
      }
    }
    return found;
  }

  async function decodeBarcodes(img, onProgress) {
    const native = await detectNative(img);
    if (native && native.length) return native;
    try {
      return await detectZXing(img, onProgress);
    } catch (e) {
      console.warn("Barcode scan unavailable:", e);
      return native || [];
    }
  }

  // ---- OCR ----
  async function readText(img, onProgress) {
    try {
      await loadScript(CDN.tesseract);
      if (onProgress) onProgress("Reading label text… 0%");
      const canvas = toCanvas(img, { maxDim: 2000 });
      const result = await window.Tesseract.recognize(canvas, "eng", {
        logger: (m) => {
          if (m.status === "recognizing text" && onProgress) {
            onProgress("Reading label text… " + Math.round(m.progress * 100) + "%");
          }
        },
      });
      return (result && result.data && result.data.text) || "";
    } catch (e) {
      console.warn("OCR unavailable:", e);
      return "";
    }
  }

  // ---- live inventory SKU lookup ----
  // Barcodes on ULTRAFIT boxes carry the SKU; match them against the same
  // /api/inventory feed the dashboard uses. Cached for the page's lifetime.
  let skuMapPromise = null;
  function norm(s) {
    return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  function getSkuMap() {
    if (skuMapPromise) return skuMapPromise;
    skuMapPromise = fetch("/api/inventory")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const map = new Map();
        ((j && j.rows) || []).forEach((row) => {
          if (row.sku) {
            map.set(norm(row.sku), {
              sku: row.sku, product: row.product, variant: row.variant,
            });
          }
        });
        return map;
      })
      .catch(() => new Map());
    return skuMapPromise;
  }

  async function matchSkus(barcodes, text) {
    const map = await getSkuMap();
    if (!map.size) return [];
    const matches = [];
    const tried = new Set();
    const tryCode = (code) => {
      const k = norm(code);
      if (!k || tried.has(k)) return;
      tried.add(k);
      const hit = map.get(k);
      if (hit) matches.push({ code: code, sku: hit.sku, product: hit.product, variant: hit.variant });
    };
    barcodes.forEach((b) => tryCode(b.value));
    // OCR sometimes reads the SKU printed under the barcode
    String(text || "").split(/[\s,;|]+/).forEach((tok) => {
      if (tok.length >= 4) tryCode(tok);
    });
    return matches;
  }

  // ---- public API ----
  async function scan(src, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || function () {};
    const img = await loadImage(src);

    onProgress("Scanning photo for barcodes…");
    const barcodes = await decodeBarcodes(img, onProgress);

    let text = "";
    if (opts.ocr !== false) {
      text = await readText(img, onProgress);
    }

    onProgress("Matching against inventory…");
    const skuMatches = await matchSkus(barcodes, text);

    return { barcodes: barcodes, text: text, skuMatches: skuMatches };
  }

  window.UFScanner = { scan: scan, norm: norm, _cdn: CDN };
})();
