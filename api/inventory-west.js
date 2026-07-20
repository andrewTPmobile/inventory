// Serverless function: GET /api/inventory-west
// Pulls inventory from Google Sheets (WEST USA Inventory tab)
// Service account JSON key stored in Vercel env var: GOOGLE_SHEETS_KEY (paste the entire JSON as a string)
//
// Required environment variables:
//   GOOGLE_SHEETS_KEY     Service account JSON key (paste entire JSON as one line or minified)
//   GOOGLE_SHEET_ID       The spreadsheet ID from the URL (1Tg5CeYpv6C2lvBfuhmVXQr1FWaIUc6ZvSI0r5MFZRSA)

const { google } = require('googleapis');

const SHEET_ID = '1Tg5CeYpv6C2lvBfuhmVXQr1FWaIUc6ZvSI0r5MFZRSA';
const SHEET_NAME = 'Sheet1'; // The tab name in your Google Sheet

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const keyStr = process.env.GOOGLE_SHEETS_KEY;
  if (!keyStr) {
    res.status(500).json({
      error: "Server not configured. Set GOOGLE_SHEETS_KEY in Vercel env vars.",
    });
    return;
  }

  try {
    // Parse the service account key
    let credentials;
    try {
      credentials = JSON.parse(keyStr);
    } catch (e) {
      res.status(500).json({
        error: "GOOGLE_SHEETS_KEY is not valid JSON",
        detail: e.message,
      });
      return;
    }

    // Create an authorized client
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    // Read the sheet data (columns A, B, C for Type, Item, Qty)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A:C`, // Read all rows, columns A-C
    });

    const rows = response.data.values || [];
    if (rows.length < 2) {
      res.status(200).json({
        updatedAt: new Date().toISOString(),
        count: 0,
        locations: ['ULTRAFIT WEST'],
        rows: [],
      });
      return;
    }

    // Parse the data
    // Expected format:
    // Row 0: Headers (might be ignored or used)
    // Row 1+: [Type, Item, Qty]
    // e.g., ["Clear PPF", "XP CRYSTAL (72\" x 40ft)", 5]

    const products = [];
    const headerRow = rows[0] || [];

    // Determine if row 0 is a header (contains "Item" or "Qty")
    const isHeaderRow =
      headerRow.some(cell => (cell || '').toLowerCase().includes('item')) ||
      headerRow.some(cell => (cell || '').toLowerCase().includes('qty'));

    const startIdx = isHeaderRow ? 1 : 0;

    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 2) continue; // Skip empty rows

      const type = (row[0] || '').trim();
      const itemName = (row[1] || '').trim();
      const qtyStr = (row[2] || '').trim();
      const qty = parseInt(qtyStr, 10) || 0;

      // Skip rows with no item name
      if (!itemName) continue;

      products.push({
        product: itemName,
        vendor: '', // Not in Google Sheet
        type: type || '', // Product type from column A
        status: 'ACTIVE',
        variant: '', // Not in Google Sheet
        sku: '', // Not in Google Sheet
        price: null, // Not in Google Sheet
        byLoc: { 'ULTRAFIT WEST': qty },
        qty: qty,
        image: null, // Not in Google Sheet
      });
    }

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      count: products.length,
      locations: ['ULTRAFIT WEST'],
      rows: products,
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to fetch inventory from Google Sheets',
      detail: String(err),
    });
  }
};
