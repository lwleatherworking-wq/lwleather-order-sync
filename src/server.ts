import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getEnv } from "./config/env.js";
import { getEffectiveConfig, getEtsyRedirectUri, setConfigOverride, type OverridableKey } from "./config/effectiveConfig.js";
import { saveDiscoveredShopId, getShopId } from "./config/shopId.js";
import {
  buildAuthorizeUrl,
  generatePkcePair,
  generateState,
  exchangeCodeForTokens,
} from "./etsy/oauthClient.js";
import { saveEtsyTokens, getEtsyTokens } from "./db/tokenStore.js";
import { fetchEtsySelf } from "./etsy/apiClient.js";
import { listEtsySkus } from "./etsy/listings.js";
import { clearCachedShopifyToken } from "./shopify/apiClient.js";
import { findVariantBySku, listShopifySkus } from "./shopify/variantLookup.js";
import { getFlaggedReceipts, getSyncedReceipts } from "./db/receiptStore.js";
import { getSkuLink, setSkuLink, deleteSkuLink, listSkuLinks } from "./db/skuLinkStore.js";
import { getEtsyListingLink, recordEtsyListingLink } from "./db/etsyListingLinkStore.js";
import { listProducts, getProductDetail } from "./shopify/products.js";
import {
  getShippingProfiles,
  getSellerTaxonomyOptions,
  getReadinessStateDefinitions,
  createDraftListing,
  uploadListingImage,
  type DraftListingInput,
} from "./etsy/shopListings.js";
import sharp from "sharp";
import { getDb } from "./db/client.js";
import { logger } from "./logger.js";

// Short-lived, in-memory only: a PKCE verifier only needs to survive the few seconds
// between /oauth/etsy/start and Etsy redirecting back to /oauth/etsy/callback.
const pendingAuth = new Map<string, { verifier: string; createdAt: number }>();
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

function sendHtml(res: ServerResponse, status: number, html: string, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extraHeaders });
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

const SHARED_STYLE = `
    :root {
      --bg: #ffffff; --fg: #1a1a1a; --muted-fg: #666; --border: #eee;
      --code-bg: #f2f2f2; --input-bg: #ffffff; --input-border: #ccc;
      --button-bg: #1a1a1a; --button-fg: #ffffff;
      --badge-ok-bg: #d1f7dd; --badge-ok-fg: #12603a;
      --badge-bad-bg: #fde2e2; --badge-bad-fg: #8a1f1f;
      --dropdown-shadow: rgba(0,0,0,0.08); --mark-bg: #fff3b0;
    }
    [data-theme="dark"] {
      --bg: #15171a; --fg: #e8e8e8; --muted-fg: #9aa0a6; --border: #2c2f34;
      --code-bg: #22252b; --input-bg: #1c1f24; --input-border: #3a3d44;
      --button-bg: #e8e8e8; --button-fg: #15171a;
      --badge-ok-bg: #123a24; --badge-ok-fg: #7fe3a4;
      --badge-bad-bg: #3d1717; --badge-bad-fg: #ff9d9d;
      --dropdown-shadow: rgba(0,0,0,0.5); --mark-bg: #6b5a17;
    }
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: var(--fg); background: var(--bg); }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.05rem; margin-top: 2rem; }
    nav.in-page { margin-bottom: 1.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    nav.in-page .spacer { flex: 1; }
    #theme-toggle {
      margin-top: 0; padding: 0.25rem 0.6rem; border: 1px solid var(--input-border); border-radius: 6px;
      background: var(--bg); color: var(--fg); font-size: 0.9rem; cursor: pointer;
    }
    .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
    .badge.ok { background: var(--badge-ok-bg); color: var(--badge-ok-fg); }
    .badge.bad { background: var(--badge-bad-bg); color: var(--badge-bad-fg); }
    table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 1rem; }
    dt { color: var(--muted-fg); }
    footer { margin-top: 2rem; font-size: 0.8rem; color: var(--muted-fg); }
    .banner { padding: 0.6rem 0.8rem; border-radius: 6px; }
    .banner.success { background: var(--badge-ok-bg); color: var(--badge-ok-fg); }
    .banner.error { background: var(--badge-bad-bg); color: var(--badge-bad-fg); }
    .field { margin-bottom: 1rem; }
    label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
    input[type="text"], input[type="password"], input[type="number"], input[type="date"], textarea, select {
      width: 100%; padding: 0.4rem 0.5rem; box-sizing: border-box; border: 1px solid var(--input-border);
      border-radius: 4px; background: var(--input-bg); color: var(--fg);
    }
    .hint { color: var(--muted-fg); font-size: 0.8rem; margin: 0.2rem 0 0; }
    button { margin-top: 1rem; padding: 0.5rem 1.2rem; border: none; border-radius: 6px; background: var(--button-bg); color: var(--button-fg); font-size: 0.95rem; cursor: pointer; }
    .inline-form { display: flex; gap: 0.4rem; align-items: center; }
    .inline-form input[type="text"] { width: auto; flex: 1; }
    .inline-form button { margin-top: 0; }
    code { background: var(--code-bg); padding: 0.1rem 0.3rem; border-radius: 3px; }
    .combobox { position: relative; }
    .combobox-results {
      display: none; position: absolute; z-index: 10; top: 100%; left: 0; right: 0;
      background: var(--bg); border: 1px solid var(--input-border); border-top: none; border-radius: 0 0 6px 6px;
      max-height: 240px; overflow-y: auto; box-shadow: 0 4px 10px var(--dropdown-shadow);
    }
    .combobox-results.open { display: block; }
    .combobox-result { padding: 0.45rem 0.6rem; cursor: pointer; font-size: 0.9rem; }
    .combobox-result:hover { background: var(--code-bg); }
    .combobox-result.combobox-empty { color: var(--muted-fg); cursor: default; }
    .combobox-result.combobox-empty:hover { background: none; }
    .combobox-result mark { background: var(--mark-bg); color: inherit; padding: 0; border-radius: 2px; }
`;

