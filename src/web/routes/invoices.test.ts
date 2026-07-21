import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
import { account, invoice, invoiceDocument } from "../../infrastructure/persistence/schema.js";
import { AtomicFileStorage } from "../../infrastructure/storage/atomic-file-storage.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

async function buildTestApp(overrides?: {
  runAccount?: (accountId: number, trigger: RunTrigger) => Promise<unknown>;
}): Promise<{ app: FastifyInstance; downloadsDir: string }> {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const downloadsDir = join(dir, "downloads");
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
    runAccount: overrides?.runAccount ?? (async () => undefined),
    getFileStorage: async () => new AtomicFileStorage(downloadsDir),
  });
  return { app: testApp, downloadsDir };
}

function seedStoredDocument(relativePath: string): { documentId: number; accountId: number } {
  const [acc] = db
    .insert(account)
    .values({
      label: "Test",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:test:1",
      status: "ok",
    })
    .returning()
    .all();
  if (acc === undefined) throw new Error("seed failed");

  const [inv] = db
    .insert(invoice)
    .values({ accountId: acc.id, number: "R-1", issuedOn: "2026-01-01", amountCents: 100 })
    .returning()
    .all();
  if (inv === undefined) throw new Error("seed failed");

  const [doc] = db
    .insert(invoiceDocument)
    .values({
      invoiceId: inv.id,
      remoteDocumentId: "doc-1",
      state: "stored",
      relativePath,
      sha256: "irrelevant-for-this-test",
      sizeBytes: 8,
      storedAt: 1,
    })
    .returning()
    .all();
  if (doc === undefined) throw new Error("seed failed");
  return { documentId: doc.id, accountId: acc.id };
}

describe("GET /invoices/documents/:id", () => {
  it("streams the stored PDF bytes", async () => {
    const { app: testApp, downloadsDir } = await buildTestApp();
    app = testApp;
    await new AtomicFileStorage(downloadsDir).store("2026/r.pdf", Buffer.from("%PDF-1.4"));
    const { documentId } = seedStoredDocument("2026/r.pdf");

    const response = await app.inject({ method: "GET", url: `/invoices/documents/${documentId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("%PDF-1.4");
    expect(response.headers["content-type"]).toContain("application/pdf");
  });

  it("returns 404 for an unknown document id", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/invoices/documents/999" });

    expect(response.statusCode).toBe(404);
  });

  it("renders a redownload page instead of a raw error when the stored file is missing", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;
    const { documentId } = seedStoredDocument("2026/never-written.pdf");

    const response = await app.inject({ method: "GET", url: `/invoices/documents/${documentId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Jetzt erneut herunterladen");
    expect(response.body).toContain(`/invoices/documents/${documentId}/redownload`);
  });
});

describe("POST /invoices/documents/:id/redownload", () => {
  it("resets the document to pending and triggers a sync run for its account", async () => {
    const calls: Array<{ accountId: number; trigger: RunTrigger }> = [];
    const { app: testApp } = await buildTestApp({
      runAccount: async (accountId, trigger) => {
        calls.push({ accountId, trigger });
      },
    });
    app = testApp;
    const { documentId, accountId } = seedStoredDocument("2026/gone.pdf");

    const response = await app.inject({
      method: "POST",
      url: `/invoices/documents/${documentId}/redownload`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/invoices");
    expect(calls).toEqual([{ accountId, trigger: "manual" }]);
    const row = db.select().from(invoiceDocument).where(eq(invoiceDocument.id, documentId)).get();
    expect(row?.state).toBe("pending");
    expect(row?.relativePath).toBeNull();
  });

  it("does not trigger a sync run for an unknown document id", async () => {
    const calls: unknown[] = [];
    const { app: testApp } = await buildTestApp({
      runAccount: async () => {
        calls.push(undefined);
      },
    });
    app = testApp;

    const response = await app.inject({
      method: "POST",
      url: "/invoices/documents/999/redownload",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/invoices");
    expect(calls).toHaveLength(0);
  });
});
