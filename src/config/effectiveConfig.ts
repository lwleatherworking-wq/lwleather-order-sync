import { getEnv } from "./env.js";
import { getSetting, setSetting, deleteSetting } from "../db/settingsStore.js";

/**
 * Settings a user can change at runtime via the /setup page, without needing a
 * redeploy. Each maps to a DB key (checked first) with an env var fallback (checked
 * if nothing's been saved via /setup yet) — this is the same override pattern already
 * used for the Etsy shop id (see config/shopId.ts), generalized to the rest of the
 * app's configuration.
 */
const OVERRIDABLE_KEYS = {
  ETSY_CLIENT_ID: "etsy_client_id",
  ETSY_CLIENT_SECRET: "etsy_client_secret",
  SHOPIFY_STORE_DOMAIN: "shopify_store_domain",
  SHOPIFY_CLIENT_ID: "shopify_client_id",
  SHOPIFY_CLIENT_SECRET: "shopify_client_secret",
  PUBLIC_BASE_URL: "public_base_url",
  SYNC_INTERVAL_MINUTES: "sync_interval_minutes",
  DRY_RUN: "dry_run",
  BACKFILL_SINCE: "backfill_since",
} as const;

export type OverridableKey = keyof typeof OVERRIDABLE_KEYS;

export interface EffectiveConfig {
  ETSY_CLIENT_ID?: string;
  ETSY_CLIENT_SECRET?: string;
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  SYNC_INTERVAL_MINUTES: number;
  DRY_RUN: boolean;
  BACKFILL_SINCE?: string;
}

function overriddenString(key: OverridableKey, envValue: string | undefined): string | undefined {
  return getSetting(OVERRIDABLE_KEYS[key]) ?? envValue;
}

/** Resolves current effective config: DB overrides (from /setup) take precedence over env vars. */
export function getEffectiveConfig(): EffectiveConfig {
  const env = getEnv();
  const syncIntervalOverride = getSetting(OVERRIDABLE_KEYS.SYNC_INTERVAL_MINUTES);
  const dryRunOverride = getSetting(OVERRIDABLE_KEYS.DRY_RUN);

  return {
    ETSY_CLIENT_ID: overriddenString("ETSY_CLIENT_ID", env.ETSY_CLIENT_ID),
    ETSY_CLIENT_SECRET: overriddenString("ETSY_CLIENT_SECRET", env.ETSY_CLIENT_SECRET),
    SHOPIFY_STORE_DOMAIN: overriddenString("SHOPIFY_STORE_DOMAIN", env.SHOPIFY_STORE_DOMAIN),
    SHOPIFY_CLIENT_ID: overriddenString("SHOPIFY_CLIENT_ID", env.SHOPIFY_CLIENT_ID),
    SHOPIFY_CLIENT_SECRET: overriddenString("SHOPIFY_CLIENT_SECRET", env.SHOPIFY_CLIENT_SECRET),
    PUBLIC_BASE_URL: overriddenString("PUBLIC_BASE_URL", env.PUBLIC_BASE_URL),
    SYNC_INTERVAL_MINUTES: syncIntervalOverride ? Number(syncIntervalOverride) : env.SYNC_INTERVAL_MINUTES,
    DRY_RUN: dryRunOverride ? dryRunOverride === "true" : env.DRY_RUN,
    BACKFILL_SINCE: overriddenString("BACKFILL_SINCE", env.BACKFILL_SINCE),
  };
}

/** Saves a setting override to the DB, taking effect on the very next read — no restart needed. */
export function setConfigOverride(key: OverridableKey, value: string): void {
  setSetting(OVERRIDABLE_KEYS[key], value);
}

/** Clears an override, reverting that field back to its env var value (or default). */
export function clearConfigOverride(key: OverridableKey): void {
  deleteSetting(OVERRIDABLE_KEYS[key]);
}

export function requireEtsyCredentials(): { clientId: string; clientSecret: string } {
  const { ETSY_CLIENT_ID, ETSY_CLIENT_SECRET } = getEffectiveConfig();
  if (!ETSY_CLIENT_ID || !ETSY_CLIENT_SECRET) {
    throw new Error("Etsy client ID/secret are not configured yet. Set them via /setup.");
  }
  return { clientId: ETSY_CLIENT_ID, clientSecret: ETSY_CLIENT_SECRET };
}

export function requireShopifyCredentials(): { storeDomain: string; clientId: string; clientSecret: string } {
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = getEffectiveConfig();
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify store domain/client ID/secret are not configured yet. Set them via /setup.");
  }
  return { storeDomain: SHOPIFY_STORE_DOMAIN, clientId: SHOPIFY_CLIENT_ID, clientSecret: SHOPIFY_CLIENT_SECRET };
}

/** The Etsy OAuth redirect_uri, derived from PUBLIC_BASE_URL. Throws if not configured. */
export function getEtsyRedirectUri(): string {
  const { PUBLIC_BASE_URL } = getEffectiveConfig();
  if (!PUBLIC_BASE_URL) {
    throw new Error(
      "PUBLIC_BASE_URL is not set. Configure it via /setup, or set it as an env var, to " +
        "this service's public HTTPS URL (e.g. https://your-app.up.railway.app)."
    );
  }
  return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/oauth/etsy/callback`;
}
