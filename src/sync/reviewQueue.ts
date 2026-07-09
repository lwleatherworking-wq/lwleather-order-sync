import { flagReceipt } from "../db/receiptStore.js";
import { logger } from "../logger.js";
import type { UnresolvedLine } from "./mapping.js";

export function flagUnmatchedSkus(receiptId: number, receiptCreatedTs: number, unresolved: UnresolvedLine[]): void {
  const detail = JSON.stringify(unresolved);
  logger.warn("Etsy receipt has unmatched line items, skipping order creation", {
    etsyReceiptId: receiptId,
    unresolved,
  });
  flagReceipt({
    etsyReceiptId: String(receiptId),
    status: "needs_review",
    reason: "unmatched_sku",
    errorDetail: detail,
    receiptCreatedTs,
  });
}

export function flagError(receiptId: number, receiptCreatedTs: number, reason: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  logger.error("Error syncing Etsy receipt", { etsyReceiptId: receiptId, reason, detail });
  flagReceipt({
    etsyReceiptId: String(receiptId),
    status: "error",
    reason,
    errorDetail: detail,
    receiptCreatedTs,
  });
}
