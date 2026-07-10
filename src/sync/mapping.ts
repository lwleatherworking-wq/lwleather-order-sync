import type { EtsyReceipt } from "../etsy/types.js";
import { moneyToDecimalString } from "../etsy/types.js";
import { findVariantBySku } from "../shopify/variantLookup.js";
import { getSkuLink } from "../db/skuLinkStore.js";
import type { ResolvedLineItem } from "../shopify/orders.js";

export interface UnresolvedLine {
  transactionId: number;
  sku: string | null;
  reason: "missing_sku" | "sku_not_found";
}

export interface ResolvedLines {
  resolved: ResolvedLineItem[];
  unresolved: UnresolvedLine[];
}

/**
 * Resolves every line item on a receipt against Shopify variants by SKU.
 * Etsy's per-transaction `price` is the unit price (matching quantity), not the line total.
 */
export async function resolveLineItems(receipt: EtsyReceipt): Promise<ResolvedLines> {
  const resolved: ResolvedLineItem[] = [];
  const unresolved: UnresolvedLine[] = [];

  for (const txn of receipt.transactions) {
    if (!txn.sku) {
      unresolved.push({ transactionId: txn.transaction_id, sku: null, reason: "missing_sku" });
      continue;
    }
    // A manual override from /sku-linking takes precedence over the exact-match lookup,
    // for cases where the Etsy and Shopify SKUs were never going to match as-is.
    const linkedSku = getSkuLink(txn.sku);
    const variant = await findVariantBySku(linkedSku ?? txn.sku);
    if (!variant) {
      unresolved.push({ transactionId: txn.transaction_id, sku: txn.sku, reason: "sku_not_found" });
      continue;
    }
    resolved.push({
      variant,
      quantity: txn.quantity,
      unitPrice: moneyToDecimalString(txn.price),
    });
  }

  return { resolved, unresolved };
}
