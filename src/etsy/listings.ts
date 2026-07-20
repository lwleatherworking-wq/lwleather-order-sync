import { etsyFetch } from "./apiClient.js";
import { getListingInventory } from "./shopListings.js";
import { mapWithConcurrency } from "../util/concurrency.js";

const PAGE_SIZE = 100;
// Etsy's v3 API allows bursts well above this; kept modest so a shop with many listings
// doesn't hammer the rate limit and trigger a wave of 429 backoffs that end up slower
// than a lower concurrency would have been.
const INVENTORY_FETCH_CONCURRENCY = 6;

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

/**
 * Fetches the SKUs set on a single listing's products (one listing can have several). Shares
 * the same cache as the SKU-sync feature's inventory lookups — both need "every listing's
 * inventory" and previously fetched it independently, doubling the Etsy calls whenever both
 * pages were used in the same session.
 */
export async function getListingSkus(listingId: number): Promise<string[]> {
  const products = await getListingInventory(listingId);
  return products.filter((p) => p.sku).map((p) => p.sku as string);
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

  const [activeListings, draftListings] = await Promise.all([
    getListingsByState(shopId, "active"),
    getListingsByState(shopId, "draft"),
  ]);
  const listings = [...activeListings, ...draftListings];

  const skusByListing = await mapWithConcurrency(listings, INVENTORY_FETCH_CONCURRENCY, (listing) =>
    getListingSkus(listing.listingId)
  );

  const entries: EtsySkuEntry[] = [];
  listings.forEach((listing, i) => {
    for (const sku of skusByListing[i]!) {
      entries.push({ sku, listingTitle: listing.title, listingState: listing.state });
    }
  });

  entries.sort((a, b) => a.sku.localeCompare(b.sku));
  cache = { entries, cachedAt: Date.now() };
  return entries;
}
