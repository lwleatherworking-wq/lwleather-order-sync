import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEnv } from "../config/env.js";

let db: DatabaseSync | undefined;

/**
 * Migration SQL lives in src/ (not compiled) and is read relative to the
 * process working directory, which is always the project root whether
 * running via ts-compiled dist/ in dev or the deployed container — this
 * avoids needing a build step to copy .sql files into dist/.
 */
function runMigrations(database: DatabaseSync): void {
  const migrationPath = join(process.cwd(), "src", "db", "migrations", "001_init.sql");
  const sql = readFileSync(migrationPath, "utf-8");
  database.exec(sql);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const { DB_PATH } = getEnv();
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  runMigrations(db);
  return db;
}
