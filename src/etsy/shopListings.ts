import { etsyFetch } from "./apiClient.js";

export interface ShippingProfile {
  shippingProfileId: number;
  title: string;
}

interface ShopShippingProfilesResponse {
  results: Array<{ shipping_profile_id: number; title: string; is_deleted: boolean }>;
}

export async function getShippingProfiles(shopId: string): Promise<ShippingProfile[]> {
  const res = await etsyFetch(`/application/shops/${shopId}/shipping-profiles`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy shipping profiles (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ShopShippingProfilesResponse;
  return data.results
    .filter((p) => !p.is_deleted)
    .map((p) => ({ shippingProfileId: p.shipping_profile_id, title: p.title }));
}

export interface ReadinessStateDefinition {
  readinessStateDefinitionId: number;
  label: string;
}

interface ShopReadinessStateDefinitionsResponse {
  results: Array<{
    readiness_state_id: number;
    readiness_state: "ready_to_ship" | "made_to_order";
    min_processing_days: number;
    max_processing_days: number;
    processing_days_display_label: string;
  }>;
}

/** Etsy calls these "processing profiles" in its UI; required on every physical listing offering. */
export async function getReadinessStateDefinitions(shopId: string): Promise<ReadinessStateDefinition[]> {
  const res = await etsyFetch(`/application/shops/${shopId}/readiness-state-definitions?limit=100`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy processing profiles (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ShopReadinessStateDefinitionsResponse;
  return data.results.map((p) => ({
    readinessStateDefinitionId: p.readiness_state_id,
    label: `${p.readiness_state === "ready_to_ship" ? "Ready to ship" : "Made to order"} — ${p.processing_days_display_label}`,
  }));
}

export interface TaxonomyOption {
  id: number;
  fullPath: string;
}

interface SellerTaxonomyNode {
  id: number;
  level: number;
  name: string;
  children: SellerTaxonomyNode[];
}

interface SellerTaxonomyNodesResponse {
  results: SellerTaxonomyNode[];
}

function flattenTaxonomy(nodes: SellerTaxonomyNode[], parentPath: string, out: TaxonomyOption[]): void {
  for (const node of nodes) {
    const fullPath = parentPath ? `${parentPath} > ${node.name}` : node.name;
    out.push({ id: node.id, fullPath });
    if (node.children.length > 0) flattenTaxonomy(node.children, fullPath, out);
  }
}

// Etsy's taxonomy tree almost never changes, so this is worth caching for a long time.
const TAXONOMY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let taxonomyCache: { options: TaxonomyOption[]; cachedAt: number } | undefined;

export async function getSellerTaxonomyOptions(): Promise<TaxonomyOption[]> {
  if (taxonomyCache && Date.now() - taxonomyCache.cachedAt < TAXONOMY_CACHE_TTL_MS) {
    return taxonomyCache.options;
  }
  const res = await etsyFetch(`/application/seller-taxonomy/nodes`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy seller taxonomy (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as SellerTaxonomyNodesResponse;
  const options: TaxonomyOption[] = [];
  flattenTaxonomy(data.results, "", options);
  options.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  taxonomyCache = { options, cachedAt: Date.now() };
  return options;
}

export interface VariationPropertyValue {
  valueId: number | null;
  name: string;
}

export interface VariationProperty {
  propertyId: number;
  name: string;
  displayName: string;
  possibleValues: VariationPropertyValue[];
}

interface TaxonomyNodePropertiesResponse {
  results: Array<{
    property_id: number;
    name: string;
    display_name: string;
    supports_variations: boolean;
    possible_values: Array<{ value_id: number | null; name: string }> | null;
  }>;
}

/** The set of properties (e.g. Size, Color) a given taxonomy category supports as listing variations. */
export async function getVariationProperties(taxonomyId: number): Promise<VariationProperty[]> {
  const res = await etsyFetch(`/application/seller-taxonomy/nodes/${taxonomyId}/properties`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy taxonomy properties (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as TaxonomyNodePropertiesResponse;
  return data.results
    .filter((p) => p.supports_variations)
    .map((p) => ({
      propertyId: p.property_id,
      name: p.name,
      displayName: p.display_name,
      possibleValues: (p.possible_values ?? []).map((v) => ({ valueId: v.value_id, name: v.name })),
    }));
}

export interface DraftListingInput {
  title: string;
  description: string;
  price: number;
  quantity: number;
  whoMade: "i_did" | "someone_else" | "collective";
  whenMade: string;
  taxonomyId: number;
  isSupply: boolean;
  shippingProfileId?: number;
  readinessStateId: number;
}

interface CreateListingResponse {
  listing_id: number;
}

/** Creates a draft (not yet published) Etsy listing. Requires the listings_w scope. */
export async function createDraftListing(shopId: string, input: DraftListingInput): Promise<{ listingId: number }> {
  const body = new URLSearchParams({
    quantity: String(input.quantity),
    title: input.title,
    description: input.description,
    price: String(input.price),
    who_made: input.whoMade,
    when_made: input.whenMade,
    taxonomy_id: String(input.taxonomyId),
    is_supply: String(input.isSupply),
    readiness_state_id: String(input.readinessStateId),
  });
  if (input.shippingProfileId) {
    body.set("shipping_profile_id", String(input.shippingProfileId));
  }

  const res = await etsyFetch(`/application/shops/${shopId}/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to create Etsy draft listing (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as CreateListingResponse;
  return { listingId: data.listing_id };
}

interface ListingInventoryGetResponse {
  products: Array<{
    is_deleted: boolean;
    offerings: Array<{
      quantity: number;
      is_enabled: boolean;
      is_deleted: boolean;
      price: { amount: number; divisor: number };
      readiness_state_id: number | null;
    }>;
  }>;
}

/**
 * Sets the SKU on a listing's (first, non-deleted) product, preserving its existing offerings.
 * Used to push a Shopify SKU onto a newly created Etsy draft listing so the two already match —
 * Etsy's listing-creation endpoint has no `sku` field, so this requires a separate inventory call.
 */
export async function setListingSku(listingId: number, sku: string): Promise<void> {
  const getRes = await etsyFetch(`/application/listings/${listingId}/inventory`);
  if (!getRes.ok) {
    throw new Error(`Failed to fetch Etsy listing inventory ${listingId} (${getRes.status}): ${await getRes.text()}`);
  }
  const data = (await getRes.json()) as ListingInventoryGetResponse;
  const product = data.products.find((p) => !p.is_deleted);
  if (!product) {
    throw new Error(`Etsy listing ${listingId} has no inventory product to set a SKU on`);
  }

  const putBody = {
    products: [
      {
        sku,
        offerings: product.offerings
          .filter((o) => !o.is_deleted)
          .map((o) => ({
            quantity: o.quantity,
            is_enabled: o.is_enabled,
            price: o.price.amount / o.price.divisor,
            readiness_state_id: o.readiness_state_id ?? undefined,
          })),
      },
    ],
  };

  const putRes = await etsyFetch(`/application/listings/${listingId}/inventory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putRes.ok) {
    throw new Error(`Failed to set Etsy listing SKU on ${listingId} (${putRes.status}): ${await putRes.text()}`);
  }
}

export interface ListingInventoryProduct {
  productId: number;
  sku: string | null;
  propertyValues: Array<{ propertyId: number; propertyName: string; valueIds: number[]; values: string[] }>;
  offerings: Array<{ quantity: number; isEnabled: boolean; price: number; readinessStateId: number | null }>;
}

interface RawListingInventoryResponse {
  products: Array<{
    product_id: number;
    sku: string | null;
    is_deleted: boolean;
    property_values: Array<{ property_id: number; property_name: string; value_ids: number[]; values: string[] }>;
    offerings: Array<{
      quantity: number;
      is_enabled: boolean;
      is_deleted: boolean;
      price: { amount: number; divisor: number };
      readiness_state_id: number | null;
    }>;
  }>;
  // Which variation property (e.g. Size) each of price/quantity/sku is allowed to differ
  // across — if a PUT omits these, Etsy assumes none of them vary and then rejects the
  // request as soon as two products in the payload actually have different values.
  price_on_property: number[];
  quantity_on_property: number[];
  sku_on_property: number[];
}

interface InventorySnapshot {
  products: ListingInventoryProduct[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
}

// Both /sku-linking and /sync-skus-to-etsy independently need "every listing's inventory"
// and previously each re-fetched it from scratch — this cache lets a page visited shortly
// after another one reuse those calls instead of repeating the exact same Etsy requests.
// Short enough that a manual edit on Etsy shows up again quickly; the SKU-push path bypasses
// it entirely via `forceRefresh` since a write must never be based on stale inventory.
const INVENTORY_CACHE_TTL_MS = 3 * 60 * 1000;
const inventoryCache = new Map<number, { snapshot: InventorySnapshot; cachedAt: number }>();

async function fetchListingInventorySnapshot(listingId: number): Promise<InventorySnapshot> {
  const res = await etsyFetch(`/application/listings/${listingId}/inventory`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy listing inventory ${listingId} (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as RawListingInventoryResponse;
  const products = data.products
    .filter((p) => !p.is_deleted)
    .map((p) => ({
      productId: p.product_id,
      sku: p.sku,
      propertyValues: p.property_values.map((pv) => ({
        propertyId: pv.property_id,
        propertyName: pv.property_name,
        valueIds: pv.value_ids,
        values: pv.values,
      })),
      offerings: p.offerings
        .filter((o) => !o.is_deleted)
        .map((o) => ({
          quantity: o.quantity,
          isEnabled: o.is_enabled,
          price: o.price.amount / o.price.divisor,
          readinessStateId: o.readiness_state_id,
        })),
    }));

  return {
    products,
    priceOnProperty: data.price_on_property ?? [],
    quantityOnProperty: data.quantity_on_property ?? [],
    skuOnProperty: data.sku_on_property ?? [],
  };
}

async function getListingInventorySnapshot(
  listingId: number,
  options?: { forceRefresh?: boolean }
): Promise<InventorySnapshot> {
  if (!options?.forceRefresh) {
    const cached = inventoryCache.get(listingId);
    if (cached && Date.now() - cached.cachedAt < INVENTORY_CACHE_TTL_MS) {
      return cached.snapshot;
    }
  }
  const snapshot = await fetchListingInventorySnapshot(listingId);
  inventoryCache.set(listingId, { snapshot, cachedAt: Date.now() });
  return snapshot;
}

/**
 * Fetches a listing's full inventory (non-deleted products only), including SKU, variation
 * property values, and offerings. Used to compute SKU diffs against Shopify without needing
 * to know or reconstruct anything else about the listing.
 */
export async function getListingInventory(
  listingId: number,
  options?: { forceRefresh?: boolean }
): Promise<ListingInventoryProduct[]> {
  const snapshot = await getListingInventorySnapshot(listingId, options);
  return snapshot.products;
}

/**
 * Pushes new SKUs onto specific inventory products of an *existing* listing, keyed by Etsy's
 * own product_id, preserving every other field (property values, offerings, price, quantity,
 * and which property each of those is allowed to vary by) exactly as Etsy currently has them.
 * Products not present in `skuByProductId` keep their current SKU untouched. Used to re-sync
 * SKUs after they've changed in Shopify, as opposed to setListingSku which only ever runs
 * once, right after a brand-new draft is created.
 */
export async function updateListingSkus(listingId: number, skuByProductId: Map<number, string>): Promise<void> {
  const { products, priceOnProperty, quantityOnProperty, skuOnProperty } = await getListingInventorySnapshot(
    listingId,
    { forceRefresh: true }
  );
  const putBody = {
    products: products.map((p) => ({
      sku: skuByProductId.get(p.productId) ?? p.sku ?? undefined,
      property_values: p.propertyValues.map((pv) => ({
        property_id: pv.propertyId,
        property_name: pv.propertyName,
        value_ids: pv.valueIds,
        values: pv.values,
      })),
      offerings: p.offerings.map((o) => ({
        quantity: o.quantity,
        is_enabled: o.isEnabled,
        price: o.price,
        readiness_state_id: o.readinessStateId ?? undefined,
      })),
    })),
    price_on_property: priceOnProperty,
    quantity_on_property: quantityOnProperty,
    sku_on_property: skuOnProperty,
  };

  const res = await etsyFetch(`/application/listings/${listingId}/inventory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!res.ok) {
    throw new Error(`Failed to update Etsy listing SKUs on ${listingId} (${res.status}): ${await res.text()}`);
  }
  // Otherwise a page reload right after pushing would still show the pre-push SKU for up
  // to INVENTORY_CACHE_TTL_MS, since the cache was populated by the read a moment ago.
  inventoryCache.delete(listingId);
}

export interface VariationProductInput {
  sku: string | null;
  price: number;
  quantity: number;
  propertyValues: Array<{
    propertyId: number;
    propertyName: string;
    valueIds: number[];
    values: string[];
  }>;
}

/**
 * Replaces a listing's inventory with one product per Shopify variant, each carrying its own
 * SKU/price/quantity and the Etsy property values (e.g. Size: Medium) mapped for it. Used instead
 * of setListingSku when a Shopify product has more than one variant.
 */
export async function setListingVariations(
  listingId: number,
  products: VariationProductInput[],
  readinessStateId: number
): Promise<void> {
  const putBody = {
    products: products.map((p) => ({
      sku: p.sku ?? undefined,
      property_values: p.propertyValues.map((pv) => ({
        property_id: pv.propertyId,
        property_name: pv.propertyName,
        value_ids: pv.valueIds,
        values: pv.values,
      })),
      offerings: [
        {
          quantity: p.quantity,
          is_enabled: true,
          price: p.price,
          readiness_state_id: readinessStateId,
        },
      ],
    })),
  };

  const res = await etsyFetch(`/application/listings/${listingId}/inventory`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!res.ok) {
    throw new Error(`Failed to set Etsy listing variations on ${listingId} (${res.status}): ${await res.text()}`);
  }
}

interface UploadListingImageResponse {
  listing_image_id: number;
}

/** Uploads one image to a listing. Etsy only accepts JPEG/PNG/GIF — callers must convert other formats first. */
export async function uploadListingImage(
  shopId: string,
  listingId: number,
  image: { data: Buffer; filename: string },
  rank: number
): Promise<{ listingImageId: number }> {
  const form = new FormData();
  form.append("image", new Blob([image.data], { type: "image/jpeg" }), image.filename);
  form.append("rank", String(rank));

  const res = await etsyFetch(`/application/shops/${shopId}/listings/${listingId}/images`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Failed to upload Etsy listing image (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as UploadListingImageResponse;
  return { listingImageId: data.listing_image_id };
}
