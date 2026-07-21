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
        });
      }
    }

    hasNext = block.pageInfo.hasNextPage;
    cursor = block.pageInfo.endCursor;
    pages++;
  }

  return { products, locationSet };
}

// Fetch Google Sheets inventory
async function fetchGoogleSheetsInventory() {
  const keyStr = process.env.GOOGLE_SHEETS_KEY;
  if (!keyStr) {
    console.warn("GOOGLE_SHEETS_KEY not set, skipping Google Sheets");
    return { products: [], hasError: false };
  }

  try {
    const credentials = JSON.parse(keyStr);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_NAME}'!A:C`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) {
      return { products: [], hasError: false };
    }

    const products = [];
    const headerRow = rows[0] || [];
    const isHeaderRow =
      headerRow.some(cell => (cell || '').toLowerCase().includes('item')) ||
      headerRow.some(cell => (cell || '').toLowerCase().includes('qty'));

    const startIdx = isHeaderRow ? 1 : 0;

    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 2) continue;

      const type = (row[0] || '').trim();
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
      });
    }

    return { products, hasError: false };
  } catch (err) {
    console.error("Google Sheets error:", err.message);
    return { products: [], hasError: true, error: err.message };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  try {
    // Fetch both sources in parallel
    const [shopifyResult, googleResult] = await Promise.all([
      fetchShopifyInventory(),
      fetchGoogleSheetsInventory(),
    ]);

    const allProducts = [...shopifyResult.products, ...googleResult.products];
    const allLocations = Array.from(shopifyResult.locationSet);

    // Add ULTRAFIT WEST if Google Sheets has data
    if (googleResult.products.length > 0) {
      allLocations.push("ULTRAFIT WEST");
    }

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      count: allProducts.length,
      locations: allLocations.sort(),
      rows: allProducts,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch inventory",
      detail: String(err),
    });
  }
};
