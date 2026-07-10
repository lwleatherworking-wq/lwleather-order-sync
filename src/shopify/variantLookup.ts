import { shopifyGraphql } from "./apiClient.js";

const QUERY = /* GraphQL */ `
  query VariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes {
        id
        sku
        inventoryItem {
          id
        }
      }
    }
  }
`;

interface VariantsResult {
  productVariants: {
    nodes: Array<{ id: string; sku: string | null; inventoryItem: { id: string } }>;
  };
}

export interface ResolvedVariant {
  variantId: string;
  inventoryItemId: string;
  sku: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { variant: ResolvedVariant | null; cachedAt: number }>();

/** Looks up a Shopify product variant by exact SKU match, caching results briefly per sync run. */
export async function findVariantBySku(sku: string): Promise<ResolvedVariant | null> {
  const cached = cache.get(sku);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.variant;
  }

  // Quote the SKU so special characters don't break Shopify's search query syntax.
  const escaped = sku.replace(/"/g, '\\"');
  const data = await shopifyGraphql<VariantsResult>(QUERY, { query: `sku:"${escaped}"` });
  const node = data.productVariants.nodes[0];
  const variant: ResolvedVariant | null = node
    ? { variantId: node.id, inventoryItemId: node.inventoryItem.id, sku: node.sku ?? sku }
    : null;

  cache.set(sku, { variant, cachedAt: Date.now() });
  return variant;
}

const LIST_QUERY = /* GraphQL */ `
  query ListSkus($cursor: String) {
    productVariants(first: 100, after: $cursor, query: "sku:*") {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        sku
        displayName
      }
    }
  }
`;

interface ListSkusResult {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ sku: string | null; displayName: string }>;
  };
}

export interface ShopifySkuEntry {
  sku: string;
  displayName: string;
}

const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SKUS = 500; // sane upper bound for a single small-shop catalog
let listCache: { entries: ShopifySkuEntry[]; cachedAt: number } | undefined;

/** All Shopify variants that have a SKU set, for reference when creating a manual SKU link. */
export async function listShopifySkus(): Promise<ShopifySkuEntry[]> {
  if (listCache && Date.now() - listCache.cachedAt < LIST_CACHE_TTL_MS) {
    return listCache.entries;
  }

  const entries: ShopifySkuEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const data = await shopifyGraphql<ListSkusResult>(LIST_QUERY, { cursor });
    for (const node of data.productVariants.nodes) {
      if (node.sku) entries.push({ sku: node.sku, displayName: node.displayName });
    }
    if (!data.productVariants.pageInfo.hasNextPage || entries.length >= MAX_SKUS) break;
    cursor = data.productVariants.pageInfo.endCursor ?? undefined;
  }

  entries.sort((a, b) => a.sku.localeCompare(b.sku));
  listCache = { entries, cachedAt: Date.now() };
  return entries;
}
