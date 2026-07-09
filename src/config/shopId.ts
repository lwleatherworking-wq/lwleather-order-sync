import { getEnv } from "./env.js";
import { getSetting, setSetting } from "../db/settingsStore.js";

const SETTING_KEY = "etsy_shop_id";

/**
 * Resolves the Etsy shop id: prefer the value discovered automatically during the
 * OAuth handshake (stored in the DB), falling back to ETSY_SHOP_ID from env if set manually.
 */
export function getShopId(): string {
  const fromDb = getSetting(SETTING_KEY);
  if (fromDb) return fromDb;

  const fromEnv = getEnv().ETSY_SHOP_ID;
  if (fromEnv) return fromEnv;

  throw new Error(
    "Etsy shop id is not known yet. Visit /oauth/etsy/start on this service to authorize " +
      "with Etsy — the shop id is discovered and stored automatically once that completes."
  );
}

export function saveDiscoveredShopId(shopId: string): void {
  setSetting(SETTING_KEY, String(shopId));
}
