import { getEnv } from "../config/env.js";
import { getShopId } from "../config/shopId.js";
import { getPaidReceiptsSince } from "../etsy/receipts.js";
import { getShopCurrencyCode } from "../shopify/shopInfo.js";
import { buildOrderInput, createOrder } from "../shopify/orders.js";
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

  const { DRY_RUN } = getEnv();
  const shopId = getShopId();
  const storedCheckpoint = getCheckpoint();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const since = storedCheckpoint
    ? storedCheckpoint - CHECKPOINT_OVERLAP_SECONDS
    : nowSeconds - DEFAULT_LOOKBACK_SECONDS;

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

      const orderInput = buildOrderInput(receipt, resolved, currencyCode);

      if (DRY_RUN) {
        logger.info("[dry-run] would create Shopify order", { etsyReceiptId: receipt.receipt_id, orderInput });
        summary.receiptsSynced += 1;
        continue;
      }

      const result = await createOrder(orderInput);

      if ("userErrors" in result) {
        flagError(receipt.receipt_id, receipt.created_timestamp, "shopify_order_error", result.userErrors);
        summary.errorsCount += 1;
        continue;
      }

      for (const line of resolved) {
        await decrementInventory({
          inventoryItemId: line.variant.inventoryItemId,
          quantity: line.quantity,
          shopifyOrderId: result.orderId,
          etsyReceiptId: String(receipt.receipt_id),
        });
      }

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
