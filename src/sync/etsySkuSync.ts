import { getListingsByState } from "../etsy/listings.js";
import { getListingInventory, updateListingSkus, type ListingInventoryProduct } from "../etsy/shopListings.js";
import { listProductsWithVariants, type ProductWithVariants, type ProductVariant } from "../shopify/products.js";
import { listEtsyListingLinks } from "../db/etsyListingLinkStore.js";
import { mapWithConcurrency } from "../util/concurrency.js";

// Kept modest so a shop with many listings doesn't hammer Etsy's rate limit and trigger a
// wave of 429 backoffs that end up slower than a lower concurrency would have been.
const INVENTORY_FETCH_CONCURRENCY = 6;

export interface SkuDiff {
  productId: number; // Etsy inventory product id
  variantLabel: string; // e.g. "Size: Medium", or "—" for a listing with no variations
  currentSku: string | null;
  newSku: string;
  changed: boolean;
}

export type MatchStatus = "linked" | "suggested" | "unmatched" | "ambiguous";

export interface ListingSyncStatus {
  listingId: number;
  listingTitle: string;
  listingState: "active" | "draft";
  matchStatus: MatchStatus;
  matchedProductId: string | null;
  matchedProductTitle: string | null;
  currentSkus: string[];
  diffs: SkuDiff[];
  warning: string | null;
}

export interface SyncAnalysis {
  statuses: ListingSyncStatus[];
  shopifyProducts: ProductWithVariants[];
}

function variantLabel(variant: ProductVariant): string {
  return variant.selectedOptions.map((o) => `${o.name}: ${o.value}`).join(", ") || "—";
}

function describeInventoryValues(inv: ListingInventoryProduct): string {
  const values = inv.propertyValues.flatMap((pv) => pv.values);
  return values.length > 0 ? values.join("/") : "(no variation values)";
}

function describeVariantValues(variant: ProductVariant): string {
  const values = variant.selectedOptions.map((o) => o.value);
  return values.length > 0 ? values.join("/") : "(no options)";
}

/**
 * Explains why matchInventoryToVariants couldn't find an unambiguous 1:1 mapping, showing the
 * actual values on both sides — a bare "don't line up" message with matching counts (e.g. 4
 * and 4) gives no clue that the real problem is a text mismatch (Shopify "S/M/L/XL" vs Etsy
 * "Small/Medium/Large/X-Large"), which is the far more common cause once counts already agree.
 */
function describeMismatch(inventory: ListingInventoryProduct[], variants: ProductVariant[]): string {
  const etsySide = inventory.map(describeInventoryValues).join(", ");
  const shopifySide = variants.map(describeVariantValues).join(", ");
  if (inventory.length !== variants.length) {
    return `Shopify has ${variants.length} variant(s) (${shopifySide}) but this Etsy listing has ${inventory.length} variation(s) (${etsySide}) — counts don't match, skipped.`;
  }
  return `Couldn't match Etsy's variation values (${etsySide}) to Shopify's variant options (${shopifySide}) by exact text — skipped rather than guess which SKU goes where. Check for wording differences (e.g. abbreviations, spelling, extra words).`;
}

function exactKey(raw: string): string {
  return raw.toLowerCase().trim();
}

/**
 * Strips off numbers/measurements and anything in parentheses to get a coarse label — e.g.
 * `Small (30" - 32")` and `Small - 30 - 32 Inches (76 - 81cm)` both reduce to "small". Used as
 * a looser second-pass match for when Etsy and Shopify describe the same size/color with
 * different wording but still share a recognizable leading label. Returns "" for values with
 * no such leading word (e.g. a bare "30"), which valueSetsMatch treats as never matching —
 * this pass only ever helps, it can't turn a real mismatch into a false one.
 */
