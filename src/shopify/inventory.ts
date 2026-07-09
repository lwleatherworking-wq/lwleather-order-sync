import { createHash } from "node:crypto";
import { shopifyGraphql } from "./apiClient.js";
import { getPrimaryLocationId } from "./locations.js";

const MUTATION = /* GraphQL */ `
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface AdjustResult {
  inventoryAdjustQuantities: {
    inventoryAdjustmentGroup: { createdAt: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
}

/**
 * Decrements "available" inventory for one variant by `quantity`, referencing the Shopify
 * order it came from so the change shows up traceably in Shopify's inventory history.
 * The reason is "other" since this reflects a sale made on a different sales channel (Etsy),
 * which isn't one of Shopify's more specific built-in reason codes.
 */
export async function decrementInventory(params: {
  inventoryItemId: string;
  quantity: number;
  shopifyOrderId: string;
  etsyReceiptId: string;
}): Promise<void> {
  const locationId = await getPrimaryLocationId();

  const data = await shopifyGraphql<AdjustResult>(MUTATION, {
    input: {
      reason: "other",
      name: "available",
      // shopifyOrderId is already a full GID (e.g. gid://shopify/Order/123456789)
      referenceDocumentUri: params.shopifyOrderId,
      changes: [
        {
          delta: -Math.abs(params.quantity),
          inventoryItemId: params.inventoryItemId,
          locationId,
          // changeFromQuantity intentionally omitted: we don't track live on-hand counts
          // ourselves, so we don't try to compare-and-swap against a stale local value.
          ledgerDocumentUri: `gid://etsy-shopify-sync/Receipt/${params.etsyReceiptId}`,
        },
      ],
    },
  });

  if (data.inventoryAdjustQuantities.userErrors.length > 0) {
    throw new Error(
      `inventoryAdjustQuantities userErrors: ${JSON.stringify(data.inventoryAdjustQuantities.userErrors)}`
    );
  }
}

/** Deterministic idempotency helper (not currently required by this mutation, kept for future use/logging). */
export function inventoryAdjustmentKey(etsyReceiptId: string, inventoryItemId: string): string {
  return createHash("sha256").update(`${etsyReceiptId}:${inventoryItemId}`).digest("hex");
}
