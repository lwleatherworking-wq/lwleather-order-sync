import { getEnv } from "../config/env.js";
import { getEtsyTokens, saveEtsyTokens } from "../db/tokenStore.js";
import { refreshEtsyTokens } from "./oauthClient.js";
import { logger } from "../logger.js";

const API_BASE = "https://api.etsy.com/v3";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh if within 5 min of expiry

async function getValidAccessToken(): Promise<string> {
  const tokens = getEtsyTokens();
  if (!tokens) {
    throw new Error(
      "No Etsy OAuth tokens stored yet. Visit /oauth/etsy/start on this service to authorize."
    );
  }
  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return tokens.accessToken;
  }
  logger.info("Refreshing Etsy access token");
  const refreshed = await refreshEtsyTokens(tokens.refreshToken);
  saveEtsyTokens({
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  });
  return refreshed.access_token;
}

/** Every Etsy v3 request needs x-api-key: "<keystring>:<shared_secret>" plus a bearer token. */
async function apiKeyHeader(): Promise<string> {
  const { ETSY_CLIENT_ID, ETSY_CLIENT_SECRET } = getEnv();
  return `${ETSY_CLIENT_ID}:${ETSY_CLIENT_SECRET}`;
}

export async function etsyFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "x-api-key": await apiKeyHeader(),
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    logger.warn("Etsy rate limited, backing off", { retryAfterSeconds: retryAfter });
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return etsyFetch(path, init, attempt + 1);
  }

  return res;
}

export interface EtsySelf {
  user_id: number;
  shop_id: number;
}

/** GET /v3/application/users/me — used once during setup to discover the shop id. */
export async function fetchEtsySelf(): Promise<EtsySelf> {
  const res = await etsyFetch("/application/users/me");
  if (!res.ok) {
    throw new Error(`Failed to fetch Etsy user info (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as EtsySelf;
}