// Runs before first paint so the page never flashes the wrong theme: an explicit
// localStorage choice wins, otherwise the OS-level prefers-color-scheme is used.
const THEME_INIT_SCRIPT = `
  (function () {
    var saved = localStorage.getItem("theme");
    var theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
`;

const THEME_TOGGLE_SCRIPT = `
  (function () {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    function label() {
      return document.documentElement.getAttribute("data-theme") === "dark" ? "☀️ Light" : "\u{1F319} Dark";
    }
    btn.textContent = label();
    btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);
      btn.textContent = label();
    });
  })();
`;

/**
 * Common HTML shell for every page: the App Bridge script (so this can be embedded as
 * a tab inside Shopify Admin), an <s-app-nav> sidebar menu (Shopify's current documented
 * way to add left-sidebar tabs to an embedded app — unverified against a real embedded
 * session at build time, see README), and a plain in-page nav as a fallback that works
 * regardless of whether the sidebar menu renders.
 */
function renderPage(params: { title: string; bodyHtml: string; refreshSeconds?: number }): {
  html: string;
  headers?: Record<string, string>;
} {
  const { SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID } = getEffectiveConfig();
  // Both may be unset before /setup is completed — pages must still render (just not
  // yet embeddable/App-Bridge-enabled) rather than crash.
  const appBridgeTag = SHOPIFY_CLIENT_ID
    ? `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${escapeHtml(SHOPIFY_CLIENT_ID)}"></script>`
    : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  ${params.refreshSeconds ? `<meta http-equiv="refresh" content="${params.refreshSeconds}">` : ""}
  <title>${escapeHtml(params.title)}</title>
  <script>${THEME_INIT_SCRIPT}</script>
  ${appBridgeTag}
  <style>${SHARED_STYLE}</style>
</head>
<body>
  <s-app-nav>
    <s-link href="/" rel="home">Status</s-link>
    <s-link href="/log">Log</s-link>
    <s-link href="/sku-linking">SKU Linking</s-link>
    <s-link href="/list-to-etsy">List to Etsy</s-link>
    <s-link href="/setup">Setup</s-link>
  </s-app-nav>
  <nav class="in-page">
    <a href="/">Status</a> · <a href="/log">Log</a> · <a href="/sku-linking">SKU Linking</a> · <a href="/list-to-etsy">List to Etsy</a> · <a href="/setup">Setup</a>
    <span class="spacer"></span>
    <button type="button" id="theme-toggle"></button>
  </nav>
  ${params.bodyHtml}
  <script>${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>`;

  return {
    html,
    // Required for Shopify to allow embedding pages inside Admin: scoped to this specific
    // shop rather than a wildcard, since a wildcard would let any shop iframe it. Before
    // the store domain is configured, there's no shop to scope to yet, so framing isn't
    // allowed until then.
    headers: SHOPIFY_STORE_DOMAIN
      ? { "Content-Security-Policy": `frame-ancestors https://${SHOPIFY_STORE_DOMAIN} https://admin.shopify.com;` }
      : undefined,
  };
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

  const bodyHtml = `
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

  <footer>Auto-refreshes every 30s. Raw JSON at <a href="/health">/health</a>. Full sync history at <a href="/log">/log</a>.</footer>`;

  const { html, headers } = renderPage({ title: "Etsy → Shopify sync status", bodyHtml, refreshSeconds: 30 });
  sendHtml(res, 200, html, headers);
}

/** Extracts the numeric id from a Shopify GID like "gid://shopify/Order/123". */
function numericIdFromGid(gid: string | null): string | null {
  if (!gid) return null;
  return gid.split("/").pop() || null;
}

