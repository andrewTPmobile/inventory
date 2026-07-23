// Serverless function: GET /api/inventory
// Merges LIVE Shopify inventory + Google Sheets (ULTRAFIT WEST)
//
// Required environment variables:
//   SHOPIFY_STORE_DOMAIN      e.g. ultrafitnorthusa.myshopify.com
//   SHOPIFY_ADMIN_TOKEN       Admin API access token (starts with shpat_)
//   GOOGLE_SHEETS_KEY         Service account JSON key (entire JSON as string)

const { google } = require('googleapis');

const API_VERSION = "2025-01";
const SHEET_ID = '1Tg5CeYpv6C2lvBfuhmVXQr1FWaIUc6ZvSI0r5MFZRSA';
const SHEET_NAME = 'Sheet1';

// ULTRAFIT Korea HQ warehouse sheet (maintained by the Korea team)
const KOREA_SHEET_ID = '1j6i9swoR46-5EtHzaZdE6FcvHw-7A-nU4ACjpr35UvU';

// Map Shopify location IDs → friendly names
const LOCATION_NAMES = {
  "gid://shopify/Location/78608269532": "Korea WH",
  "gid://shopify/Location/94196007132": "UF West",
  "gid://shopify/Location/77212418268": "ULTRAFIT NORTH USA",
  "gid://shopify/Location/94214357212": "ULTRAFIT SOUTH",
};

const PRODUCTS_QUERY = `
  query Inventory($cursor: String) {
    products(first: 25, after: $cursor, sortKey: INVENTORY_TOTAL) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        vendor
        productType
        status
        featuredImage { url }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            inventoryItem {
              inventoryLevels(first: 10) {
                nodes {
                  location { id }
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Fetch Shopify inventory
async function fetchShopifyInventory() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  if (!domain || !token) {
    throw new Error("SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN required");
  }

  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const products = [];
  const locationSet = new Set();
  let cursor = null;
  let hasNext = true;
  let pages = 0;

  while (hasNext && pages < 50) {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor } }),
    });

    if (!r.ok) {
      throw new Error(`Shopify API error (${r.status})`);
    }

    const json = await r.json();
    if (json.errors) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
    }

    const block = json.data.products;
    for (const p of block.nodes) {
      for (const v of p.variants.nodes) {
        const byLoc = {};
        let total = 0;
        const levels =
          v.inventoryItem &&
          v.inventoryItem.inventoryLevels &&
          v.inventoryItem.inventoryLevels.nodes
            ? v.inventoryItem.inventoryLevels.nodes
            : [];

        for (const lvl of levels) {
          const locId = lvl.location ? lvl.location.id : null;
          const locName = LOCATION_NAMES[locId] || locId || "Unknown";
          const availObj = (lvl.quantities || []).find((q) => q.name === "available");
          const qty = availObj ? availObj.quantity : 0;
          byLoc[locName] = (byLoc[locName] || 0) + qty;
          total += qty;
          locationSet.add(locName);
        }

        products.push({
          product: p.title,
          vendor: p.vendor || "",
          type: p.productType || "",
          status: p.status,
          variant: v.title === "Default Title" ? "" : v.title,
          sku: v.sku || "",
          price: v.price ? Number(v.price) : null,
          byLoc: byLoc,
          qty: total,
          image: p.featuredImage ? p.featuredImage.url : null,
          source: "shopify", // Mark as Shopify data
        });
      }
    }

    hasNext = block.pageInfo.hasNextPage;
    cursor = block.pageInfo.endCursor;
    pages++;
  }

  return { products, locationSet };
}

// Pull a "last updated" stamp out of a sheet's top rows.
// The Korea sheet spells it out in row 1 ("Date Last Updated | 7/3/26"); other
// sheets may just park a date up there, so accept either shape.
function findUpdatedCell(rows) {
  const LABEL = /(last\s*updated|updated|as\s*of)/i;
  const DATE = /^\s*\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\s*$/;
  for (let i = 0; i < Math.min(rows.length, 4); i++) {
    const row = rows[i] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || "").trim();
      if (!cell) continue;
      if (LABEL.test(cell)) {
        // the stamp is the next non-empty cell on the same row
        for (let n = c + 1; n < row.length; n++) {
          const val = String(row[n] || "").trim();
          if (val) return val;
        }
      }
      if (i < 2 && DATE.test(cell)) return cell;
    }
  }
  return null;
}

// Last-modified time straight from Drive, used when the sheet carries no stamp
// of its own. Needs the Drive API enabled for the service account; if it isn't,
// this quietly returns null rather than failing the whole request.
async function fetchDriveModified(credentials, fileId) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const r = await drive.files.get({ fileId, fields: 'modifiedTime' });
    return r.data.modifiedTime || null;
  } catch (err) {
    console.warn("Drive modifiedTime unavailable:", err.message);
    return null;
  }
}

// Fetch Google Sheets inventory
async function fetchGoogleSheetsInventory() {
  const keyStr = process.env.GOOGLE_SHEETS_KEY;
  if (!keyStr) {
    console.warn("GOOGLE_SHEETS_KEY not set, skipping Google Sheets");
    return { products: [], updated: null, modified: null, hasError: false };
  }

  try {
    const credentials = JSON.parse(keyStr);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    // A:F rather than A:C so a date parked to the right of the item columns is
    // still visible; the product parse below only ever reads A, B and C.
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A:F`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) {
      return { products: [], updated: null, modified: null, hasError: false };
    }

    const updated = findUpdatedCell(rows);
    const modified = updated ? null : await fetchDriveModified(credentials, SHEET_ID);

    const products = [];
    const headerRow = rows[0] || [];
    const isHeaderRow =
      headerRow.some(cell => (cell || '').toLowerCase().includes('item')) ||
      headerRow.some(cell => (cell || '').toLowerCase().includes('qty'));

    const startIdx = isHeaderRow ? 1 : 0;

    // Type uses merged cells (labelled once per block, like the Korea sheet),
    // so a blank Type means "same as the row above". Line breaks inside the
    // cell ("Clear \nPPF") collapse to a single space so it lines up with the
    // Shopify product types.
    let lastType = '';

    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 2) continue;

      const rawType = (row[0] || '').replace(/\s+/g, ' ').trim();
      if (rawType) lastType = rawType;
      const type = lastType;
      const itemName = (row[1] || '').trim();
      const qtyStr = (row[2] || '').trim();
      const qty = parseInt(qtyStr, 10) || 0;

      if (!itemName) continue;

      products.push({
        product: itemName,
        vendor: "",
        type: type || "",
        status: "ACTIVE",
        variant: "",
        sku: "",
        price: null,
        byLoc: { "ULTRAFIT WEST": qty },
        qty: qty,
        image: null,
        source: "google", // Mark as Google Sheets data
      });
    }

    return { products, updated, modified, hasError: false };
  } catch (err) {
    console.error("Google Sheets error:", err.message);
    return { products: [], updated: null, modified: null, hasError: true, error: err.message };
  }
}

