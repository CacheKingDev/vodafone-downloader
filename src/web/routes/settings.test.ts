import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

async function buildTestApp(): Promise<{
  app: FastifyInstance;
  settingsRepo: DrizzleSettingsRepository;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const settingsRepo = new DrizzleSettingsRepository(db);
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: new DrizzleAccountRepository(db, cipher),
    invoices: new DrizzleInvoiceRepository(db),
    runs: new DrizzleRunRepository(db),
    settings: settingsRepo,
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount: async () => undefined,
    downloadsDir: join(dir, "downloads"),
  });
  return { app: testApp, settingsRepo };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /settings", () => {
  it("shows the current filename template and sync schedule", async () => {
    const { app: testApp, settingsRepo } = await buildTestApp();
    app = testApp;
    await settingsRepo.setFilenameTemplate("{account_label}/{invoice_number}.pdf");
    await settingsRepo.setSyncSchedule("0 7 * * *");

    const response = await app.inject({ method: "GET", url: "/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('value="{account_label}/{invoice_number}.pdf"');
    expect(response.body).toContain('value="0 7 * * *"');
  });
});

describe("POST /settings", () => {
  it("persists a valid template and schedule and redirects to /settings", async () => {
    const { app: testApp, settingsRepo } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/settings" });

    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{account_label}/{year}/{invoice_number}.pdf",
        syncSchedule: "0 8 * * *",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/settings");
    expect(await settingsRepo.filenameTemplate()).toBe(
      "{account_label}/{year}/{invoice_number}.pdf",
    );
    expect(await settingsRepo.syncSchedule()).toBe("0 8 * * *");
  });

  it("maps the weekly preset onto its cron expression, overriding an explicit schedule", async () => {
    const { app: testApp, settingsRepo } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/settings" });

    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{account_label}/{invoice_number}.pdf",
        syncSchedule: "0 9 * * *",
        preset: "weekly",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(302);
    expect(await settingsRepo.syncSchedule()).toBe("0 6 * * 1");
  });

  it("shows a flash error and persists nothing for an invalid template", async () => {
    const { app: testApp, settingsRepo } = await buildTestApp();
    app = testApp;
    await settingsRepo.setFilenameTemplate("{account_label}/{invoice_number}.pdf");
    await settingsRepo.setSyncSchedule("0 6 * * *");
    const form = await app.inject({ method: "GET", url: "/settings" });

    const response = await app.inject({
      method: "POST",
      url: "/settings",
      cookies: cookieHeader(form),
      payload: {
        filenameTemplate: "{unknown_placeholder}.pdf",
        syncSchedule: "0 10 * * *",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Settings konnten nicht gespeichert werden.");
    expect(await settingsRepo.filenameTemplate()).toBe("{account_label}/{invoice_number}.pdf");
    expect(await settingsRepo.syncSchedule()).toBe("0 6 * * *");
  });
});
