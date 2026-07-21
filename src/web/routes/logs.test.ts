import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import { createLogger } from "../../infrastructure/logging/logger.js";
import {
  closeDatabase,
  createDatabase,
  type Database,
} from "../../infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "../../infrastructure/persistence/repositories/invoice-repository.js";
import { DrizzleRunRepository } from "../../infrastructure/persistence/repositories/run-repository.js";
import { DrizzleSettingsRepository } from "../../infrastructure/persistence/repositories/settings-repository.js";
import { AtomicFileStorage } from "../../infrastructure/storage/atomic-file-storage.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

const LOG_LINES = [
  { level: 10, time: "t1", msg: "trace msg" },
  { level: 20, time: "t2", msg: "debug msg" },
  { level: 30, time: "t3", msg: "info msg" },
  { level: 40, time: "t4", msg: "warn msg" },
  { level: 50, time: "t5", msg: "error msg" },
  { level: 60, time: "t6", msg: "fatal msg" },
];

async function buildTestApp(): Promise<{ app: FastifyInstance; logFile: string }> {
  dir = mkdtempSync(join(tmpdir(), "vid-logs-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const logFile = join(dir, "app.log");
  writeFileSync(logFile, `${LOG_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: new DrizzleAccountRepository(db, cipher),
    invoices: new DrizzleInvoiceRepository(db),
    runs: new DrizzleRunRepository(db),
    settings: new DrizzleSettingsRepository(db),
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount: async () => undefined,
    getFileStorage: async () => new AtomicFileStorage(join(dir, "downloads")),
    logFile,
  });
  return { app: testApp, logFile };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /logs", () => {
  it("shows log lines at or above the default info level", async () => {
    ({ app } = await buildTestApp());

    const response = await app.inject({ method: "GET", url: "/logs" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("info msg");
    expect(response.body).toContain("warn msg");
    expect(response.body).toContain("error msg");
    expect(response.body).not.toContain("trace msg");
    expect(response.body).not.toContain("debug msg");
  });

  it("filters out levels below the requested minimum", async () => {
    ({ app } = await buildTestApp());

    const response = await app.inject({ method: "GET", url: "/logs?level=error" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("error msg");
    expect(response.body).toContain("fatal msg");
    expect(response.body).not.toContain("warn msg");
    expect(response.body).not.toContain("info msg");
  });
});

describe("GET /logs/fragment", () => {
  it("returns only the fragment, without the page layout", async () => {
    ({ app } = await buildTestApp());

    const response = await app.inject({ method: "GET", url: "/logs/fragment?level=info" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("info msg");
    expect(response.body).not.toContain("<!DOCTYPE html>");
    expect(response.body).not.toContain("<html");
  });
});
