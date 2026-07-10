import { etsyFetch } from "./apiClient.js";

const PAGE_SIZE = 100;

interface ShopListingsResponse {
  count: number;
  results: Array<{ listing_id: number; title: string }>;
}

/** Fetches every active listing for the shop, paginating through limit/offset results. */
export async function getActiveListings(shopId: string): Promise<Array<{ listingId: number; title: string }>> {
  const listings: Array<{ listingId: number; title: string }> = [];
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    const res = await etsyFetch(`/application/shops/${shopId}/listings/active?${params}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch Etsy active listings (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as ShopListingsResponse;
    for (const r of data.results) {
      listings.push({ listingId: r.listing_id, title: r.title });
    }

    offset += data.results.length;
    if (data.results.length < PAGE_SIZE || offset >= data.count) break;
  }

  return listings;
}

interface ListingInventoryResponse {
  products: Array<{ sku: string | null; is_deleted: boolean }>;
}

/** Fetches the SKUs set on a single listing's products (one listing can have several). */
export async function getListingSkus(listingId: number): Promise<string[]> {
  const res = await etsyFetch(`/application/listings/${listingId}/inventory`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy listing inventory ${listingId} (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ListingInventoryResponse;
  return data.products.filter((p) => !p.is_deleted && p.sku).map((p) => p.sku as string);
}

export interface EtsySkuEntry {
  sku: string;
  listingTitle: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // one listings call + one inventory call per listing, worth caching longer
let cache: { entries: EtsySkuEntry[]; cachedAt: number } | undefined;

/** All SKUs set across every active Etsy listing, for reference when creating a manual SKU link. */
export async function listEtsySkus(shopId: string): Promise<EtsySkuEntry[]> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  const listings = await getActiveListings(shopId);
  const entries: EtsySkuEntry[] = [];
  for (const listing of listings) {
    const skus = await getListingSkus(listing.listingId);
    for (const sku of skus) {
      entries.push({ sku, listingTitle: listing.title });
    }
  }

  entries.sort((a, b) => a.sku.localeCompare(b.sku));
  cache = { entries, cachedAt: Date.now() };
  return entries;
}
