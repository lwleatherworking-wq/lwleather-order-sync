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
