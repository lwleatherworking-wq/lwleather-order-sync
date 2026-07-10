import { getEnv } from "../config/env.js";
import { getShopId } from "../config/shopId.js";
import { getPaidReceiptsSince } from "../etsy/receipts.js";
import { getShopCurrencyCode } from "../shopify/shopInfo.js";
import { buildOrderInput, buildShippingAddress, createOrder } from "../shopify/orders.js";
import { resolveOrderCustomer } from "../shopify/customers.js";
import { decrementInventory } from "../shopify/inventory.js";
import { resolveLineItems } from "./mapping.js";
import { flagUnmatchedSkus, flagError } from "./reviewQueue.js";
import { hasSynced, markSynced, getCheckpoint, setCheckpoint, recordSyncRun } from "../db/receiptStore.js";
import { logger } from "../logger.js";

// Re-fetch a small overlap window behind the last checkpoint so a receipt that was still
// being written by Etsy right at the boundary isn't permanently missed.
const CHECKPOINT_OVERLAP_SECONDS = 60 * 60;
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;

export interface SyncRunSummary {
  receiptsSeen: number;
  receiptsSynced: number;
  receiptsSkipped: number;
  errorsCount: number;
  durationMs: number;
}

export async function syncOnce(): Promise<SyncRunSummary> {
  const startedAt = Date.now();
  const summary: SyncRunSummary = {
    receiptsSeen: 0,
    receiptsSynced: 0,
    receiptsSkipped: 0,
    errorsCount: 0,
    durationMs: 0,
  };

  const { DRY_RUN, BACKFILL_SINCE } = getEnv();
  const shopId = getShopId();
  const storedCheckpoint = getCheckpoint();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const backfillSince = BACKFILL_SINCE
    ? Math.floor(new Date(`${BACKFILL_SINCE}T00:00:00Z`).getTime() / 1000)
    : undefined;
  if (BACKFILL_SINCE && (backfillSince === undefined || Number.isNaN(backfillSince))) {
    throw new Error(`BACKFILL_SINCE is not a valid date: "${BACKFILL_SINCE}" (expected e.g. "2026-06-10")`);
  }
  const since =
    backfillSince ??
    (storedCheckpoint ? storedCheckpoint - CHECKPOINT_OVERLAP_SECONDS : nowSeconds - DEFAULT_LOOKBACK_SECONDS);
  if (backfillSince !== undefined) {
    logger.info("BACKFILL_SINCE is set — fetching receipts from this date instead of the normal checkpoint", {
      backfillSince: BACKFILL_SINCE,
    });
  }

  const receipts = await getPaidReceiptsSince(shopId, since);
  summary.receiptsSeen = receipts.length;
  const currencyCode = await getShopCurrencyCode();

  let maxProcessedTs = storedCheckpoint ?? since;

  for (const receipt of receipts) {
    if (hasSynced(String(receipt.receipt_id))) {
      maxProcessedTs = Math.max(maxProcessedTs, receipt.created_timestamp);
      continue;
    }

    try {
      const { resolved, unresolved } = await resolveLineItems(receipt);

      if (unresolved.length > 0) {
        if (DRY_RUN) {
          logger.info("[dry-run] would skip receipt (unmatched SKU)", { etsyReceiptId: receipt.receipt_id, unresolved });
        } else {
          flagUnmatchedSkus(receipt.receipt_id, receipt.created_timestamp, unresolved);
        }
        summary.receiptsSkipped += 1;
        // Deliberately do NOT advance maxProcessedTs past a flagged receipt, so it's
        // retried on the next run once the SKU mismatch is fixed.
        continue;
      }

      const shippingAddress = buildShippingAddress(receipt);

      if (DRY_RUN) {
        // Customer resolution without an email creates a real customer record as a side
        // effect, so it's skipped here — dry-run must never write anything to Shopify.
        const orderInput = buildOrderInput(receipt, resolved, currencyCode, shippingAddress, undefined);
        logger.info("[dry-run] would create Shopify order", { etsyReceiptId: receipt.receipt_id, orderInput });
        summary.receiptsSynced += 1;
        continue;
      }

      const customer = await resolveOrderCustomer({ buyerEmail: receipt.buyer_email, shippingAddress });
      const orderInput = buildOrderInput(receipt, resolved, currencyCode, shippingAddress, customer);
      const result = await createOrder(orderInput);

      if ("userErrors" in result) {
        flagError(receipt.receipt_id, receipt.created_timestamp, "shopify_order_error", result.userErrors);
        summary.errorsCount += 1;
        continue;
      }

      // Mark synced as soon as the order exists — before attempting inventory
      // adjustment — so that a failure in the inventory step (a bug, a transient
      // API error, anything) can never cause this receipt to be reprocessed into
      // a duplicate order on the next tick. Worst case then is a logged inventory
      // discrepancy to fix by hand, not another live duplicate order.
      markSynced({
        etsyReceiptId: String(receipt.receipt_id),
        shopifyOrderId: result.orderId,
        receiptCreatedTs: receipt.created_timestamp,
      });
      summary.receiptsSynced += 1;
      maxProcessedTs = Math.max(maxProcessedTs, receipt.created_timestamp);
      logger.info("Synced Etsy receipt to Shopify order", {
        etsyReceiptId: receipt.receipt_id,
        shopifyOrderId: result.orderId,
        shopifyOrderName: result.orderName,
      });

      try {
        for (const line of resolved) {
          await decrementInventory({
            inventoryItemId: line.variant.inventoryItemId,
            quantity: line.quantity,
            shopifyOrderId: result.orderId,
          });
        }
      } catch (inventoryError) {
        logger.error("Order created but inventory decrement failed — needs manual correction", {
          etsyReceiptId: receipt.receipt_id,
          shopifyOrderId: result.orderId,
          error: inventoryError instanceof Error ? inventoryError.message : String(inventoryError),
        });
      }
    } catch (error) {
      if (DRY_RUN) {
        logger.error("[dry-run] error while previewing receipt", {
          etsyReceiptId: receipt.receipt_id,
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        flagError(receipt.receipt_id, receipt.created_timestamp, "unexpected_error", error);
      }
      summary.errorsCount += 1;
    }
  }

  summary.durationMs = Date.now() - startedAt;
  if (DRY_RUN) {
    logger.info("Dry-run complete (no data was written to Shopify or the local database)", { ...summary });
    return summary;
  }

  setCheckpoint(maxProcessedTs);
  recordSyncRun(summary);
  logger.info("Sync run complete", { ...summary });
  return summary;
}
