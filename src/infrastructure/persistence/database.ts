import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { PersistenceError } from "../../domain/errors.js";
import * as schema from "./schema.js";

export type Database = BetterSQLite3Database<typeof schema> & {
  $client: SqliteDatabase.Database;
};

export interface DatabaseOptions {
  readonly file: string;
  readonly migrationsFolder: string;
}

/**
 * Opens the database, applies pragmas and runs pending migrations.
 *
 * foreign_keys is off by default in SQLite and must be set per connection —
 * without it, ON DELETE CASCADE is silently ignored.
 */
export function createDatabase(options: DatabaseOptions): Database {
  mkdirSync(dirname(options.file), { recursive: true });

  let client: SqliteDatabase.Database;
  try {
    client = new SqliteDatabase(options.file);
  } catch (cause) {
    throw new PersistenceError(`Cannot open database at ${options.file}`, { cause });
  }

  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");

  const db = drizzle(client, { schema });

  try {
    migrate(db, { migrationsFolder: options.migrationsFolder });
  } catch (cause) {
    client.close();
    throw new PersistenceError("Database migration failed", { cause });
  }

  return db as Database;
}

export function closeDatabase(db: Database): void {
  db.$client.close();
}
