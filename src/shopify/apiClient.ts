import { getEnv } from "../config/env.js";
import { logger } from "../logger.js";

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      throttleStatus?: { currentlyAvailable: number; restoreRate: number };
    };
  };
}

interface ClientCredentialsResponse {
  access_token: string;
  scope: string;
  expires_in: number;
}

// In-memory only: unlike Etsy's OAuth, Shopify's client credentials grant needs no user
// interaction to refresh — the client id/secret in env are enough to silently re-request
// a token at any time, so there's nothing worth persisting across restarts.
let cachedToken: { accessToken: string; expiresAt: number } | undefined;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Custom apps created via Shopify's Dev Dashboard no longer expose a static Admin API
 * access token in the UI. Instead, the app's client id/secret are exchanged for a
 * short-lived (24h) access token via the OAuth client credentials grant, which must be
 * refreshed periodically — this mirrors the Etsy token refresh pattern.
 */
async function getValidShopifyAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - REFRESH_MARGIN_MS) {
    return cachedToken.accessToken;
  }

  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = getEnv();
  const res = await fetch(`https://${SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify client credentials grant failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as ClientCredentialsResponse;
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  logger.info("Refreshed Shopify access token", { expiresInSeconds: data.expires_in });
  return cachedToken.accessToken;
}

/**
 * Executes a Shopify Admin GraphQL request, retrying once on cost-based throttling
 * (HTTP 200 with a THROTTLED error) or transient 429/5xx responses.
 */
export async function shopifyGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  attempt = 0
): Promise<T> {
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_API_VERSION } = getEnv();
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const accessToken = await getValidShopifyAccessToken();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    const delayMs = 500 * 2 ** attempt;
    logger.warn("Shopify API transient error, retrying", { status: res.status, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return shopifyGraphql<T>(query, variables, attempt + 1);
  }

  const body = (await res.json()) as GraphqlResponse<T>;

  const isThrottled = body.errors?.some((e) => e.message.toUpperCase().includes("THROTTLED"));
  if (isThrottled && attempt < 3) {
    const throttle = body.extensions?.cost?.throttleStatus;
    const waitMs = throttle ? Math.ceil((50 / (throttle.restoreRate || 1)) * 1000) : 1000;
    logger.warn("Shopify GraphQL cost throttled, retrying", { waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return shopifyGraphql<T>(query, variables, attempt + 1);
  }

  if (!res.ok || body.errors) {
    throw new Error(
      `Shopify GraphQL request failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`
    );
  }
  if (!body.data) {
    throw new Error("Shopify GraphQL response had no data");
  }
  return body.data;
}

/** Throws if a mutation payload's userErrors array is non-empty; otherwise returns the payload. */
export function assertNoUserErrors<T extends { userErrors: Array<{ field?: string[] | null; message: string }> }>(
  payload: T,
  mutationName: string
): T {
  if (payload.userErrors.length > 0) {
    throw new Error(`${mutationName} returned userErrors: ${JSON.stringify(payload.userErrors)}`);
  }
  return payload;
}
