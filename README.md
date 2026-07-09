# Etsy → Shopify Order Sync

Continuously polls your Etsy shop for newly paid orders and creates matching Shopify
orders, decrementing Shopify inventory so both channels stay in sync. Built for
LwLeatherworking, but not store-specific.

## How it works

- Polls Etsy's Shop Receipts API every few minutes for new paid orders.
- Matches each Etsy line item to a Shopify product variant **by SKU**.
- If every line item on a receipt matches, creates a Shopify order (marked paid) and
  decrements inventory for each variant sold.
- If any line item's SKU doesn't match a Shopify variant, the whole receipt is skipped
  and flagged for manual review (visible via `/health`) — it's retried automatically
  once the SKU is fixed on either side.
- Etsy refunds/cancellations are **not** synced back to Shopify in this version — the
  service only reacts to receipts that are paid at the time it polls.

## One-time setup

### 1. Shopify custom app

Shopify now manages custom apps through the **Dev Dashboard**
([dev.shopify.com/dashboard](https://dev.shopify.com/dashboard)) rather than a
static token shown in Settings:

1. **Create app** → give it a name (e.g. "Etsy Sync").
2. Under **Access**, add these scopes: `read_orders`, `write_orders`, `read_products`,
   `read_inventory`, `write_inventory`.
3. Under **Installs**, install the app on your store.
4. In the app's settings, copy the **Client ID** and **Client secret** — you'll need
   both below. (There's no static "Admin API access token" to copy anymore; this
   service exchanges the client id/secret for a short-lived token itself, refreshing
   automatically every 24 hours.)

Note your store domain too (e.g. `lwleatherworking.myshopify.com`).

### 2. Etsy developer app

Register an app at [etsy.com/developers/your-apps](https://www.etsy.com/developers/your-apps).
You'll get a **keystring** (client id) and **shared secret**. Don't set the redirect URI
yet — you'll need your deployed URL first (step 4).

### 3. Deploy

Deploy this service to a small always-on host — [Railway](https://railway.app) is a
good default (connect the repo, it builds and runs `npm start` automatically). Add a
**persistent volume** mounted wherever `DB_PATH` points (default `./data/sync.db`) —
without it, redeploys will wipe your Etsy tokens and synced-order history.

Set these environment variables in the host's dashboard:

| Variable | Value |
|---|---|
| `ETSY_CLIENT_ID` | Your Etsy app keystring |
| `ETSY_CLIENT_SECRET` | Your Etsy app shared secret |
| `SHOPIFY_STORE_DOMAIN` | e.g. `lwleatherworking.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | From step 1 |
| `SHOPIFY_CLIENT_SECRET` | From step 1 |
| `PUBLIC_BASE_URL` | The public HTTPS URL the host assigns you, once known |
| `DB_PATH` | Path on your persistent volume, e.g. `/data/sync.db` |

See [.env.example](.env.example) for the full list with defaults.

### 4. Connect Etsy

Once deployed, go back to your Etsy app settings and register this as the redirect URI:

```
{PUBLIC_BASE_URL}/oauth/etsy/callback
```

(Etsy requires `https://` here — this is why the OAuth handshake happens against your
deployed URL rather than your local machine.)

Then visit `{PUBLIC_BASE_URL}/oauth/etsy/start` in a browser, log into Etsy, and
authorize. Your shop id is discovered and stored automatically — no further manual
config. The sync loop starts picking up orders on its next tick.

## Verifying before you trust it

1. **Dry run**: `npm run dry-run` (locally, with a `.env` populated as in
   `.env.example` and valid tokens already in the DB) logs exactly what would be
   created in Shopify — SKU matches, unmatched items, computed totals — without
   writing anything to Shopify or the local database. Since Etsy has no sandbox, this
   is the main way to sanity-check real data before going live.
2. **Small first real run**: consider temporarily lowering `SYNC_INTERVAL_MINUTES` or
   just letting the first tick run and checking the 1-2 orders it creates by hand in
   Shopify Admin.
3. **Check `/health`**: shows whether Etsy is authorized, the last sync run's counts,
   and how many receipts are currently flagged for manual review.
4. **Idempotency**: re-triggering a sync pass never creates duplicate orders — each
   Etsy receipt is recorded once it's successfully synced.

## Local development

```
npm install
cp .env.example .env   # fill in real values
npm run build
npm start               # runs the HTTP server + scheduler
npm run dry-run         # one-off read-only preview pass
```

## Notes / assumptions

- Assumes your Etsy shop and Shopify store use the **same currency** — Etsy amounts
  are passed through as-is with no currency conversion.
- Inventory adjustments use reason `"other"`, since "sold on a different sales
  channel" isn't one of Shopify's more specific built-in inventory reason codes.
- SQLite (`node:sqlite`, no native build step) tracks OAuth tokens, which receipts
  have been synced, and a sync checkpoint — back this file up along with the rest of
  your data if you ever migrate hosts.
