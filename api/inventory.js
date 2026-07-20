// Serverless function: GET /api/inventory
// Pulls LIVE inventory from Shopify Admin GraphQL API.
// The Shopify token lives only here (as a Vercel env var) — never in the browser.
//
// Required environment variables (set in Vercel project settings):
//   SHOPIFY_STORE_DOMAIN   e.g. ultrafitnorthusa.myshopify.com  (the *.myshopify.com admin domain)
//   SHOPIFY_ADMIN_TOKEN    Admin API access token from a Shopify custom app (starts with shpat_)
// Optional:
//   DASHBOARD_PASSCODE     if set, callers must send it as ?passcode= or x-passcode header

const API_VERSION = "2025-01";

// Map Shopify location IDs → friendly names (reading location.name needs the
// read_locations scope; reading location.id does not, so we map here instead).
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
        variants(first: 25) {
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

module.exports = async (req, res) => {
  // CORS / cache headers
  res.setHeader("Cache-Control", "no-store");

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const clerkSecret = process.env.CLERK_SECRET_KEY;

  if (!domain || !token) {
    res.status(500).json({
      error: "Server not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN in Vercel.",
    });
    return;
  }

  // Optional Clerk auth: enforced ONLY when CLERK_SECRET_KEY is set.
  // Leave CLERK_SECRET_KEY unset for a no-login (public) dashboard.
  if (clerkSecret) {
    const authHeader = req.headers["authorization"] || "";
    const sessionToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!sessionToken) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }
    try {
      const { verifyToken } = require("@clerk/backend");
      await verifyToken(sessionToken, { secretKey: clerkSecret });
    } catch (e) {
      res.status(401).json({ error: "Invalid or expired session. Please sign in again." });
      return;
    }
  }

  const endpoint = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  try {
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
        const text = await r.text();
        res.status(502).json({ error: `Shopify API error (${r.status})`, detail: text.slice(0, 500) });
        return;
      }

      const json = await r.json();
      if (json.errors) {
        res.status(502).json({ error: "Shopify GraphQL error", detail: json.errors });
        return;
      }

      const block = json.data.products;
      for (const p of block.nodes) {
        // Flatten each variant into a row (a product can have several sizes/variants)
        for (const v of p.variants.nodes) {
          // Build a per-location quantity map for this variant
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
            qty: total, // total across all locations
            image: p.featuredImage ? p.featuredImage.url : null,
          });
        }
      }

      hasNext = block.pageInfo.hasNextPage;
      cursor = block.pageInfo.endCursor;
      pages++;
    }

    res.status(200).json({
      updatedAt: new Date().toISOString(),
      count: products.length,
      locations: Array.from(locationSet).sort(),
      rows: products,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch inventory", detail: String(err) });
  }
};
