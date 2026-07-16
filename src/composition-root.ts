import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type AppConfig, loadConfig } from "./config/env.js";
import { Cipher } from "./infrastructure/crypto/cipher.js";
import { loadOrCreateKey } from "./infrastructure/crypto/key-store.js";
import { createLogger, type Logger } from "./infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "./infrastructure/persistence/database.js";
import { buildServer } from "./web/server.js";

export const VERSION = "0.1.0";

export interface Application {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly cipher: Cipher;
  readonly db: Database;
  readonly shutdown: () => Promise<void>;
}

/**
 * The single place where concrete implementations meet.
 *
 * Wiring by hand rather than through a DI container: one file shows every
 * dependency, and the compiler checks it.
 */
export async function createApplication(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Application> {
  const config = loadConfig(env);

  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === "development",
  });

  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.downloadsDir, { recursive: true });

  const cipher = new Cipher(loadOrCreateKey(config.configDir, config.encryptionKey));

  const db = createDatabase({
    file: join(config.configDir, "app.sqlite"),
    migrationsFolder: "./drizzle",
  });

  const app = await buildServer({ db, logger, version: VERSION });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close();
    closeDatabase(db);
  };

  return { app, config, logger, cipher, db, shutdown };
}
