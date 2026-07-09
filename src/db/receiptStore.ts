import { getDb } from "./client.js";

export type ReceiptStatus = "synced" | "needs_review" | "error";

const CHECKPOINT_KEY = "etsy_min_created";

export function hasSynced(etsyReceiptId: string): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM synced_receipts WHERE etsy_receipt_id = ? AND status = 'synced'`)
    .get(etsyReceiptId);
  return row !== undefined;
}

export function markSynced(params: {
  etsyReceiptId: string;
  shopifyOrderId: string;
  receiptCreatedTs: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO synced_receipts
       (etsy_receipt_id, shopify_order_id, status, reason, error_detail, receipt_created_ts, synced_at)
     VALUES (?, ?, 'synced', NULL, NULL, ?, ?)
     ON CONFLICT(etsy_receipt_id) DO UPDATE SET
       shopify_order_id = excluded.shopify_order_id,
       status = 'synced',
       reason = NULL,
       error_detail = NULL,
       synced_at = excluded.synced_at`
  ).run(params.etsyReceiptId, params.shopifyOrderId, params.receiptCreatedTs, Date.now());
}

export function flagReceipt(params: {
  etsyReceiptId: string;
  status: "needs_review" | "error";
  reason: string;
  errorDetail?: string;
  receiptCreatedTs: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO synced_receipts
       (etsy_receipt_id, shopify_order_id, status, reason, error_detail, receipt_created_ts, synced_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT(etsy_receipt_id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       error_detail = excluded.error_detail,
       synced_at = excluded.synced_at`
  ).run(
    params.etsyReceiptId,
    params.status,
    params.reason,
    params.errorDetail ?? null,
    params.receiptCreatedTs,
    Date.now()
  );
}

export function getFlaggedReceipts(): Array<{
  etsyReceiptId: string;
  status: ReceiptStatus;
  reason: string | null;
  errorDetail: string | null;
  syncedAt: number;
}> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT etsy_receipt_id, status, reason, error_detail, synced_at
       FROM synced_receipts WHERE status != 'synced' ORDER BY synced_at DESC`
    )
    .all() as Array<{
    etsy_receipt_id: string;
    status: ReceiptStatus;
    reason: string | null;
    error_detail: string | null;
    synced_at: number;
  }>;
  return rows.map((r) => ({
    etsyReceiptId: r.etsy_receipt_id,
    status: r.status,
    reason: r.reason,
    errorDetail: r.error_detail,
    syncedAt: r.synced_at,
  }));
}

/** Returns the min_created (unix seconds) checkpoint to resume polling from, with a small
 * overlap buffer applied by the caller so nothing near the boundary gets missed. */
export function getCheckpoint(): number | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM checkpoint WHERE key = ?`).get(CHECKPOINT_KEY) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : undefined;
}

export function setCheckpoint(unixSeconds: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO checkpoint (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(CHECKPOINT_KEY, String(unixSeconds));
}

export function recordSyncRun(summary: {
  receiptsSeen: number;
  receiptsSynced: number;
  receiptsSkipped: number;
  errorsCount: number;
  durationMs: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sync_runs (run_at, receipts_seen, receipts_synced, receipts_skipped, errors_count, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    summary.receiptsSeen,
    summary.receiptsSynced,
    summary.receiptsSkipped,
    summary.errorsCount,
    summary.durationMs
  );
}
