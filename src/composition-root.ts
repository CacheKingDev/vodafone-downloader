import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type RunAllResult, RunCoordinator, type RunSummary } from "./application/run-sync.js";
import { type SyncReport, syncAccount } from "./application/sync-invoices.js";
import { type AppConfig, loadConfig } from "./config/env.js";
import type { RunTrigger } from "./domain/ports/repositories.js";
import { hashAdminPassword } from "./infrastructure/auth/admin-auth.js";
import { DiscoveryTokenStore } from "./infrastructure/auth/discovery-token-store.js";
import { SessionStore } from "./infrastructure/auth/session-store.js";
import { Cipher } from "./infrastructure/crypto/cipher.js";
import { loadOrCreateKey } from "./infrastructure/crypto/key-store.js";
import { createLogger, type Logger } from "./infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "./infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "./infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "./infrastructure/persistence/repositories/invoice-repository.js";
import { DrizzleRunRepository } from "./infrastructure/persistence/repositories/run-repository.js";
import { DrizzleSettingsRepository } from "./infrastructure/persistence/repositories/settings-repository.js";
import { SyncScheduler } from "./infrastructure/scheduler/scheduler.js";
import { AtomicFileStorage } from "./infrastructure/storage/atomic-file-storage.js";
import { renderFilename } from "./infrastructure/storage/filename-template.js";
import { validatePdf } from "./infrastructure/storage/pdf.js";
import { VodafoneApiClient } from "./infrastructure/vodafone/api-client.js";
import { VodafoneAuthenticator } from "./infrastructure/vodafone/authenticator.js";
import { VodafoneProviderFacade } from "./infrastructure/vodafone/provider.js";
import { buildServer } from "./web/server.js";

export const VERSION = "0.1.0";

export interface Application {
  readonly app: FastifyInstance;
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly cipher: Cipher;
  readonly db: Database;
  readonly sync: (accountId: number) => Promise<SyncReport>;
  readonly runAll: (trigger: RunTrigger) => Promise<RunAllResult>;
  readonly runAccount: (accountId: number, trigger: RunTrigger) => Promise<RunSummary | null>;
  readonly scheduler: SyncScheduler;
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

  mkdirSync(config.configDir, { recursive: true });
  mkdirSync(config.downloadsDir, { recursive: true });
  const logFile = join(config.configDir, "app.log");

  const logger = createLogger({
    level: config.logLevel,
    pretty: config.nodeEnv === "development",
    logFile,
  });

  const cipher = new Cipher(loadOrCreateKey(config.configDir, config.encryptionKey));

  const db = createDatabase({
    file: join(config.configDir, "app.sqlite"),
    migrationsFolder: "./drizzle",
  });

  const accounts = new DrizzleAccountRepository(db, cipher);
  const invoices = new DrizzleInvoiceRepository(db);
  const settings = new DrizzleSettingsRepository(db);
  const storage = new AtomicFileStorage(config.downloadsDir);
  const sessions = new SessionStore(db);
  sessions.deleteExpired();

  // Portal endpoints (design spec section 3). Silent renewal is confirmed
  // supported by the milestone 2 smoke experiment.
  const authenticator = new VodafoneAuthenticator({
    loginUrl: "https://www.vodafone.de/meinvodafone/account/",
    tokenUrl: "https://www.vodafone.de/mint/oidc/token",
    authorizeUrl:
      "https://www.vodafone.de/mint/oidc/authorize?prompt=none&response_type=code&scope=openid",
    artifactsDir: join(config.configDir, "artifacts"),
    silentRenewalSupported: true,
    logger,
    headless: true,
  });
  const apiClient = new VodafoneApiClient({
    baseUrl: "https://api.vodafone.de/meinvodafone/v2",
  });
  const provider = new VodafoneProviderFacade({
    authenticator,
    apiClient,
    silentRenewalSupported: true,
  });

  const sync = (accountId: number): Promise<SyncReport> =>
    syncAccount(
      { provider, accounts, invoices, settings, storage, renderFilename, validatePdf },
      accountId,
    );

  const runs = new DrizzleRunRepository(db);

  // Reconcile interrupted runs from a crashed or killed previous process:
  // anything started more than 15 min ago without a finish is "failed (interrupted)".
  await runs.orphanCleanup(15 * 60 * 1000);

  const coordinator = new RunCoordinator({ accounts, runs, sync, logger });

  const scheduler = new SyncScheduler({
    schedule: await settings.syncSchedule(),
    artifactsDir: join(config.configDir, "artifacts"),
    runAll: () => coordinator.runAll("schedule"),
    logger,
  });

  const app = await buildServer({
    db,
    logger,
    version: VERSION,
    accounts,
    invoices,
    runs,
    settings,
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (credentials) => {
      const session = await provider.getSession(credentials);
      return provider.discoverAssets(session);
    },
    runAccount: (accountId, trigger) => coordinator.runAccount(accountId, trigger),
    renewSession: async (accountId) => {
      const account = await accounts.findById(accountId);
      if (account === undefined) return;
      const session = await provider.getSession(account.credentials);
      await accounts.saveSession(accountId, session);
    },
    passwordHash: hashAdminPassword(config.adminPassword),
    sessions,
    secureCookie: config.nodeEnv === "production",
    downloadsDir: config.downloadsDir,
    logFile,
    nextRun: () => scheduler.nextSyncRun(),
  });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    scheduler.stop();
    try {
      await app.close();
    } finally {
      // The database must close even if the server teardown fails, or the
      // SQLite handle leaks — `closed` is already set, so no retry will reach it.
      closeDatabase(db);
    }
  };

  return {
    app,
    config,
    logger,
    cipher,
    db,
    sync,
    runAll: (trigger) => coordinator.runAll(trigger),
    runAccount: (accountId, trigger) => coordinator.runAccount(accountId, trigger),
    scheduler,
    shutdown,
  };
}
