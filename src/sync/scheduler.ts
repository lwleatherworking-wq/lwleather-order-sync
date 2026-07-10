import { getEffectiveConfig } from "../config/effectiveConfig.js";
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

/**
 * Self-rescheduling rather than a fixed setInterval, so that a sync interval change
 * made via /setup takes effect on the very next tick instead of requiring a restart.
 */
function scheduleNextTick(): void {
  const { SYNC_INTERVAL_MINUTES } = getEffectiveConfig();
  const intervalMs = SYNC_INTERVAL_MINUTES * 60 * 1000;
  setTimeout(() => {
    void tick().finally(scheduleNextTick);
  }, intervalMs);
}

export function startScheduler(): void {
  logger.info("Starting sync scheduler", { intervalMinutes: getEffectiveConfig().SYNC_INTERVAL_MINUTES });
  void tick().finally(scheduleNextTick);
}
