// GET /api/callback  → Shopify redirects here after you approve.
// Exchanges the one-time `code` for a PERMANENT Admin API access token,
// then shows it once so you can paste it into the SHOPIFY_ADMIN_TOKEN env var.
//
// Env vars needed:
//   SHOPIFY_STORE_DOMAIN   e.g. 13f029-7f.myshopify.com
//   SHOPIFY_API_KEY        the app's Client ID
//   SHOPIFY_API_SECRET     the app's Client secret (shpss_...)

module.exports = async (req, res) => {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const code = req.query && req.query.code;

  if (!domain || !apiKey || !apiSecret) {
    res.status(500).send("Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_API_KEY / SHOPIFY_API_SECRET env vars.");
    return;
  }
  if (!code) {
    res.status(400).send("Missing ?code from Shopify. Start over at /api/auth.");
    return;
  }

  try {
    const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      }),
    });

    const data = await r.json();

    if (!data.access_token) {
      res.setHeader("Content-Type", "text/html");
      res.status(502).send(
        `<h2>Token exchange failed</h2><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`
      );
      return;
    }

    const token = data.access_token;
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(`
<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Your Shopify token</title>
<style>
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e7e9ee;margin:0;padding:40px;max-width:760px}
  h1{font-size:20px}
  .tok{background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:14px;word-break:break-all;font-family:ui-monospace,Menlo,monospace;font-size:13px;margin:14px 0}
  ol{line-height:1.9} code{background:#1e222b;padding:2px 6px;border-radius:5px}
  button{font:inherit;background:#4f8cff;color:#fff;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
  .warn{color:#e0a83d}
</style></head><body>
  <h1>✅ Success — your permanent Shopify token</h1>
  <p>Copy this and paste it into Vercel as <code>SHOPIFY_ADMIN_TOKEN</code>:</p>
  <div class="tok" id="t">${escapeHtml(token)}</div>
  <button onclick="navigator.clipboard.writeText(document.getElementById('t').textContent)">Copy token</button>
  <ol>
    <li>Vercel → your project → <b>Settings → Environment Variables</b>.</li>
    <li>Edit <code>SHOPIFY_ADMIN_TOKEN</code> → paste this value → Save.</li>
    <li><b>Deployments</b> → ⋯ on the latest → <b>Redeploy</b>.</li>
    <li>Open your dashboard — it should now load live inventory.</li>
  </ol>
  <p class="warn">This token is permanent. Don't share it. Once it's in place, you can delete the
  <code>/api/auth</code> and <code>/api/callback</code> files if you like.</p>
</body></html>`);
  } catch (err) {
    res.status(500).send("Error exchanging code: " + String(err));
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
