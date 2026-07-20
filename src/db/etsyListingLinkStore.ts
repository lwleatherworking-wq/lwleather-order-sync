import { getDb } from "./client.js";

export function getEtsyListingLink(shopifyProductId: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT etsy_listing_id FROM etsy_listing_links WHERE shopify_product_id = ?`).get(
    shopifyProductId
  ) as { etsy_listing_id: string } | undefined;
  return row?.etsy_listing_id;
}

/** Clears a product's link, e.g. after its Etsy draft was deleted directly on Etsy and the
 * product needs to be listed fresh — without this, the app keeps pointing at a listing id
 * that no longer exists on Etsy's side. */
export function deleteEtsyListingLink(shopifyProductId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM etsy_listing_links WHERE shopify_product_id = ?`).run(shopifyProductId);
}

export function recordEtsyListingLink(shopifyProductId: string, etsyListingId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO etsy_listing_links (shopify_product_id, etsy_listing_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(shopify_product_id) DO UPDATE SET etsy_listing_id = excluded.etsy_listing_id, created_at = excluded.created_at`
  ).run(shopifyProductId, etsyListingId, Date.now());
}

export function listEtsyListingLinks(): Array<{ shopifyProductId: string; etsyListingId: string; createdAt: number }> {
  const db = getDb();
  const rows = db
    .prepare(`SELECT shopify_product_id, etsy_listing_id, created_at FROM etsy_listing_links ORDER BY created_at DESC`)
    .all() as Array<{ shopify_product_id: string; etsy_listing_id: string; created_at: number }>;
  return rows.map((r) => ({
    shopifyProductId: r.shopify_product_id,
    etsyListingId: r.etsy_listing_id,
    createdAt: r.created_at,
  }));
}