function handleLogPage(res: ServerResponse): void {
  const synced = getSyncedReceipts(200);
  const { SHOPIFY_STORE_DOMAIN } = getEffectiveConfig();

  const rows = synced
    .map((r) => {
      const numericId = numericIdFromGid(r.shopifyOrderId);
      const orderCell =
        numericId && SHOPIFY_STORE_DOMAIN
          ? `<a href="https://${escapeHtml(SHOPIFY_STORE_DOMAIN)}/admin/orders/${escapeHtml(numericId)}" target="_blank" rel="noopener">Order ${escapeHtml(numericId)}</a>`
          : escapeHtml(numericId ?? "—");
      return `<tr>
        <td>${escapeHtml(r.etsyReceiptId)}</td>
        <td>${orderCell}</td>
        <td>${formatTimestamp(r.receiptCreatedTs * 1000)}</td>
        <td>${formatTimestamp(r.syncedAt)}</td>
      </tr>`;
    })
    .join("");

  const bodyHtml = `
  <h1>Synced orders log</h1>
  <p>Most recent ${synced.length} successfully synced orders.</p>
  ${
    synced.length > 0
      ? `<table>
          <tr><th>Etsy receipt</th><th>Shopify order</th><th>Etsy order date</th><th>Synced at</th></tr>
          ${rows}
        </table>`
      : `<p>Nothing synced yet.</p>`
  }`;

  const { html, headers } = renderPage({ title: "Etsy → Shopify sync log", bodyHtml });
  sendHtml(res, 200, html, headers);
}

/** Distinct Etsy SKUs currently blocking a receipt from syncing (reason: sku_not_found). */
function getUnmatchedSkus(): string[] {
  const skus = new Set<string>();
  for (const flagged of getFlaggedReceipts()) {
    if (flagged.reason !== "unmatched_sku" || !flagged.errorDetail) continue;
    try {
      const unresolved = JSON.parse(flagged.errorDetail) as Array<{ sku: string | null; reason: string }>;
      for (const line of unresolved) {
        if (line.sku && line.reason === "sku_not_found") skus.add(line.sku);
      }
    } catch {
      // ignore malformed detail rather than break the page
    }
  }
  return Array.from(skus);
}

