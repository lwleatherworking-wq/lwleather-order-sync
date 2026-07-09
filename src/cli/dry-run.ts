// Forces dry-run mode regardless of the .env setting, so this command is always safe to run.
process.env.DRY_RUN = "true";

import { getEnv } from "../config/env.js";
import { getDb } from "../db/client.js";
import { syncOnce } from "../sync/syncOnce.js";

async function main(): Promise<void> {
  getEnv();
  getDb();
  console.log("Running a dry-run sync pass — no Shopify orders or inventory will be changed.\n");
  const summary = await syncOnce();
  console.log("\nDry-run summary:", summary);
}

main().catch((error) => {
  console.error("Dry-run failed:", error);
  process.exitCode = 1;
});
