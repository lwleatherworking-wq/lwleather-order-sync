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
import { getFlaggedReceipts } from "./db/receiptStore.js";
import { getDb } from "./db/client.js";
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

interface StatusData {
  etsyAuthorized: boolean;
  shopId: string | null;
  lastRun: Record<string, unknown> | undefined;
  flagged: ReturnType<typeof getFlaggedReceipts>;
}

function getStatusData(): StatusData {
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

  return { etsyAuthorized: Boolean(getEtsyTokens()), shopId, lastRun, flagged };
}

function handleHealth(res: ServerResponse): void {
  const status = getStatusData();
  sendJson(res, 200, {
    ok: true,
    etsyAuthorized: status.etsyAuthorized,
    shopId: status.shopId,
    lastRun: status.lastRun,
    flaggedReceiptsNeedingReview: status.flagged.length,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

function handleStatusPage(res: ServerResponse): void {
  const status = getStatusData();
  const lastRun = status.lastRun as
    | { run_at: number; receipts_seen: number; receipts_synced: number; receipts_skipped: number; errors_count: number }
    | undefined;

  const authBadge = status.etsyAuthorized
    ? `<span class="badge ok">Connected</span>`
    : `<span class="badge bad">Not connected</span> — <a href="/oauth/etsy/start">authorize with Etsy</a>`;

  const flaggedRows = status.flagged
    .slice(0, 20)
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.etsyReceiptId)}</td><td>${escapeHtml(f.status)}</td><td>${escapeHtml(
          f.reason ?? ""
        )}</td><td>${formatTimestamp(f.syncedAt)}</td></tr>`
    )
    .join("");

  sendHtml(
    res,
    200,
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <title>Etsy → Shopify sync status</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.05rem; margin-top: 2rem; }
    .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .badge.ok { background: #d1f7dd; color: #12603a; }
    .badge.bad { background: #fde2e2; color: #8a1f1f; }
    table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; }
    dt { color: #666; }
    footer { margin-top: 2rem; font-size: 0.8rem; color: #888; }
  </style>
</head>
<body>
  <h1>Etsy → Shopify order sync</h1>

  <dl>
    <dt>Etsy</dt><dd>${authBadge}</dd>
    <dt>Shop ID</dt><dd>${status.shopId ? escapeHtml(status.shopId) : "unknown"}</dd>
  </dl>

  <h2>Last sync run</h2>
  ${
    lastRun
      ? `<dl>
          <dt>When</dt><dd>${formatTimestamp(lastRun.run_at)}</dd>
          <dt>Receipts seen</dt><dd>${lastRun.receipts_seen}</dd>
          <dt>Synced</dt><dd>${lastRun.receipts_synced}</dd>
          <dt>Skipped</dt><dd>${lastRun.receipts_skipped}</dd>
          <dt>Errors</dt><dd>${lastRun.errors_count}</dd>
        </dl>`
      : `<p>No sync run yet.</p>`
  }

  <h2>Needs review (${status.flagged.length})</h2>
  ${
    status.flagged.length > 0
      ? `<table>
          <tr><th>Etsy receipt</th><th>Status</th><th>Reason</th><th>When</th></tr>
          ${flaggedRows}
        </table>`
      : `<p>Nothing flagged — all good.</p>`
  }

  <footer>Auto-refreshes every 30s. Raw JSON at <a href="/health">/health</a>.</footer>
</body>
</html>`
  );
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
        if (url.pathname === "/") return handleStatusPage(res);
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
