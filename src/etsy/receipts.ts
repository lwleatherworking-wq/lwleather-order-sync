import { etsyFetch } from "./apiClient.js";
import type { EtsyReceipt, EtsyReceiptsResponse } from "./types.js";

const PAGE_SIZE = 100;

/**
 * Fetches all paid Etsy receipts created at or after `minCreatedUnixSeconds`, oldest first,
 * paginating through Etsy's limit/offset results.
 */
export async function getPaidReceiptsSince(
  shopId: string,
  minCreatedUnixSeconds: number
): Promise<EtsyReceipt[]> {
  const receipts: EtsyReceipt[] = [];
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({
      min_created: String(minCreatedUnixSeconds),
      was_paid: "true",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort_on: "created",
      sort_order: "asc",
    });
    const res = await etsyFetch(`/application/shops/${shopId}/receipts?${params}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch Etsy receipts (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as EtsyReceiptsResponse;
    receipts.push(...data.results);

    offset += data.results.length;
    if (data.results.length < PAGE_SIZE || offset >= data.count) break;
  }

  return receipts;
}
