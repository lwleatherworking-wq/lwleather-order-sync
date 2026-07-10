import { randomBytes, createHash } from "node:crypto";
import { requireEtsyCredentials } from "../config/effectiveConfig.js";
import type { EtsyTokenResponse } from "./types.js";

const AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

// Etsy requires transactions_r to read shop receipts, and shops_r so the setup
// flow can call GET /v3/application/users/me to discover the shop id.
const SCOPES = "transactions_r shops_r";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generates a PKCE verifier/challenge pair per RFC 7636, as required by every Etsy OAuth flow. */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

export function buildAuthorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string {
  const { clientId } = requireEtsyCredentials();
  // Built manually (not via URLSearchParams) so the space in `scope` is encoded as %20,
  // matching Etsy's documented example exactly, rather than URLSearchParams' "+".
  const query = [
    ["response_type", "code"],
    ["client_id", clientId],
    ["redirect_uri", params.redirectUri],
    ["scope", SCOPES],
    ["state", params.state],
    ["code_challenge", params.codeChallenge],
    ["code_challenge_method", "S256"],
  ]
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `${AUTHORIZE_URL}?${query}`;
}

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<EtsyTokenResponse> {
  const { clientId } = requireEtsyCredentials();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: params.redirectUri,
    code: params.code,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Etsy token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as EtsyTokenResponse;
}

export async function refreshEtsyTokens(refreshToken: string): Promise<EtsyTokenResponse> {
  const { clientId } = requireEtsyCredentials();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Etsy token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as EtsyTokenResponse;
}

/** Extracts the numeric Etsy user id prefix from an access/refresh token (e.g. "12345678.abc..."). */
export function extractUserId(token: string): string {
  const [userId] = token.split(".");
  return userId;
}