// Fetch Korea HQ warehouse status sheet
// Columns: A Type | B Product | C Size | D Inventory Status | E Rough Qty | F Date back? | G Notes
// Type/Product use merged cells, so blank cells inherit the value above them.
async function fetchKoreaInventory() {
  const keyStr = process.env.GOOGLE_SHEETS_KEY;
  if (!keyStr) {
    console.warn("GOOGLE_SHEETS_KEY not set, skipping Korea sheet");
    return { products: [], updated: null, hasError: false };
  }

  try {
    const credentials = JSON.parse(keyStr);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    // No sheet name in the range → first (gid=0) tab
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: KOREA_SHEET_ID,
      range: 'A1:G500',
    });

    const rows = response.data.values || [];
    if (rows.length < 3) {
      return { products: [], updated: null, hasError: false };
    }

    // Row 1: "ULTRAFIT Korea | Date Last Updated | <date>"
    const titleRow = rows[0] || [];
    const updated = (titleRow[2] || '').trim() || null;

    // Find the header row (contains "Product" / "Inventory Status"), data starts after it
    let headerIdx = 1;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const joined = (rows[i] || []).join(' ').toLowerCase();
      if (joined.includes('inventory status')) { headerIdx = i; break; }
    }

    const products = [];
    let lastType = '';
    let lastProduct = '';

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const rawType = (row[0] || '').trim();
      const rawProduct = (row[1] || '').trim();
      const rawSize = (row[2] || '').trim();
      const status = (row[3] || '').trim();
      const dateBack = (row[5] || '').trim();
      const notes = (row[6] || '').trim();

      // Merged cells: blank Type/Product means "same as the row above"
      if (rawType) lastType = rawType;
      if (rawProduct) lastProduct = rawProduct;

      const product = rawProduct || lastProduct;
      if (!product) continue;
      // Skip rows that are entirely empty apart from carried-over merges
      if (!rawProduct && !rawSize && !status && !dateBack && !notes) continue;

      // Tint rows merge Product and Size into the same text — don't repeat it
      const variant = (rawSize && rawSize !== product) ? rawSize : '';

      products.push({
        product: product,
        vendor: "",
        type: lastType || "",
        status: "ACTIVE",
        variant: variant,
        sku: "",
        price: null,
        byLoc: { "KOREA STOCK": 0 },
        qty: 0,
        image: null,
        source: "korea",           // Mark as Korea sheet data
        koreaStatus: status,        // e.g. "Healthy 50+", "Out of Stock"
        dateBack: dateBack,         // e.g. "3rd week of July", "Discontinued"
        notes: notes,
      });
    }

    return { products, updated, hasError: false };
  } catch (err) {
    console.error("Korea sheet error:", err.message);
    return { products: [], updated: null, hasError: true, error: err.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    // Fetch all sources in parallel
    const [shopifyResult, googleResult, koreaResult] = await Promise.all([
      fetchShopifyInventory(),
      fetchGoogleSheetsInventory(),
      fetchKoreaInventory(),
    ]);

    const allProducts = [
      ...shopifyResult.products,
      ...googleResult.products,
      ...koreaResult.products,
    ];
    const locationSet = new Set(shopifyResult.locationSet);

    // Add ULTRAFIT WEST if Google Sheets has data
    if (googleResult.products.length > 0) {
      locationSet.add("ULTRAFIT WEST");
    }
    // KOREA STOCK is driven by the Korea team's sheet — the Shopify
    // "Korea WH" location is unlinked from the location dropdown
    locationSet.delete("Korea WH");
    if (koreaResult.products.length > 0) {
      locationSet.add("KOREA STOCK");
    }

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      koreaUpdated: koreaResult.updated || null,
      // WEST sheet's own stamp if it has one, else its Drive last-modified time
      westUpdated: googleResult.updated || null,
      westModified: googleResult.modified || null,
      count: allProducts.length,
      locations: Array.from(locationSet).sort(),
      rows: allProducts,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch inventory",
      detail: String(err),
    });
  }
};