async function skuLinkingPageHtml(params: { message?: string; messageIsError?: boolean }): Promise<{ html: string; headers?: Record<string, string> }> {
  const unmatched = getUnmatchedSkus();
  const links = listSkuLinks();
  const linkedSet = new Set(links.map((l) => l.etsySku));
  const shopifySkus = await listShopifySkus();

  let etsySkus: Awaited<ReturnType<typeof listEtsySkus>> = [];
  let etsySkusError: string | undefined;
  try {
    etsySkus = await listEtsySkus(getShopId());
  } catch (error) {
    etsySkusError =
      error instanceof Error
        ? error.message
        : "Could not load Etsy SKUs. If this app was authorized before listings_r was added, re-authorize via /oauth/etsy/start.";
  }

  const banner = params.message
    ? `<p class="banner ${params.messageIsError ? "error" : "success"}">${escapeHtml(params.message)}</p>`
    : "";

  const needsLinkingRows = unmatched
    .map((sku) => {
      if (linkedSet.has(sku)) {
        return `<tr><td>${escapeHtml(sku)}</td><td colspan="2">Linked to <code>${escapeHtml(
          getSkuLink(sku) ?? ""
        )}</code> — will retry on the next sync</td></tr>`;
      }
      return `<tr>
        <td>${escapeHtml(sku)}</td>
        <td colspan="2">
          <form method="POST" action="/sku-linking" class="inline-form">
            <input type="hidden" name="action" value="link">
            <input type="hidden" name="etsySku" value="${escapeHtml(sku)}">
            <input type="text" name="shopifySku" placeholder="Shopify SKU to link to" required>
            <button type="submit">Link</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const existingLinksRows = links
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.etsySku)}</td>
        <td>${escapeHtml(l.shopifySku)}</td>
        <td>
          <form method="POST" action="/sku-linking" class="inline-form">
            <input type="hidden" name="action" value="unlink">
            <input type="hidden" name="etsySku" value="${escapeHtml(l.etsySku)}">
            <button type="submit">Remove</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  const shopifySkuRows = shopifySkus
    .map((s) => `<tr><td><code>${escapeHtml(s.sku)}</code></td><td>${escapeHtml(s.displayName)}</td></tr>`)
    .join("");

  const etsySkuRows = etsySkus
    .map((s) => `<tr><td><code>${escapeHtml(s.sku)}</code></td><td>${escapeHtml(s.listingTitle)}</td></tr>`)
    .join("");

  const bodyHtml = `
  <h1>SKU linking</h1>
  <p>Manually map an Etsy listing SKU to a Shopify variant SKU, for cases where they were
  never going to match exactly. A link takes effect on the next sync tick.</p>

  ${banner}

  <h2>Needs linking (${unmatched.length})</h2>
  ${
    unmatched.length > 0
      ? `<table>
          <tr><th>Etsy SKU</th><th colspan="2">Link to Shopify SKU</th></tr>
          ${needsLinkingRows}
        </table>`
      : `<p>Nothing currently blocked on a SKU mismatch.</p>`
  }

  <h2>Add a link</h2>
  <form method="POST" action="/sku-linking" class="field-form">
    <input type="hidden" name="action" value="link">
    <div class="field">
      <label>Etsy SKU</label>
      <input type="text" name="etsySku" required>
    </div>
    <div class="field">
      <label>Shopify SKU</label>
      <input type="text" name="shopifySku" required>
    </div>
    <button type="submit">Link</button>
  </form>

  <h2>Existing links (${links.length})</h2>
  ${
    links.length > 0
      ? `<table>
          <tr><th>Etsy SKU</th><th>Shopify SKU</th><th></th></tr>
          ${existingLinksRows}
        </table>`
      : `<p>No manual links yet.</p>`
  }

  <h2>Shopify SKUs already matched (${shopifySkus.length})</h2>
  <p>Every SKU currently set on a Shopify variant — for reference when typing a SKU into
  the forms above.</p>
  ${
    shopifySkus.length > 0
      ? `<details>
          <summary>Show all ${shopifySkus.length}</summary>
          <table>
            <tr><th>SKU</th><th>Product / variant</th></tr>
            ${shopifySkuRows}
          </table>
        </details>`
      : `<p>No Shopify variants have a SKU set yet.</p>`
  }

  <h2>Etsy SKUs (${etsySkus.length})</h2>
  <p>Every SKU currently set on an active Etsy listing — for reference when typing an
  Etsy SKU into the forms above.</p>
  ${
    etsySkusError
      ? `<p class="banner error">${escapeHtml(etsySkusError)}</p>`
      : etsySkus.length > 0
        ? `<details>
            <summary>Show all ${etsySkus.length}</summary>
            <table>
              <tr><th>SKU</th><th>Listing</th></tr>
              ${etsySkuRows}
            </table>
          </details>`
        : `<p>No Etsy listings have a SKU set yet.</p>`
  }`;

  return renderPage({ title: "Etsy → Shopify SKU linking", bodyHtml });
}

async function handleSkuLinkingGet(res: ServerResponse): Promise<void> {
  const { html, headers } = await skuLinkingPageHtml({});
  sendHtml(res, 200, html, headers);
}

async function handleSkuLinkingPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const action = params.get("action");
  const etsySku = params.get("etsySku")?.trim();

  if (!etsySku) {
    const { html, headers } = await skuLinkingPageHtml({ message: "Etsy SKU is required.", messageIsError: true });
    sendHtml(res, 400, html, headers);
    return;
  }

  if (action === "unlink") {
    deleteSkuLink(etsySku);
    const { html, headers } = await skuLinkingPageHtml({ message: `Removed link for "${etsySku}".` });
    sendHtml(res, 200, html, headers);
    return;
  }

  const shopifySku = params.get("shopifySku")?.trim();
  if (!shopifySku) {
    const { html, headers } = await skuLinkingPageHtml({ message: "Shopify SKU is required.", messageIsError: true });
    sendHtml(res, 400, html, headers);
    return;
  }

  const variant = await findVariantBySku(shopifySku);
  if (!variant) {
    const { html, headers } = await skuLinkingPageHtml({
      message: `No Shopify variant found with SKU "${shopifySku}" — not saved.`,
      messageIsError: true,
    });
    sendHtml(res, 200, html, headers);
    return;
  }

  setSkuLink(etsySku, shopifySku);
  logger.info("SKU link saved via /sku-linking", { etsySku, shopifySku });
  const { html, headers } = await skuLinkingPageHtml({
    message: `Linked Etsy SKU "${etsySku}" to Shopify SKU "${shopifySku}". Will retry on the next sync tick.`,
  });
  sendHtml(res, 200, html, headers);
}

/** Strips HTML tags to produce a readable plain-text default for the Etsy description field. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WHEN_MADE_OPTIONS = [
  "made_to_order",
  "2020_2026",
  "2010_2019",
  "2007_2009",
  "before_2007",
  "2000_2006",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "1950s",
  "1940s",
  "1930s",
  "1920s",
  "1910s",
  "1900s",
  "1800s",
  "1700s",
  "before_1700",
];

const WHO_MADE_OPTIONS: Array<{ value: DraftListingInput["whoMade"]; label: string }> = [
  { value: "i_did", label: "I did" },
  { value: "someone_else", label: "Someone else" },
  { value: "collective", label: "A member of my shop" },
];

async function listToEtsyPageHtml(): Promise<{ html: string; headers?: Record<string, string> }> {
  let products: Awaited<ReturnType<typeof listProducts>> = [];
  let loadError: string | undefined;
  try {
    products = await listProducts();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load Shopify products.";
  }

  const rows = products
    .map((p) => {
      const linkedListingId = getEtsyListingLink(p.id);
      const statusCell = linkedListingId
        ? `<a href="https://www.etsy.com/your/shops/me/tools/listings/${escapeHtml(linkedListingId)}" target="_blank" rel="noopener">Etsy draft #${escapeHtml(linkedListingId)}</a>`
        : `<a href="/list-to-etsy/product?id=${encodeURIComponent(p.id)}">List to Etsy</a>`;
      return `<tr>
        <td>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" width="48" height="48" style="object-fit:cover;border-radius:4px;">` : ""}</td>
        <td>${escapeHtml(p.title)}</td>
        <td>${escapeHtml(p.sku ?? "—")}</td>
        <td>${escapeHtml(p.price)}</td>
        <td>${statusCell}</td>
      </tr>`;
    })
    .join("");

  const bodyHtml = `
  <h1>List products to Etsy</h1>
  <p>Creates a <strong>draft</strong> listing on Etsy from a Shopify product — nothing is
  published live. Etsy fields Shopify doesn't have (category, shipping profile, who/when
  made) are filled in per-product on the next screen before anything is created.</p>

  ${loadError ? `<p class="banner error">${escapeHtml(loadError)}</p>` : ""}

  ${
    products.length > 0
      ? `<table>
          <tr><th></th><th>Product</th><th>SKU</th><th>Price</th><th></th></tr>
          ${rows}
        </table>`
      : !loadError
        ? `<p>No Shopify products found.</p>`
        : ""
  }`;

  return renderPage({ title: "List products to Etsy", bodyHtml });
}

function handleListToEtsyGet(res: ServerResponse): Promise<void> {
  return listToEtsyPageHtml().then(({ html, headers }) => sendHtml(res, 200, html, headers));
}

async function listToEtsyProductPageHtml(params: {
  productId: string;
  message?: string;
  messageIsError?: boolean;
}): Promise<{ html: string; headers?: Record<string, string>; status: number }> {
  const product = await getProductDetail(params.productId);
  if (!product) {
    return {
      ...renderPage({ title: "Product not found", bodyHtml: `<h1>Product not found</h1><p><a href="/list-to-etsy">Back to product list</a></p>` }),
      status: 404,
    };
  }

  const alreadyLinked = getEtsyListingLink(product.id);
  const banner = params.message
    ? `<p class="banner ${params.messageIsError ? "error" : "success"}">${escapeHtml(params.message)}</p>`
    : "";

  let shippingProfiles: Awaited<ReturnType<typeof getShippingProfiles>> = [];
  let taxonomyOptions: Awaited<ReturnType<typeof getSellerTaxonomyOptions>> = [];
  let readinessStates: Awaited<ReturnType<typeof getReadinessStateDefinitions>> = [];
  let loadError: string | undefined;
  try {
    const shopId = getShopId();
    [shippingProfiles, taxonomyOptions, readinessStates] = await Promise.all([
      getShippingProfiles(shopId),
      getSellerTaxonomyOptions(),
      getReadinessStateDefinitions(shopId),
    ]);
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "Could not load Etsy shipping profiles / categories. Make sure Etsy is connected (re-authorize via /oauth/etsy/start if listings_w was just added).";
  }

  const alreadyLinkedBanner = alreadyLinked
    ? `<p class="banner success">Already listed as Etsy draft #${escapeHtml(alreadyLinked)}. Submitting again will create a <strong>separate</strong> new draft listing.</p>`
    : "";

  if (loadError) {
    return {
      ...renderPage({
        title: `List "${product.title}" to Etsy`,
        bodyHtml: `<h1>List "${escapeHtml(product.title)}" to Etsy</h1>${banner}<p class="banner error">${escapeHtml(loadError)}</p><p><a href="/list-to-etsy">Back to product list</a></p>`,
      }),
      status: 200,
    };
  }

  const shippingOptionsHtml = shippingProfiles
    .map((sp) => `<option value="${sp.shippingProfileId}">${escapeHtml(sp.title)}</option>`)
    .join("");
  const readinessOptionsHtml = readinessStates
    .map((r) => `<option value="${r.readinessStateDefinitionId}">${escapeHtml(r.label)}</option>`)
    .join("");
  const taxonomyOptionsJson = JSON.stringify(
    taxonomyOptions.map((t) => ({ id: t.id, fullPath: t.fullPath }))
  ).replace(/</g, "\\u003c");
  const whenMadeOptionsHtml = WHEN_MADE_OPTIONS.map((v) => `<option value="${v}">${v.replace(/_/g, "-")}</option>`).join(
    ""
  );
  const whoMadeOptionsHtml = WHO_MADE_OPTIONS.map((w) => `<option value="${w.value}">${escapeHtml(w.label)}</option>`).join(
    ""
  );

  const bodyHtml = `
  <h1>List "${escapeHtml(product.title)}" to Etsy</h1>
  ${banner}
  ${alreadyLinkedBanner}

  <form method="POST" action="/list-to-etsy/product?id=${encodeURIComponent(product.id)}">
    <div class="field">
      <label>Title</label>
      <input type="text" name="title" value="${escapeHtml(product.title)}" required>
    </div>
    <div class="field">
      <label>Description</label>
      <textarea name="description" rows="8" required>${escapeHtml(stripHtml(product.descriptionHtml))}</textarea>
    </div>
    <div class="field">
      <label>Price (GBP)</label>
      <input type="number" name="price" step="0.01" min="0.01" value="${escapeHtml(product.price)}" required>
    </div>
    <div class="field">
      <label>Quantity</label>
      <input type="number" name="quantity" step="1" min="1" value="${product.totalInventory > 0 ? product.totalInventory : 1}" required>
    </div>
    <div class="field">
      <label>Category (Etsy taxonomy)</label>
      <div class="combobox" id="taxonomy-combobox">
        <input type="text" id="taxonomy-search" placeholder="Type a word to search, e.g. &quot;bags&quot;" autocomplete="off">
        <div class="combobox-results" id="taxonomy-results"></div>
      </div>
      <input type="hidden" name="taxonomyId" id="taxonomy-id">
      <p class="hint" id="taxonomy-hint">Start typing, then pick a suggestion from the list.</p>
    </div>
    <div class="field">
      <label>Shipping profile</label>
      ${
        shippingProfiles.length > 0
          ? `<select name="shippingProfileId">${shippingOptionsHtml}</select>`
          : `<p class="hint">No Etsy shipping profiles found — create one in Etsy first, or leave the listing without one and set it later.</p>`
      }
    </div>
    <div class="field">
      <label>Processing profile</label>
      ${
        readinessStates.length > 0
          ? `<select name="readinessStateId" required>${readinessOptionsHtml}</select>`
          : `<p class="banner error">No processing profiles found on your Etsy shop, and this app can't create one for you (would need an extra Etsy permission). In Etsy, start creating any listing by hand far enough to set a processing time, save it as a draft, then come back here and re-load this page.</p>`
      }
    </div>
    <div class="field">
      <label>Who made it</label>
      <select name="whoMade">${whoMadeOptionsHtml}</select>
    </div>
    <div class="field">
      <label>When was it made</label>
      <select name="whenMade">${whenMadeOptionsHtml}</select>
    </div>
    <div class="field">
      <label><input type="checkbox" name="isSupply"> This is a craft supply, not a finished product</label>
    </div>
    <button type="submit">Create Etsy draft listing</button>
  </form>
  <p><a href="/list-to-etsy">Back to product list</a></p>
  <script>
    (function () {
      var TAXONOMY_OPTIONS = ${taxonomyOptionsJson};
      var MAX_RESULTS = 30;
      var search = document.getElementById("taxonomy-search");
      var hidden = document.getElementById("taxonomy-id");
      var hint = document.getElementById("taxonomy-hint");
      var results = document.getElementById("taxonomy-results");

      function escapeHtml(s) {
        return s.replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }

      function highlight(text, query) {
        var idx = text.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) return escapeHtml(text);
        return (
          escapeHtml(text.slice(0, idx)) +
          "<mark>" + escapeHtml(text.slice(idx, idx + query.length)) + "</mark>" +
          escapeHtml(text.slice(idx + query.length))
        );
      }

      function closeResults() {
        results.innerHTML = "";
        results.classList.remove("open");
      }

      function render(query) {
        var q = query.trim().toLowerCase();
        if (!q) {
          closeResults();
          return;
        }
        var matches = TAXONOMY_OPTIONS.filter(function (t) {
          return t.fullPath.toLowerCase().indexOf(q) !== -1;
        }).slice(0, MAX_RESULTS);

        if (matches.length === 0) {
          results.innerHTML = '<div class="combobox-result combobox-empty">No matching categories</div>';
          results.classList.add("open");
          return;
        }

        results.innerHTML = matches
          .map(function (t) {
            return (
              '<div class="combobox-result" data-id="' + t.id + '" data-path="' + escapeHtml(t.fullPath) + '">' +
              highlight(t.fullPath, q) +
              "</div>"
            );
          })
          .join("");
        results.classList.add("open");
      }

      function select(id, path) {
        hidden.value = id;
        search.value = path;
        hint.textContent = "Selected.";
        closeResults();
      }

      search.addEventListener("input", function () {
        hidden.value = "";
        hint.textContent = "Start typing, then pick a suggestion from the list.";
        render(search.value);
      });

      search.addEventListener("focus", function () {
        if (search.value.trim()) render(search.value);
      });

      results.addEventListener("mousedown", function (e) {
        var item = e.target.closest(".combobox-result");
        if (!item || !item.dataset.id) return;
        e.preventDefault();
        select(item.dataset.id, item.dataset.path);
      });

      document.addEventListener("click", function (e) {
        if (!e.target.closest("#taxonomy-combobox")) closeResults();
      });

      search.form.addEventListener("submit", function (e) {
        if (!hidden.value) {
          e.preventDefault();
          hint.textContent = "Please pick a category from the suggestions list before submitting.";
          search.focus();
        }
      });
    })();
  </script>`;

  return { ...renderPage({ title: `List "${product.title}" to Etsy`, bodyHtml }), status: 200 };
}

/**
 * Downloads each Shopify product image and uploads it to the new Etsy draft listing.
 * Etsy only accepts JPEG/PNG/GIF, but Shopify commonly serves WebP, so every image is
 * re-encoded to JPEG first. Runs after the listing already exists and is recorded, so a
 * failure here never risks a duplicate listing — it just leaves that image unattached.
 */
async function uploadShopifyImagesToEtsyListing(
  shopId: string,
  listingId: number,
  imageUrls: string[]
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  let rank = 1;
  for (const imageUrl of imageUrls) {
    try {
      const imageRes = await fetch(imageUrl);
      if (!imageRes.ok) throw new Error(`Failed to download image (${imageRes.status})`);
      const original = Buffer.from(await imageRes.arrayBuffer());
      const jpeg = await sharp(original).jpeg({ quality: 90 }).toBuffer();
      await uploadListingImage(shopId, listingId, { data: jpeg, filename: `image-${rank}.jpg` }, rank);
      succeeded++;
    } catch (error) {
      failed++;
      logger.error("Failed to upload product image to Etsy listing", {
        listingId,
        imageUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    rank++;
  }
  return { succeeded, failed };
}

function handleListToEtsyProductGet(url: URL, res: ServerResponse): Promise<void> {
  const productId = url.searchParams.get("id");
  if (!productId) {
    sendHtml(res, 400, "<h1>Missing product id</h1>");
    return Promise.resolve();
  }
  return listToEtsyProductPageHtml({ productId }).then(({ html, headers, status }) => sendHtml(res, status, html, headers));
}

async function handleListToEtsyProductPost(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const productId = url.searchParams.get("id");
  if (!productId) {
    sendHtml(res, 400, "<h1>Missing product id</h1>");
    return;
  }

  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);

  const title = params.get("title")?.trim();
  const description = params.get("description")?.trim();
  const price = Number(params.get("price"));
  const quantity = Number(params.get("quantity"));
  const taxonomyId = Number(params.get("taxonomyId"));
  const whoMade = params.get("whoMade") as DraftListingInput["whoMade"] | null;
  const whenMade = params.get("whenMade");
  const shippingProfileIdRaw = params.get("shippingProfileId");
  const readinessStateId = Number(params.get("readinessStateId"));
  const isSupply = params.has("isSupply");

  if (
    !title ||
    !description ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(taxonomyId) ||
    !whoMade ||
    !whenMade ||
    !Number.isFinite(readinessStateId) ||
    readinessStateId <= 0
  ) {
    const { html, headers, status } = await listToEtsyProductPageHtml({
      productId,
      message: "Please fill in all required fields with valid values.",
      messageIsError: true,
    });
    sendHtml(res, status, html, headers);
    return;
  }

  try {
    const shopId = getShopId();
    const { listingId } = await createDraftListing(shopId, {
      title,
      description,
      price,
      quantity,
      whoMade,
      whenMade,
      taxonomyId,
      isSupply,
      shippingProfileId: shippingProfileIdRaw ? Number(shippingProfileIdRaw) : undefined,
      readinessStateId,
    });

    // Recorded immediately after the listing is created — matches the same lesson learned
    // from the order sync's duplicate-prevention fix: never defer the "this happened" record
    // past a later step, or a retry after a later failure can create a second draft listing.
    recordEtsyListingLink(productId, String(listingId));
    logger.info("Created Etsy draft listing from Shopify product", { productId, listingId });

    const product = await getProductDetail(productId);
    let imageSummary = "No product images found to upload.";
    if (product && product.imageUrls.length > 0) {
      const { succeeded, failed } = await uploadShopifyImagesToEtsyListing(shopId, listingId, product.imageUrls);
      imageSummary =
        failed === 0
          ? `${succeeded}/${product.imageUrls.length} product image(s) uploaded.`
          : `${succeeded}/${product.imageUrls.length} product image(s) uploaded (${failed} failed — check logs).`;
    }

    const { html, headers, status } = await listToEtsyProductPageHtml({
      productId,
      message: `Draft listing #${listingId} created on Etsy. ${imageSummary} Review it on Etsy before publishing.`,
    });
    sendHtml(res, status, html, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create Etsy draft listing.";
    logger.error("Failed to create Etsy draft listing", { productId, error: message });
    const { html, headers, status } = await listToEtsyProductPageHtml({ productId, message, messageIsError: true });
    sendHtml(res, status, html, headers);
  }
}

