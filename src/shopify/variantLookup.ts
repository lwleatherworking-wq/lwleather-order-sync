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
