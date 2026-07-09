import { getDb } from "./client.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

const PROVIDER = "etsy";

export function saveEtsyTokens(tokens: TokenPair): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  ).run(PROVIDER, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, Date.now());
}

export function getEtsyTokens(): TokenPair | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = ?`
    )
    .get(PROVIDER) as
    | { access_token: string; refresh_token: string; expires_at: number }
    | undefined;
  if (!row) return undefined;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: row.expires_at,
  };
}
