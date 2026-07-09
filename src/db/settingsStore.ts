import { getDb } from "./client.js";

/** Generic key/value settings, sharing the `checkpoint` table (it's just string k/v storage). */
export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM checkpoint WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO checkpoint (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
