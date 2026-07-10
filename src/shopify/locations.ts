import { shopifyGraphql } from "./apiClient.js";

// Deliberately requests only "id" — "name" requires the separate read_locations scope,
// which this app doesn't otherwise need, and we never use the location's name for anything.
const QUERY = /* GraphQL */ `
  query PrimaryLocation {
    locations(first: 1, query: "fulfills_online_orders:true") {
      nodes {
        id
      }
    }
  }
`;

interface LocationsResult {
  locations: { nodes: Array<{ id: string }> };
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
