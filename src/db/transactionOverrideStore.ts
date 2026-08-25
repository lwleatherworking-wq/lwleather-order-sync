import { getDb } from "./client.js";

/**
 * Resolves a single Etsy transaction that has no SKU at all to a specific Shopify SKU — for
 * orders placed while the listing genuinely had no SKU set yet. Unlike sku_links (keyed by an
 * Etsy SKU), this only ever affects the one transaction it's set for.
 */
export function getTransactionOverride(etsyTransactionId: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare(`SELECT shopify_sku FROM transaction_overrides WHERE etsy_transaction_id = ?`)
    .get(etsyTransactionId) as { shopify_sku: string } | undefined;
  return row?.shopify_sku;
}

export function setTransactionOverride(etsyTransactionId: string, shopifySku: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO transaction_overrides (etsy_transaction_id, shopify_sku, created_at) VALUES (?, ?, ?)
     ON CONFLICT(etsy_transaction_id) DO UPDATE SET shopify_sku = excluded.shopify_sku, created_at = excluded.created_at`
  ).run(etsyTransactionId, shopifySku, Date.now());
}
