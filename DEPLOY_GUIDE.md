# ULTRAFIT Inventory Dashboard — Deploy Guide

A private, live inventory dashboard that reads straight from Shopify. Your Shopify
token stays on the server (never in the browser). Total setup time: ~15 minutes.

You'll do three things:
1. Create a Shopify token so the site can read your inventory
2. Deploy the site to Vercel (free)
3. Point a subdomain at it

---

## Part 1 — Get a Shopify Admin API token

1. In Shopify admin, go to **Settings → Apps and sales channels → Develop apps**.
   (If you see "Allow custom app development", click it and confirm.)
2. Click **Create an app**. Name it something like `Inventory Dashboard`. Click **Create app**.
3. Open the **Configuration** tab → **Admin API integration** → **Configure**.
4. Under **Admin API access scopes**, enable these two:
   - `read_products`
   - `read_inventory`
5. **Save**, then go to the **API credentials** tab → click **Install app** → **Install**.
6. Copy the **Admin API access token** (it starts with `shpat_`). You only see it once —
   paste it somewhere safe for the next step.

Also note your store's `.myshopify.com` domain (e.g. `ultrafitnorthusa.myshopify.com`).
You'll find it in **Settings → Domains**, or it's in your admin URL.

---

## Part 2 — Deploy to Vercel

1. Go to https://vercel.com and sign up (use "Continue with Google" or GitHub — free).
2. Easiest path — install the CLI and deploy this folder directly:
   - Open Terminal on your Mac.
   - Run:  `npm i -g vercel`
   - Then:  `cd "/Users/pham/Desktop/PROJECT URABLE/inventory-site"`
   - Then:  `vercel`  (answer the prompts: link to your account, accept defaults)
   - Finally:  `vercel --prod`

   *(Prefer clicking over Terminal? See "Alternative: deploy by drag-and-drop" at the bottom.)*

3. Add your secret environment variables in Vercel:
   - In the Vercel dashboard, open your new project → **Settings → Environment Variables**.
   - Add these (Environment: **Production**):

     | Name                    | Value                                             |
     |-------------------------|---------------------------------------------------|
     | `SHOPIFY_STORE_DOMAIN`  | `ultrafitnorthusa.myshopify.com`                  |
     | `SHOPIFY_ADMIN_TOKEN`   | the `shpat_...` token from Part 1                 |
     | `DASHBOARD_PASSCODE`    | any passcode you choose (e.g. `ultrafit2026`)     |

   - `DASHBOARD_PASSCODE` is optional but recommended — it puts a passcode screen in front
     of the dashboard so it isn't wide open on the internet. Leave it out to skip the gate.

4. Re-deploy so the variables take effect: **Deployments → ⋯ on the latest → Redeploy**
   (or run `vercel --prod` again).

5. Open the Vercel URL it gives you (like `ultrafit-inventory.vercel.app`). You should see
   your live inventory. If you set a passcode, you'll be asked for it first.

---

## Part 3 — Point your subdomain at it

Decide your subdomain, e.g. `inventory.yourdomain.com` or `stock.yourdomain.com`.

1. In Vercel: project → **Settings → Domains → Add** → type `inventory.yourdomain.com` → **Add**.
2. Vercel shows a DNS record to create — usually a **CNAME**:
   - **Type:** CNAME
   - **Name/Host:** `inventory`  (just the subdomain part)
   - **Value/Target:** `cname.vercel-dns.com`
3. Go to wherever your domain's DNS lives (GoDaddy, Namecheap, Cloudflare, etc.),
   add that CNAME record, and save.
4. Back in Vercel, it will verify automatically (can take a few minutes to an hour).
   Once verified, `https://inventory.yourdomain.com` shows your dashboard with HTTPS.

That's it — it's live and updates every time the page is loaded or you hit **↻ Refresh**.

---

## Using the dashboard

- **Search** by product, SKU, vendor, or type.
- **Filter** to Negative / Zero / Low / In-stock, and Active-only vs all statuses.
- **Sort** any column by clicking its header (click again to reverse).
- Top cards summarize: active SKUs, negative-stock count, out-of-stock, low stock, and total units on hand.
- Red = negative, amber = zero or low (1–5), green = healthy. Adjust the "low" threshold by
  changing `LOW_THRESHOLD` near the top of the `<script>` in `index.html`.

---

## Alternative: deploy by drag-and-drop (no Terminal)

1. Zip the **contents** of the `inventory-site` folder (so `index.html`, `api/`, `vercel.json`,
   `package.json` are at the top level of the zip).
2. In Vercel, create a new project and choose the option to deploy without Git, then upload.
   (If your Vercel plan only shows Git import, install the CLI method above instead — it's the
   most reliable for the serverless `api/` function.)

---

## Troubleshooting

- **"Server not configured"** → the env vars aren't set, or you didn't redeploy after adding them.
- **401 / passcode screen won't accept your code** → the `DASHBOARD_PASSCODE` value in Vercel must
  match exactly what you type.
- **Shopify API error 403** → the token is missing `read_products` or `read_inventory` scope, or the
  app wasn't reinstalled after adding scopes.
- **Numbers look off / negative** → that's your real Shopify data; negative means oversold or that
  inventory tracking was toggled after sales. The dashboard is just reporting what Shopify has.
