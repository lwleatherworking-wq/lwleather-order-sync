import { getEnv } from "./config/env.js";
import { getDb } from "./db/client.js";
import { startServer } from "./server.js";
import { startScheduler } from "./sync/scheduler.js";
import { logger } from "./logger.js";

getEnv(); // fail fast on missing/invalid config
getDb(); // ensure the DB file + schema exist before anything else runs

logger.info("Starting Etsy -> Shopify sync service");
startServer();
startScheduler();
