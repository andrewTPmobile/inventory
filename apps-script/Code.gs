/**
 * ULTRAFIT / TintPros — Checkout receiver
 * =======================================
 * Receives POSTs from TPTINTCHECKOUT.html and TP-PPFCHECKOUT.html and writes
 * them into the checkout spreadsheet.
 *
 * One row per roll line. Fixed columns first, then each roll's serial
 * number(s) — read from the photo's bottom barcode (W… = tint, P… = PPF) —
 * are written into the NEXT AVAILABLE COLUMNS of that row.
 *
 * Setup (one time):
 *   1. Open script.google.com → the project behind your current deployment
 *      (the /exec URL used by the checkout pages).
 *   2. Replace the code with this file. Save.
 *   3. Deploy → Manage deployments → Edit (pencil) → Version: "New version"
 *      → Deploy. Keep "Anyone" access so the pages can POST to it.
 *      (Re-deploying a NEW deployment would change the URL — editing the
 *      existing one keeps the URL in the pages working.)
 */

// The "Window Tint Checkout System" spreadsheet
const SPREADSHEET_ID = '1R6EbLQpQgScl9unT-WTFcHMg1tvBlohMV0QZ5Oz69bI';

// Checkout photos get saved here (folder is created on first use)
const PHOTO_FOLDER_NAME = 'Checkout Photos';

// Fixed columns. Serials land right after these — the next available columns.
const HEADERS = ['Timestamp', 'Submission', 'Employee', 'Date', 'Film Type', 'VLT', 'Size', 'Qty', 'Photo', 'Serial #'];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // A repeated POST of the same checkout (retry, double tap) writes nothing
    if (data.submissionId && alreadyProcessed_(data.submissionId)) {
      return json_({ ok: true, duplicate: true });
    }

    const tabName = (data.checkoutType || 'CHECKOUT').toUpperCase(); // TINT / PPF
    const sheet = getSheet_(tabName);
    const photoUrl = savePhoto_(data);

    // Serial numbers scanned off the photo's bottom barcodes
    const serials = (data.serials || []).slice();

    const rows = [];
    (data.items || []).forEach(function (item) {
      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      // Each row takes as many serials as rolls it represents
      const rowSerials = serials.splice(0, qty);
      rows.push([
        data.timestamp || new Date().toLocaleString(),
        data.submissionId || '',
        data.employeeName || '',
        data.checkoutDate || '',
        item.product || '',
        item.vlt || '',        // blank on PPF checkouts
        item.size || '',
        qty,
        photoUrl,
      ].concat(rowSerials));   // ← serials fill the next available columns
    });

    // Serials that didn't pair up with a roll line still get recorded
    if (serials.length) {
      rows.push([
        data.timestamp || new Date().toLocaleString(),
        data.submissionId || '',
        data.employeeName || '',
        data.checkoutDate || '',
        'UNMATCHED SERIALS', '', '', '',
        photoUrl,
      ].concat(serials));
    }

    // Write each row, serials spilling into however many columns they need
    rows.forEach(function (row) {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    });

    if (data.submissionId) markProcessed_(data.submissionId);
    return json_({ ok: true, rows: rows.length });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ---- helpers ----------------------------------------------------------------

function getSheet_(tabName) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function savePhoto_(data) {
  try {
    if (!data.photoBase64) return '';
    const m = String(data.photoBase64).match(/^data:(image\/\w+);base64,(.+)$/s);
    if (!m) return '';
    const blob = Utilities.newBlob(
      Utilities.base64Decode(m[2]), m[1],
      (data.checkoutType || 'checkout') + '_' + (data.checkoutDate || '') + '_' +
      (data.employeeName || '').replace(/\W+/g, '') + '_' + Date.now() + '.jpg'
    );
    const folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER_NAME);
    const file = folder.createFile(blob);
    return file.getUrl();
  } catch (err) {
    return 'photo save failed: ' + String(err);
  }
}

function alreadyProcessed_(id) {
  return CacheService.getScriptCache().get('sub_' + id) === '1';
}

function markProcessed_(id) {
  CacheService.getScriptCache().put('sub_' + id, '1', 21600); // 6 hours
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
