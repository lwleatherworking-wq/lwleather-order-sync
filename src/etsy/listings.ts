import { etsyFetch } from "./apiClient.js";

const PAGE_SIZE = 100;

interface ShopListingsResponse {
  count: number;
  results: Array<{ listing_id: number; title: string }>;
}

export type ListingState = "active" | "draft";

/** Fetches every listing in a given state for the shop, paginating through limit/offset results. */
export async function getListingsByState(
  shopId: string,
  state: ListingState
): Promise<Array<{ listingId: number; title: string; state: ListingState }>> {
  const listings: Array<{ listingId: number; title: string; state: ListingState }> = [];
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({ state, limit: String(PAGE_SIZE), offset: String(offset) });
    const res = await etsyFetch(`/application/shops/${shopId}/listings?${params}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch Etsy ${state} listings (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as ShopListingsResponse;
    for (const r of data.results) {
      listings.push({ listingId: r.listing_id, title: r.title, state });
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
  listingState: ListingState;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // one listings call + one inventory call per listing, worth caching longer
let cache: { entries: EtsySkuEntry[]; cachedAt: number } | undefined;

/**
 * All SKUs set across every active *and* draft Etsy listing, for reference when creating a
 * manual SKU link and for checking whether a listing already exists for a product. Drafts are
 * included because this app's own /list-to-etsy feature creates listings as drafts — checking
 * only "active" listings would never find a match for anything created through this app.
 */
export async function listEtsySkus(shopId: string): Promise<EtsySkuEntry[]> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  const listings = [
    ...(await getListingsByState(shopId, "active")),
    ...(await getListingsByState(shopId, "draft")),
  ];
  const entries: EtsySkuEntry[] = [];
  for (const listing of listings) {
    const skus = await getListingSkus(listing.listingId);
    for (const sku of skus) {
      entries.push({ sku, listingTitle: listing.title, listingState: listing.state });
    }
  }

  entries.sort((a, b) => a.sku.localeCompare(b.sku));
  cache = { entries, cachedAt: Date.now() };
  return entries;
}