interface SetupField {
  key: OverridableKey;
  label: string;
  type: "text" | "password" | "number" | "checkbox" | "date";
  help?: string;
}

const SETUP_FIELDS: SetupField[] = [
  { key: "ETSY_CLIENT_ID", label: "Etsy Client ID (keystring)", type: "text" },
  { key: "ETSY_CLIENT_SECRET", label: "Etsy Client Secret", type: "password" },
  { key: "SHOPIFY_STORE_DOMAIN", label: "Shopify Store Domain", type: "text", help: "e.g. your-shop.myshopify.com" },
  { key: "SHOPIFY_CLIENT_ID", label: "Shopify Client ID", type: "text" },
  { key: "SHOPIFY_CLIENT_SECRET", label: "Shopify Client Secret", type: "password" },
  {
    key: "PUBLIC_BASE_URL",
    label: "Public Base URL",
    type: "text",
    help: "This service's own public HTTPS URL, e.g. https://your-app.up.railway.app",
  },
  { key: "SYNC_INTERVAL_MINUTES", label: "Sync interval (minutes)", type: "number" },
  { key: "DRY_RUN", label: "Dry run (log only, no real Shopify writes)", type: "checkbox" },
  {
    key: "BACKFILL_SINCE",
    label: "Backfill since (date)",
    type: "date",
    help: "One-time historical import start date. Remove/clear it again once it's run once.",
  },
];

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function renderSetupField(field: SetupField, config: ReturnType<typeof getEffectiveConfig>): string {
  const currentValue = config[field.key as keyof typeof config];

  if (field.type === "checkbox") {
    return `<div class="field">
      <label><input type="checkbox" name="${field.key}" ${currentValue ? "checked" : ""}> ${escapeHtml(field.label)}</label>
    </div>`;
  }

  if (field.type === "password") {
    const status = currentValue ? "currently set" : "not set";
    return `<div class="field">
      <label>${escapeHtml(field.label)} <span class="hint">(${status} — leave blank to keep unchanged)</span></label>
      <input type="password" name="${field.key}" placeholder="•••••••• (${status})">
    </div>`;
  }

  return `<div class="field">
    <label>${escapeHtml(field.label)}</label>
    <input type="${field.type}" name="${field.key}" value="${escapeHtml(currentValue ? String(currentValue) : "")}">
    ${field.help ? `<p class="hint">${escapeHtml(field.help)}</p>` : ""}
  </div>`;
}

