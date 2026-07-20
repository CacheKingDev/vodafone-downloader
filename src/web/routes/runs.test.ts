import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import type { RunTrigger } from "../../domain/ports/repositories.js";
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

function cookieHeader(response: {
  cookies: Array<{ name: string; value: string }>;
}): Record<string, string> {
  return Object.fromEntries(response.cookies.map((c) => [c.name, c.value]));
}

function extractCsrfToken(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (match?.[1] === undefined) throw new Error("csrf token not found in response body");
  return match[1];
}

async function buildTestApp(
  runAccount: (accountId: number, trigger: RunTrigger) => Promise<unknown>,
): Promise<{
  app: FastifyInstance;
  accountsRepo: DrizzleAccountRepository;
  runsRepo: DrizzleRunRepository;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-runs-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const accountsRepo = new DrizzleAccountRepository(db, cipher);
  const runsRepo = new DrizzleRunRepository(db);
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: accountsRepo,
    invoices: new DrizzleInvoiceRepository(db),
    runs: runsRepo,
    settings: new DrizzleSettingsRepository(db),
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount,
    downloadsDir: join(dir, "downloads"),
  });
  return { app: testApp, accountsRepo, runsRepo };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /runs", () => {
  it("lists existing accounts and recent runs", async () => {
    const { app: testApp, accountsRepo, runsRepo } = await buildTestApp(async () => undefined);
    app = testApp;
    const accountId = await accountsRepo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const runId = await runsRepo.startRun(accountId, "manual");
    await runsRepo.finishRun(runId, {
      outcome: "success",
      invoicesSeen: 2,
      documentsStored: 2,
      errorMessage: null,
    });

    const response = await app.inject({ method: "GET", url: "/runs" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Privat");
    expect(response.body).toContain(`/runs/${runId}`);
  });
});

describe("POST /runs", () => {
  it("triggers runAccount for a valid accountId and redirects to /runs", async () => {
    const calls: Array<{ accountId: number; trigger: RunTrigger }> = [];
    const { app: testApp, accountsRepo } = await buildTestApp(async (accountId, trigger) => {
      calls.push({ accountId, trigger });
    });
    app = testApp;
    const accountId = await accountsRepo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const form = await app.inject({ method: "GET", url: "/runs" });

    const response = await app.inject({
      method: "POST",
      url: "/runs",
      cookies: cookieHeader(form),
      payload: { accountId: String(accountId), _csrf: extractCsrfToken(form.body) },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/runs");
    expect(calls).toEqual([{ accountId, trigger: "manual" }]);
  });
});

describe("GET /runs/:id", () => {
  it("shows the run detail for an existing run", async () => {
    const { app: testApp, accountsRepo, runsRepo } = await buildTestApp(async () => undefined);
    app = testApp;
    const accountId = await accountsRepo.create({
      label: "Privat",
      credentials: { username: "u", password: "p" },
      customerUrn: "urn:x",
      status: "ok",
    });
    const runId = await runsRepo.startRun(accountId, "schedule");
    await runsRepo.finishRun(runId, {
      outcome: "partial",
      invoicesSeen: 3,
      documentsStored: 1,
      errorMessage: "one document failed",
    });

    const response = await app.inject({ method: "GET", url: `/runs/${runId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("one document failed");
  });

  it("returns 404 for an unknown run id", async () => {
    ({ app } = await buildTestApp(async () => undefined));

    const response = await app.inject({ method: "GET", url: "/runs/999999" });

    expect(response.statusCode).toBe(404);
  });
});
