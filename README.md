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

Only two things need to be set as actual environment variables at deploy time —
everything else (Etsy/Shopify credentials, store domain, public URL, sync interval,
dry run, backfill date) can instead be filled in **after deploying**, via the
[`/setup` page](#setup-page) below, no redeploy required:

| Variable | Value |
|---|---|
| `DB_PATH` | Path on your persistent volume, e.g. `/data/sync.db` |
| `SETUP_PASSWORD` | A password you choose, to protect the `/setup` page |

See [.env.example](.env.example) for the full list, including the fields that can be
set either way (env var *or* `/setup`).

### 4. Fill in credentials via `/setup`

Visit `https://{your-deployed-url}/setup` and enter the Etsy/Shopify credentials from
steps 1–2, your store domain, and `PUBLIC_BASE_URL` (the same deployed URL, e.g.
`https://your-app.up.railway.app`) — enter the setup password you set in step 3 to
save. Changes apply immediately, no redeploy needed.

### 5. Connect Etsy

Once `PUBLIC_BASE_URL` is set, go back to your Etsy app settings and register this as
the redirect URI:

```
{PUBLIC_BASE_URL}/oauth/etsy/callback
```

(Etsy requires `https://` here — this is why the OAuth handshake happens against your
deployed URL rather than your local machine.)

Then visit `{PUBLIC_BASE_URL}/oauth/etsy/start` in a browser, log into Etsy, and
authorize. Your shop id is discovered and stored automatically — no further manual
config. The sync loop starts picking up orders on its next tick.

### 6. (Optional) One-time historical backfill

By default the very first sync only looks back 24 hours — it's meant to catch *new*
orders going forward, not import your whole order history. To pull in older orders once:

1. Set "Backfill since" to a date (e.g. `2026-06-10`) via `/setup` (or `BACKFILL_SINCE`
   as an env var).
2. Watch the logs, or the status page, for a sync run covering that range.
3. **Clear the backfill date again** via `/setup` once it's run once — otherwise every
   future tick keeps needlessly re-scanning that whole date range (harmless, since
   already-synced orders are skipped, but wasteful).

## Pages

- **`/`** — status dashboard: Etsy connection state, the last sync run's counts, and
  any receipts flagged for manual review. Auto-refreshes every 30 seconds.
- **`/log`** — the full history of successfully synced orders (Etsy receipt id,
  linked Shopify order, order date, sync time), most recent 200.
- **`/sku-linking`** — manually map an Etsy listing SKU to a Shopify variant SKU, for
  cases where they were never going to match exactly (typos, different naming
  conventions, etc.). Shows which SKUs currently have a receipt stuck on them, lets
  you link one to a real Shopify SKU (validated against the store before saving), and
  the fix takes effect on the very next sync tick — no need to edit the SKU on either
  the Etsy listing or the Shopify product itself. Also lists every SKU already set on
  a Shopify variant and every SKU set on an active Etsy listing, as a reference when
  typing one into the forms. The Etsy list requires the `listings_r` OAuth scope — if
  you connected Etsy before this was added, re-authorize once via `/oauth/etsy/start`.
- **`/list-to-etsy`** — pick one Shopify product at a time and create a matching
  **draft** listing on Etsy (never published live automatically). Title, description,
  price, and quantity are pre-filled from the Shopify product and editable; category,
  shipping profile, "who/when made", and "craft supply" are Etsy-only fields you fill
  in on the form since Shopify has no equivalent. Requires the `listings_w` OAuth
  scope — if you connected Etsy before this was added, re-authorize once via
  `/oauth/etsy/start`. All of the product's Shopify images (up to 10) are uploaded to
  the draft automatically, converted to JPEG since Etsy doesn't accept Shopify's WebP
  files — the success message reports how many uploaded. Each product tracks which
  Etsy draft it was sent to, so the picker shows "already listed" instead of a link
  once one exists — submitting again from that product's form still creates a
  **separate** new draft (there's no update-in-place). For a product with more than
  one Shopify variant, the flat price/quantity/SKU fields are replaced by a
  **Variations** section: pick a category first, then map each Shopify option (e.g.
  "Size") to one of the Etsy properties that category supports, and each of its
  values either to one of Etsy's existing options or as custom text — Etsy ties
  variations to its own structured property system, so this can't be inferred
  automatically. Every variant becomes its own SKU/price/quantity on the listing.
- **`/setup`** — configure (or change) Etsy/Shopify credentials, the store domain,
  public URL, sync interval, dry-run toggle, and backfill date without touching
  Railway's dashboard or redeploying — protected by the `SETUP_PASSWORD` env var.
  Settings saved here take effect on the very next read (the sync interval and
  dry-run toggle apply on the next tick; Shopify credential changes force a fresh
  token fetch immediately).
- **`/health`** — raw JSON version of the status page, for scripting.

## Embedding inside Shopify Admin

These pages can be **embedded inside Shopify Admin** as an app tab: in the Dev
Dashboard, set the app's **App URL** to the deployed URL and enable "embedded app" if
offered. Shopify will then show it as an entry under Apps in your store's admin sidebar.

Each page includes a left-sidebar navigation menu (Status/Log/Setup) using Shopify's
`<s-app-nav>` component, plus a plain in-page nav bar as a fallback. **The sidebar menu
could not be fully verified without an actual embedded session** — Shopify's App Bridge
only activates these components when genuinely running inside Shopify's iframe, which
isn't something that could be tested from outside it. If the sidebar tabs don't appear
once installed, the in-page nav links at the top of each page work regardless.

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
