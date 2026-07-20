// GET /api/auth  → kicks off Shopify OAuth.
// Redirects the browser to Shopify's consent screen. After you approve,
// Shopify sends you to /api/callback with a one-time code.
//
// Env vars needed:
//   SHOPIFY_STORE_DOMAIN   e.g. 13f029-7f.myshopify.com
//   SHOPIFY_API_KEY        the app's Client ID
//   (SHOPIFY_API_SECRET is used by /api/callback, not here)

module.exports = async (req, res) => {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const apiKey = process.env.SHOPIFY_API_KEY;
  const scopes = "read_products,read_inventory";

  if (!domain || !apiKey) {
    res.status(500).send("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_API_KEY env vars.");
    return;
  }

  const redirectUri = `https://${req.headers.host}/api/callback`;
  const state = Math.random().toString(36).slice(2);

  const authUrl =
    `https://${domain}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(apiKey)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
