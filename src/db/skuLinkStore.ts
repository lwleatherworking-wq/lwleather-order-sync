import { getDb } from "./client.js";

export function getSkuLink(etsySku: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT shopify_sku FROM sku_links WHERE etsy_sku = ?`).get(etsySku) as
    | { shopify_sku: string }
    | undefined;
  return row?.shopify_sku;
}

export function setSkuLink(etsySku: string, shopifySku: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sku_links (etsy_sku, shopify_sku, created_at) VALUES (?, ?, ?)
     ON CONFLICT(etsy_sku) DO UPDATE SET shopify_sku = excluded.shopify_sku, created_at = excluded.created_at`
  ).run(etsySku, shopifySku, Date.now());
}

export function deleteSkuLink(etsySku: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM sku_links WHERE etsy_sku = ?`).run(etsySku);
}

export function listSkuLinks(): Array<{ etsySku: string; shopifySku: string; createdAt: number }> {
  const db = getDb();
  const rows = db.prepare(`SELECT etsy_sku, shopify_sku, created_at FROM sku_links ORDER BY created_at DESC`).all() as Array<{
    etsy_sku: string;
    shopify_sku: string;
    created_at: number;
  }>;
  return rows.map((r) => ({ etsySku: r.etsy_sku, shopifySku: r.shopify_sku, createdAt: r.created_at }));
}
