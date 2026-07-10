import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";

function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf-8");
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const envSchema = z.object({
  ETSY_CLIENT_ID: z.string().min(1, "ETSY_CLIENT_ID is required"),
  ETSY_CLIENT_SECRET: z.string().min(1, "ETSY_CLIENT_SECRET is required"),
  // Etsy rejects non-https redirect_uri values outright, so this must be the deployed
  // service's public HTTPS URL (e.g. https://your-app.up.railway.app) + /oauth/etsy/callback.
  // Not required at startup: only needed once the user actually visits /oauth/etsy/start.
  PUBLIC_BASE_URL: z.string().url().optional(),
  // Optional at first: not known until the OAuth handshake resolves the authenticated
  // user's shop (see src/server.ts, GET /oauth/etsy/callback), which stores it in the DB.
  ETSY_SHOP_ID: z.string().optional(),

  SHOPIFY_STORE_DOMAIN: z.string().min(1, "SHOPIFY_STORE_DOMAIN is required"),
  // Custom apps created via Shopify's Dev Dashboard no longer expose a static Admin API
  // access token — instead the app's client id/secret are exchanged for a short-lived
  // token via the OAuth client credentials grant (see shopify/apiClient.ts).
  SHOPIFY_CLIENT_ID: z.string().min(1, "SHOPIFY_CLIENT_ID is required"),
  SHOPIFY_CLIENT_SECRET: z.string().min(1, "SHOPIFY_CLIENT_SECRET is required"),
  SHOPIFY_API_VERSION: z.string().default("2025-01"),

  SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
  DRY_RUN: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  DB_PATH: z.string().default("./data/sync.db"),
  PORT: z.coerce.number().int().positive().default(3000),

  // One-time historical backfill switch: if set (e.g. "2026-06-10"), the next sync run(s)
  // fetch Etsy receipts from this date forward instead of the normal checkpoint. Remove
  // this var again once the backfill has run once — leaving it set makes every tick
  // needlessly re-fetch the whole range instead of just what's new (harmless since already-
  // synced receipts are skipped, just wasteful).
  BACKFILL_SINCE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Parses and validates process.env, failing fast with a clear message on first access. */
export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid/missing environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

/** The Etsy OAuth redirect_uri, derived from PUBLIC_BASE_URL. Throws if not configured. */
export function getEtsyRedirectUri(): string {
  const { PUBLIC_BASE_URL } = getEnv();
  if (!PUBLIC_BASE_URL) {
    throw new Error(
      "PUBLIC_BASE_URL is not set. Set it to this service's public HTTPS URL " +
        "(e.g. https://your-app.up.railway.app) before visiting /oauth/etsy/start."
    );
  }
  return `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/oauth/etsy/callback`;
}
