import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset, Invoice } from "../../domain/invoice.js";
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
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

async function buildTestApp(nextRun: () => Date | null): Promise<{
  app: FastifyInstance;
  accountsRepo: DrizzleAccountRepository;
  invoicesRepo: DrizzleInvoiceRepository;
  runsRepo: DrizzleRunRepository;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-dashboard-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const accountsRepo = new DrizzleAccountRepository(db, cipher);
  const invoicesRepo = new DrizzleInvoiceRepository(db);
  const runsRepo = new DrizzleRunRepository(db);
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: accountsRepo,
    invoices: invoicesRepo,
    runs: runsRepo,
    settings: new DrizzleSettingsRepository(db),
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount: async () => undefined,
    downloadsDir: join(dir, "downloads"),
    nextRun,
  });
  return { app: testApp, accountsRepo, invoicesRepo, runsRepo };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /dashboard", () => {
  it("shows accounts, recent invoices and recent runs", async () => {
    const { app: testApp, accountsRepo, invoicesRepo, runsRepo } = await buildTestApp(() => null);
    app = testApp;
    const accountId = await accountsRepo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const issuedOn = new Date().toISOString().slice(0, 10);
    const invoice: Invoice = {
      number: "2026-0007",
      issuedOn,
      dueOn: null,
      amountCents: 1999,
      currency: "EUR",
      subject: "Mobilfunk",
      contractNumber: "123456789",
      documents: [],
    };
    await invoicesRepo.insertInvoice(accountId, invoice);
    const runId = await runsRepo.startRun(accountId, "manual");
    await runsRepo.finishRun(runId, {
      outcome: "success",
      invoicesSeen: 1,
      documentsStored: 1,
      errorMessage: null,
    });

    const response = await app.inject({ method: "GET", url: "/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Privat");
    expect(response.body).toContain("2026-0007");
    expect(response.body).toContain("Erfolgreich");
  });

  it("shows a dash when no scheduled run is planned", async () => {
    ({ app } = await buildTestApp(() => null));

    const response = await app.inject({ method: "GET", url: "/dashboard" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Nächster Lauf");
  });
});

describe("GET /", () => {
  it("redirects to /dashboard", async () => {
    ({ app } = await buildTestApp(() => null));

    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/dashboard");
  });
});