function setupPageHtml(params: { message?: string; messageIsError?: boolean }): { html: string; headers?: Record<string, string> } {
  const config = getEffectiveConfig();
  const { SETUP_PASSWORD } = getEnv();
  const fieldsHtml = SETUP_FIELDS.map((f) => renderSetupField(f, config)).join("\n");

  const banner = params.message
    ? `<p class="banner ${params.messageIsError ? "error" : "success"}">${escapeHtml(params.message)}</p>`
    : "";

  const passwordWarning = !SETUP_PASSWORD
    ? `<p class="banner error">SETUP_PASSWORD is not set as an environment variable — this form can't save changes until it is.</p>`
    : "";

  const bodyHtml = `
  <h1>Setup</h1>

  ${banner}
  ${passwordWarning}

  <form method="POST" action="/setup">
    ${fieldsHtml}
    <div class="field">
      <label>Setup password</label>
      <input type="password" name="password" required>
    </div>
    <button type="submit">Save</button>
  </form>`;

  return renderPage({ title: "Etsy → Shopify sync setup", bodyHtml });
}

function handleSetupGet(res: ServerResponse): void {
  const { html, headers } = setupPageHtml({});
  sendHtml(res, 200, html, headers);
}

async function handleSetupPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const { SETUP_PASSWORD } = getEnv();

  if (!SETUP_PASSWORD) {
    const { html, headers } = setupPageHtml({ message: "SETUP_PASSWORD is not configured — set it as an env var first.", messageIsError: true });
    sendHtml(res, 403, html, headers);
    return;
  }
  if (params.get("password") !== SETUP_PASSWORD) {
    const { html, headers } = setupPageHtml({ message: "Incorrect setup password.", messageIsError: true });
    sendHtml(res, 401, html, headers);
    return;
  }

  let shopifyCredentialsChanged = false;
  for (const field of SETUP_FIELDS) {
    if (field.type === "checkbox") {
      setConfigOverride(field.key, params.has(field.key) ? "true" : "false");
      continue;
    }
    const value = params.get(field.key);
    if (value) {
      setConfigOverride(field.key, value);
      if (field.key === "SHOPIFY_STORE_DOMAIN" || field.key === "SHOPIFY_CLIENT_ID" || field.key === "SHOPIFY_CLIENT_SECRET") {
        shopifyCredentialsChanged = true;
      }
    }
  }

  if (shopifyCredentialsChanged) {
    clearCachedShopifyToken();
  }

  logger.info("Settings updated via /setup");
  const { html, headers } = setupPageHtml({ message: "Settings saved." });
  sendHtml(res, 200, html, headers);
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
        if (url.pathname === "/setup" && req.method === "POST") return handleSetupPost(req, res);
        if (url.pathname === "/setup") return handleSetupGet(res);
        if (url.pathname === "/sku-linking" && req.method === "POST") return handleSkuLinkingPost(req, res);
        if (url.pathname === "/sku-linking") return handleSkuLinkingGet(res);
        if (url.pathname === "/list-to-etsy/product" && req.method === "POST") return handleListToEtsyProductPost(url, req, res);
        if (url.pathname === "/list-to-etsy/product") return handleListToEtsyProductGet(url, res);
        if (url.pathname === "/list-to-etsy") return handleListToEtsyGet(res);
        if (url.pathname === "/log") return handleLogPage(res);
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
