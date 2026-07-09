import { getEnv } from "../config/env.js";
import { syncOnce } from "./syncOnce.js";
import { logger } from "../logger.js";
import { getEtsyTokens } from "../db/tokenStore.js";

let running = false;

async function tick(): Promise<void> {
  if (running) {
    logger.warn("Previous sync run still in progress, skipping this tick");
    return;
  }
  if (!getEtsyTokens()) {
    logger.info("Etsy not yet authorized, skipping sync tick. Visit /oauth/etsy/start to authorize.");
    return;
  }
  running = true;
  try {
    await syncOnce();
  } catch (error) {
    logger.error("Sync run failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  const { SYNC_INTERVAL_MINUTES } = getEnv();
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  logger.info("Starting sync scheduler", { intervalMinutes: SYNC_INTERVAL_MINUTES });
  void tick();
  setInterval(() => void tick(), intervalMs);
}