function looseKey(raw: string): string {
  return (raw.split(/[\d(]/)[0] ?? "").replace(/[-\s]+$/, "").trim().toLowerCase();
}

function inventoryValueSet(inv: ListingInventoryProduct, keyFn: (raw: string) => string): string[] {
  return inv.propertyValues.flatMap((pv) => pv.values.map(keyFn));
}

function variantValueSet(variant: ProductVariant, keyFn: (raw: string) => string): string[] {
  return variant.selectedOptions.map((o) => keyFn(o.value));
}

function valueSetsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  if (a.some((v) => !v) || b.some((v) => !v)) return false; // empty key never counts as a match
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Finds a 1:1 pairing between every Etsy inventory product and a Shopify variant, using
 * `keyFn` to compare their variation values. Returns null the moment any product doesn't have
 * exactly one candidate — ambiguity (0 or 2+ matches) is never resolved by guessing, since a
 * wrong guess would silently scramble which SKU lands on which variant.
 */
function matchByKey(
  inventory: ListingInventoryProduct[],
  variants: ProductVariant[],
  keyFn: (raw: string) => string
): Map<number, ProductVariant> | null {
  const result = new Map<number, ProductVariant>();
  const usedVariantIndexes = new Set<number>();
  for (const inv of inventory) {
    const invValues = inventoryValueSet(inv, keyFn);
    const candidates = variants
      .map((v, i) => ({ v, i }))
      .filter(({ v, i }) => !usedVariantIndexes.has(i) && valueSetsMatch(invValues, variantValueSet(v, keyFn)));
    if (candidates.length !== 1) return null;
    result.set(inv.productId, candidates[0]!.v);
    usedVariantIndexes.add(candidates[0]!.i);
  }
  return result;
}

/**
 * Matches each Etsy inventory product (one per variation combo, or a single one for a listing
 * with no variations) to the Shopify variant it corresponds to. Matches by variation property
 * values rather than SKU, since the SKU is exactly what's being changed and so can't be used to
 * find its own match. Tries an exact text match first, then falls back to a coarser label match
 * for when the two platforms word the same size/color differently (see `looseKey`) — either way,
 * only ever returns a mapping when it's an unambiguous 1:1 bijection; anything less certain
 * returns null so callers never guess.
 */
function matchInventoryToVariants(
  inventory: ListingInventoryProduct[],
  variants: ProductVariant[]
): Map<number, ProductVariant> | null {
  if (inventory.length === 1 && variants.length === 1) {
    return new Map([[inventory[0].productId, variants[0]]]);
  }
  if (inventory.length !== variants.length) return null;

  return matchByKey(inventory, variants, exactKey) ?? matchByKey(inventory, variants, looseKey);
}

function buildDiffs(inventory: ListingInventoryProduct[], mapping: Map<number, ProductVariant>): SkuDiff[] {
  return inventory.map((inv) => {
    const variant = mapping.get(inv.productId)!;
    const newSku = variant.sku ?? "";
    return {
      productId: inv.productId,
      variantLabel: variantLabel(variant),
      currentSku: inv.sku,
      newSku,
      // A Shopify variant with no SKU of its own is never pushed — there's nothing to sync it to.
      changed: newSku !== "" && newSku !== (inv.sku ?? ""),
    };
  });
}

/**
 * Compares every active/draft Etsy listing's SKU(s) against the Shopify product it's matched
 * to, and reports what would change. Matching precedence: an explicit link recorded by this
 * app (e.g. from "List to Etsy", or a previously confirmed match here) wins; otherwise an exact
 * (case-insensitive) title match is offered as a suggestion only, never applied automatically.
 *
 * Pass `onlyListingId` to analyze a single listing cheaply (used by the push routes to
 * re-verify right before writing, instead of trusting a stale value from a submitted form).
 * Pass `forceRefresh` to bypass both the Shopify product cache and the Etsy inventory cache —
 * the push routes use this so a write is never based on stale pre-cache-expiry data.
 */
export async function analyzeEtsySkuSync(
  shopId: string,
  onlyListingId?: number,
  forceRefresh = false
): Promise<SyncAnalysis> {
  const [activeListings, draftListings, shopifyProducts, links] = await Promise.all([
    getListingsByState(shopId, "active"),
    getListingsByState(shopId, "draft"),
    listProductsWithVariants({ forceRefresh }),
    Promise.resolve(listEtsyListingLinks()),
  ]);
  const listings = (
    onlyListingId
      ? [...activeListings, ...draftListings].filter((l) => l.listingId === onlyListingId)
      : [...activeListings, ...draftListings]
  );

  const linkedListingToProduct = new Map(links.map((l) => [l.etsyListingId, l.shopifyProductId]));
  const productById = new Map(shopifyProducts.map((p) => [p.id, p]));
  const productByTitleLower = new Map(shopifyProducts.map((p) => [p.title.toLowerCase().trim(), p]));

  // One Etsy inventory GET per listing — fetched with bounded concurrency instead of a
  // sequential loop, since with N listings a serial version means N round trips of Etsy
  // latency stacked up back-to-back.
  const inventoryByListing = await mapWithConcurrency(listings, INVENTORY_FETCH_CONCURRENCY, (listing) =>
    getListingInventory(listing.listingId, { forceRefresh })
  );

  const statuses: ListingSyncStatus[] = [];

  listings.forEach((listing, listingIndex) => {
    const linkedProductId = linkedListingToProduct.get(String(listing.listingId));
    let matchStatus: MatchStatus;
    let matchedProduct: ProductWithVariants | undefined;

    if (linkedProductId) {
      matchedProduct = productById.get(linkedProductId);
      matchStatus = matchedProduct ? "linked" : "unmatched";
    } else {
      matchedProduct = productByTitleLower.get(listing.title.toLowerCase().trim());
      matchStatus = matchedProduct ? "suggested" : "unmatched";
    }

    const inventory = inventoryByListing[listingIndex]!;
    const currentSkus = inventory.map((p) => p.sku).filter((sku): sku is string => Boolean(sku));

    if (!matchedProduct) {
      statuses.push({
        listingId: listing.listingId,
        listingTitle: listing.title,
        listingState: listing.state,
        matchStatus: "unmatched",
        matchedProductId: null,
        matchedProductTitle: null,
        currentSkus,
        diffs: [],
        warning: null,
      });
      return;
    }

    const mapping = matchInventoryToVariants(inventory, matchedProduct.variants);

    if (!mapping) {
      statuses.push({
        listingId: listing.listingId,
        listingTitle: listing.title,
        listingState: listing.state,
        matchStatus: matchStatus === "linked" ? "linked" : "ambiguous",
        matchedProductId: matchedProduct.id,
        matchedProductTitle: matchedProduct.title,
        currentSkus,
        diffs: [],
        warning: describeMismatch(inventory, matchedProduct.variants),
      });
      return;
    }

    statuses.push({
      listingId: listing.listingId,
      listingTitle: listing.title,
      listingState: listing.state,
      matchStatus,
      matchedProductId: matchedProduct.id,
      matchedProductTitle: matchedProduct.title,
      currentSkus,
      diffs: buildDiffs(inventory, mapping),
      warning: null,
    });
  });

  return { statuses, shopifyProducts };
}

/**
 * Pushes only the changed SKU diffs for one already-analyzed listing. Returns the number of
 * SKUs actually pushed (0 if there was nothing to change — callers should treat that as a
 * no-op, not an error).
 */
export async function pushSkuDiffs(status: ListingSyncStatus): Promise<number> {
  const changed = status.diffs.filter((d) => d.changed);
  if (changed.length === 0) return 0;
  const skuByProductId = new Map(changed.map((d) => [d.productId, d.newSku]));
  await updateListingSkus(status.listingId, skuByProductId);
  return changed.length;
}
