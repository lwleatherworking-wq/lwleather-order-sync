import { requireEtsyCredentials } from "../config/effectiveConfig.js";
import { getEtsyTokens, saveEtsyTokens } from "../db/tokenStore.js";
import { refreshEtsyTokens } from "./oauthClient.js";
import { logger } from "../logger.js";

const API_BASE = "https://api.etsy.com/v3";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh if within 5 min of expiry

/**
 * Caps outbound Etsy requests to a steady rate, shared across every caller in this process
 * (a page load's parallel inventory fetches, the background order-sync scheduler, concurrent
 * requests from multiple browser tabs — anything). Etsy's per-second limit is enforced
 * regardless of which part of the app is calling, so throttling has to live here rather than
 * in any one caller's concurrency setting; a caller-side limit alone can't see requests other
 * callers are making at the same time.
 */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const shortfall = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((shortfall / this.refillPerSecond) * 1000));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Etsy's documented default is 10 requests/second; staying just under that (rather than the
// far more conservative 5/sec this started at) still leaves headroom for the background sync
// scheduler and concurrent page loads, while cutting page-load time roughly in half.
const etsyRateLimiter = new TokenBucket(8, 8);

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
  const { clientId, clientSecret } = requireEtsyCredentials();
  return `${clientId}:${clientSecret}`;
}

export async function etsyFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  await etsyRateLimiter.acquire();
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "x-api-key": await apiKeyHeader(),
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (res.status === 429 && attempt < 5) {
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
