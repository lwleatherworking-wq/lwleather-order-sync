import { shopifyGraphql } from "./apiClient.js";

const QUERY = /* GraphQL */ `
  query PrimaryLocation {
    locations(first: 1, query: "fulfills_online_orders:true") {
      nodes {
        id
        name
      }
    }
  }
`;

interface LocationsResult {
  locations: { nodes: Array<{ id: string; name: string }> };
}

let cachedLocationId: string | undefined;

/** Resolves and caches the shop's primary fulfillment location id, used for inventory adjustments. */
export async function getPrimaryLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId;
  const data = await shopifyGraphql<LocationsResult>(QUERY);
  const location = data.locations.nodes[0];
  if (!location) {
    throw new Error("No fulfillment-capable location found on this Shopify store");
  }
  cachedLocationId = location.id;
  return cachedLocationId;
}
