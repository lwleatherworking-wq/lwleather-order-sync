import type { EtsyReceipt } from "../etsy/types.js";
import { moneyToDecimalString } from "../etsy/types.js";
import { findVariantBySku } from "../shopify/variantLookup.js";
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
    const variant = await findVariantBySku(txn.sku);
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
