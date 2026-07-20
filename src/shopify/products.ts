import { shopifyGraphql } from "./apiClient.js";

export interface ProductSummary {
  id: string;
  title: string;
  imageUrl: string | null;
  price: string;
  sku: string | null;
  totalInventory: number;
}

const LIST_QUERY = /* GraphQL */ `
  query ListProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        totalInventory
        featuredImage {
          url
        }
        variants(first: 1) {
          nodes {
            sku
            price
          }
        }
      }
    }
  }
`;

interface ListProductsResult {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      title: string;
      totalInventory: number;
      featuredImage: { url: string } | null;
      variants: { nodes: Array<{ sku: string | null; price: string }> };
    }>;
  };
}

const MAX_PRODUCTS = 250;

// A full catalog listing takes several sequential paginated round trips to Shopify — worth
// caching briefly so navigating between pages (or reloading the same one) doesn't re-pay that
// cost every time. Short enough that a product edited in Shopify shows up again quickly.
const LIST_CACHE_TTL_MS = 2 * 60 * 1000;
let listProductsCache: { entries: ProductSummary[]; cachedAt: number } | undefined;

/** Lists Shopify products for the product picker, using the first variant's price/SKU as a default. */
export async function listProducts(): Promise<ProductSummary[]> {
  if (listProductsCache && Date.now() - listProductsCache.cachedAt < LIST_CACHE_TTL_MS) {
    return listProductsCache.entries;
  }

  const products: ProductSummary[] = [];
  let cursor: string | undefined;

  for (;;) {
    const data = await shopifyGraphql<ListProductsResult>(LIST_QUERY, { cursor });
    for (const node of data.products.nodes) {
      const firstVariant = node.variants.nodes[0];
      products.push({
        id: node.id,
        title: node.title,
        imageUrl: node.featuredImage?.url ?? null,
        price: firstVariant?.price ?? "0.00",
        sku: firstVariant?.sku ?? null,
        totalInventory: node.totalInventory,
      });
    }
    if (!data.products.pageInfo.hasNextPage || products.length >= MAX_PRODUCTS) break;
    cursor = data.products.pageInfo.endCursor ?? undefined;
  }

  listProductsCache = { entries: products, cachedAt: Date.now() };
  return products;
}

export interface ProductWithVariants {
  id: string;
  title: string;
  variants: ProductVariant[];
}

const LIST_WITH_VARIANTS_QUERY = /* GraphQL */ `
  query ListProductsWithVariants($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        variants(first: 100) {
          nodes {
            id
            sku
            price
            inventoryQuantity
            selectedOptions {
              name
              value
            }
          }
        }
      }
    }
  }
`;

interface ListProductsWithVariantsResult {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; title: string; variants: { nodes: ProductVariant[] } }>;
  };
}

// Short TTL, not the 2 minutes used for the plain product picker: this feeds the SKU-sync
// diff that gets written back to Etsy, so staleness has a real correctness cost, not just a
// display lag. Callers about to write (see `forceRefresh`) bypass this entirely.
const WITH_VARIANTS_CACHE_TTL_MS = 60 * 1000;
let listProductsWithVariantsCache: { entries: ProductWithVariants[]; cachedAt: number } | undefined;

/**
 * Lists every Shopify product with all of its variants (SKU + selected options), for matching
 * against Etsy listings by variant identity rather than just a single SKU — needed because a
 * SKU that just changed in Shopify can't be used to find its own match.
 */
export async function listProductsWithVariants(options?: { forceRefresh?: boolean }): Promise<ProductWithVariants[]> {
  if (
    !options?.forceRefresh &&
    listProductsWithVariantsCache &&
    Date.now() - listProductsWithVariantsCache.cachedAt < WITH_VARIANTS_CACHE_TTL_MS
  ) {
    return listProductsWithVariantsCache.entries;
  }

  const products: ProductWithVariants[] = [];
  let cursor: string | undefined;

  for (;;) {
    const data = await shopifyGraphql<ListProductsWithVariantsResult>(LIST_WITH_VARIANTS_QUERY, { cursor });
    for (const node of data.products.nodes) {
      products.push({ id: node.id, title: node.title, variants: node.variants.nodes });
    }
    if (!data.products.pageInfo.hasNextPage || products.length >= MAX_PRODUCTS) break;
    cursor = data.products.pageInfo.endCursor ?? undefined;
  }

  listProductsWithVariantsCache = { entries: products, cachedAt: Date.now() };
  return products;
}

export interface ProductVariant {
  id: string;
  sku: string | null;
  price: string;
  inventoryQuantity: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

export interface ProductOption {
  name: string;
  values: string[];
}

export interface ProductDetail {
  id: string;
  title: string;
  descriptionHtml: string;
  price: string;
  sku: string | null;
  totalInventory: number;
  imageUrls: string[];
  options: ProductOption[];
  variants: ProductVariant[];
}

const DETAIL_QUERY = /* GraphQL */ `
  query GetProductDetail($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      totalInventory
      images(first: 10) {
        nodes {
          url
        }
      }
      options {
        name
        values
      }
      variants(first: 100) {
        nodes {
          id
          sku
          price
          inventoryQuantity
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

interface GetProductDetailResult {
  product: {
    id: string;
    title: string;
    descriptionHtml: string;
    totalInventory: number;
    images: { nodes: Array<{ url: string }> };
    options: ProductOption[];
    variants: { nodes: ProductVariant[] };
  } | null;
}

export async function getProductDetail(id: string): Promise<ProductDetail | null> {
  const data = await shopifyGraphql<GetProductDetailResult>(DETAIL_QUERY, { id });
  if (!data.product) return null;
  const firstVariant = data.product.variants.nodes[0];
  return {
    id: data.product.id,
    title: data.product.title,
    descriptionHtml: data.product.descriptionHtml,
    price: firstVariant?.price ?? "0.00",
    sku: firstVariant?.sku ?? null,
    totalInventory: data.product.totalInventory,
    imageUrls: data.product.images.nodes.map((n) => n.url),
    options: data.product.options,
    variants: data.product.variants.nodes,
  };
}
