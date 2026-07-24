/**
 * TP WINDOW TINT CHECKOUT — receiver
 * ==================================
 * Receives POSTs from TPTINTCHECKOUT.html and TP-PPFCHECKOUT.html and writes
 * them into the "TP WINDOW TINT CHECKOUT" spreadsheet, "Checkouts" tab,
 * matching the existing columns:
 *
 *   A Timestamp | B Employee Name | C Date | D Film Type | E VLT | F Size
 *   | G Quantity | H Photo Link | I, J, … Serial #
 *
 * The serial numbers scanned from the photo's bottom barcode (W… = tint,
 * P… = PPF) are written into the NEXT AVAILABLE COLUMNS after Photo Link —
 * one serial per roll, on the row of the roll it belongs to.
 *
 * To update: open the Apps Script project, replace the code with this file,
 * save, then Deploy → Manage deployments → ✏️ Edit → Version: New version
 * → Deploy. (Editing the existing deployment keeps the same /exec URL.)
 */

const SPREADSHEET_ID = '11bjULN40w54GCvDFRpww6GeH--lSB0hjmUhyaHyjDkQ';
const TINT_TAB = 'Checkouts';
const PPF_TAB = 'PPF Checkouts';   // created automatically on first PPF checkout

// Checkout photos get saved here in Drive (folder is created on first use)
const PHOTO_FOLDER_NAME = 'Checkout Photos';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // A repeated POST of the same checkout (retry, double tap) writes nothing
    if (data.submissionId && alreadyProcessed_(data.submissionId)) {
      return json_({ ok: true, duplicate: true });
    }

    const isPPF = String(data.checkoutType || '').toUpperCase() === 'PPF';
    const sheet = getSheet_(isPPF ? PPF_TAB : TINT_TAB);
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
        data.employeeName || '',
        data.checkoutDate || '',
        item.product || '',
        item.vlt || '',          // blank on PPF checkouts
        item.size || '',
        qty,
        photoUrl,                // Photo Link
      ].concat(rowSerials));     // ← serials land in the next available columns
    });

    // Serials that didn't pair up with a roll line still get recorded
    if (serials.length) {
      rows.push([
        data.timestamp || new Date().toLocaleString(),
        data.employeeName || '',
        data.checkoutDate || '',
        'UNMATCHED SERIALS', '', '', '', photoUrl,
      ].concat(serials));
    }

    rows.forEach(function (row) {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    });
    // Blank spacer row between checkouts, matching the existing sheet style
    sheet.appendRow(['']);

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
    sheet.getRange(1, 1, 1, 9).setValues([[
      'Timestamp', 'Employee Name', 'Date', 'Film Type', 'VLT', 'Size',
      'Quantity', 'Photo Link', 'Serial #',
    ]]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Make sure the serial column has a header on the existing tab too
  if (!sheet.getRange(1, 9).getValue()) {
    sheet.getRange(1, 9).setValue('Serial #').setFontWeight('bold');
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
    return '';   // a photo problem never blocks the checkout row
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
