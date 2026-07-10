import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getEnv, getEtsyRedirectUri } from "./config/env.js";
import { saveDiscoveredShopId, getShopId } from "./config/shopId.js";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  exchangeCodeForTokens,
} from "./etsy/oauthClient.js";
import { saveEtsyTokens, getEtsyTokens } from "./db/tokenStore.js";
import { fetchEtsySelf } from "./etsy/apiClient.js";
import { getReceiptById } from "./etsy/receipts.js";
import { getFlaggedReceipts, markSynced } from "./db/receiptStore.js";
import { getDb } from "./db/client.js";
import { getShopCurrencyCode } from "./shopify/shopInfo.js";
import { buildOrderInput, createOrder } from "./shopify/orders.js";
import { decrementInventory } from "./shopify/inventory.js";
import { resolveLineItems } from "./sync/mapping.js";
import { logger } from "./logger.js";

// Short-lived, in-memory only: a PKCE verifier only needs to survive the few seconds
// between /oauth/etsy/start and Etsy redirecting back to /oauth/etsy/callback.
const pendingAuth = new Map<string, { verifier: string; createdAt: number }>();
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function handleOauthStart(res: ServerResponse): void {
  const redirectUri = getEtsyRedirectUri();
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();

  for (const [key, value] of pendingAuth) {
    if (Date.now() - value.createdAt > PENDING_AUTH_TTL_MS) pendingAuth.delete(key);
  }
  pendingAuth.set(state, { verifier, createdAt: Date.now() });

  const url = buildAuthorizeUrl({ state, codeChallenge: challenge, redirectUri });
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleOauthCallback(url: URL, res: ServerResponse): Promise<void> {
  const error = url.searchParams.get("error");
  if (error) {
    sendHtml(res, 400, `<h1>Etsy authorization failed</h1><p>${error}: ${url.searchParams.get("error_description")}</p>`);
    return;
  }

  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || !pendingAuth.has(state)) {
    sendHtml(res, 400, "<h1>Invalid or expired authorization request</h1><p>Please try /oauth/etsy/start again.</p>");
    return;
  }

  const { verifier } = pendingAuth.get(state)!;
  pendingAuth.delete(state);

  const redirectUri = getEtsyRedirectUri();
  const tokens = await exchangeCodeForTokens({ code, codeVerifier: verifier, redirectUri });
  saveEtsyTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });

  const self = await fetchEtsySelf();
  saveDiscoveredShopId(String(self.shop_id));

  logger.info("Etsy OAuth handshake complete", { shopId: self.shop_id });
  sendHtml(
    res,
    200,
    `<h1>Etsy connected</h1><p>Shop id ${self.shop_id} is now linked. The sync loop will start picking up new paid orders automatically.</p>`
  );
}

function handleHealth(res: ServerResponse): void {
  const db = getDb();
  const lastRun = db
    .prepare(`SELECT * FROM sync_runs ORDER BY run_at DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  const flagged = getFlaggedReceipts();

  let shopId: string | null = null;
  try {
    shopId = getShopId();
  } catch {
    shopId = null;
  }

  sendJson(res, 200, {
    ok: true,
    etsyAuthorized: Boolean(getEtsyTokens()),
    shopId,
    lastRun,
    flaggedReceiptsNeedingReview: flagged.length,
  });
}

// TEMPORARY, ONE-OFF: reprocess a single specific receipt through the real pipeline
// (SKU match, order create, inventory decrement, mark synced), bypassing the normal
// date-range checkpoint fetch since the checkpoint has already moved past its date.
// Used to recreate #1174 (receipt 4111842377) after it was cancelled to fix the
// requiresShipping bug. Remove once run once.
async function handleResyncReceipt(url: URL, res: ServerResponse): Promise<void> {
  const receiptId = url.searchParams.get("id");
  if (!receiptId) {
    sendJson(res, 400, { error: "missing ?id=<etsy receipt id>" });
    return;
  }

  const shopId = getShopId();
  const receipt = await getReceiptById(shopId, receiptId);
  const { resolved, unresolved } = await resolveLineItems(receipt);
  if (unresolved.length > 0) {
    sendJson(res, 200, { ok: false, unresolved });
    return;
  }

  const currencyCode = await getShopCurrencyCode();
  const orderInput = buildOrderInput(receipt, resolved, currencyCode);
  const result = await createOrder(orderInput);
  if ("userErrors" in result) {
    sendJson(res, 200, { ok: false, userErrors: result.userErrors });
    return;
  }

  for (const line of resolved) {
    await decrementInventory({
      inventoryItemId: line.variant.inventoryItemId,
      quantity: line.quantity,
      shopifyOrderId: result.orderId,
      etsyReceiptId: receiptId,
    });
  }

  markSynced({ etsyReceiptId: receiptId, shopifyOrderId: result.orderId, receiptCreatedTs: receipt.created_timestamp });
  sendJson(res, 200, { ok: true, orderId: result.orderId, orderName: result.orderName });
}

export function startServer(): void {
  const { PORT } = getEnv();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    Promise.resolve()
      .then(async () => {
        if (url.pathname === "/oauth/etsy/start") return handleOauthStart(res);
        if (url.pathname === "/oauth/etsy/callback") return handleOauthCallback(url, res);
        if (url.pathname === "/health") return handleHealth(res);
        if (url.pathname === "/debug/resync-receipt") return handleResyncReceipt(url, res);
        if (url.pathname === "/") {
          return sendHtml(
            res,
            200,
            `<h1>Etsy → Shopify sync</h1><p><a href="/oauth/etsy/start">Authorize with Etsy</a> | <a href="/health">Health</a></p>`
          );
        }
        res.writeHead(404).end("Not found");
      })
      .catch((error) => {
        logger.error("HTTP handler error", { path: url.pathname, error: error instanceof Error ? error.message : String(error) });
        sendJson(res, 500, { error: "internal_error" });
      });
  });

  // Must bind to 0.0.0.0, not the default — Railway's proxy connects from outside
  // the container's network namespace and can't reach a server listening only on
  // a loopback/IPv6-only default address.
  server.listen(PORT, "0.0.0.0", () => {
    logger.info("HTTP server listening", { port: PORT });
  });
}
