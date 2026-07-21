import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import { hashAdminPassword } from "../../infrastructure/auth/admin-auth.js";
import { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import { SessionStore } from "../../infrastructure/auth/session-store.js";
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
    getFileStorage: async () => new AtomicFileStorage(join(dir, "downloads")),
  });
  return { app: testApp, settingsRepo };
}

const ADMIN_PASSWORD = "s3cret-admin-password";

async function buildAuthedTestApp(): Promise<{
  app: FastifyInstance;
  settingsRepo: DrizzleSettingsRepository;
  sessions: SessionStore;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-route-authed-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const settingsRepo = new DrizzleSettingsRepository(db);
  const sessions = new SessionStore(db);
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
    getFileStorage: async () => new AtomicFileStorage(join(dir, "downloads")),
    passwordHash: hashAdminPassword(ADMIN_PASSWORD),
    sessions,
  });
  return { app: testApp, settingsRepo, sessions };
}

async function login(testApp: FastifyInstance): Promise<Record<string, string>> {
  const form = await testApp.inject({ method: "GET", url: "/login" });
  const response = await testApp.inject({
    method: "POST",
    url: "/login",
    cookies: cookieHeader(form),
    payload: { password: ADMIN_PASSWORD, _csrf: extractCsrfToken(form.body) },
  });
  return cookieHeader(response);
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

describe("POST /settings/admin-password", () => {
  it("changes the password and confirms with a success flash", async () => {
    const { app: testApp, settingsRepo } = await buildAuthedTestApp();
    app = testApp;
    const cookies = await login(app);
    const form = await app.inject({ method: "GET", url: "/settings", cookies });

    const response = await app.inject({
      method: "POST",
      url: "/settings/admin-password",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "a new secret",
        newPasswordConfirm: "a new secret",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Admin-Passwort wurde geändert.");
    expect(await settingsRepo.adminPasswordHash()).not.toBeNull();
  });

  it("logs in with the new password after a successful change", async () => {
    const { app: testApp } = await buildAuthedTestApp();
    app = testApp;
    const cookies = await login(app);
    const form = await app.inject({ method: "GET", url: "/settings", cookies });
    await app.inject({
      method: "POST",
      url: "/settings/admin-password",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "a new secret",
        newPasswordConfirm: "a new secret",
        _csrf: extractCsrfToken(form.body),
      },
    });

    const loginForm = await app.inject({ method: "GET", url: "/login" });
    const loginResponse = await app.inject({
      method: "POST",
      url: "/login",
      cookies: cookieHeader(loginForm),
      payload: { password: "a new secret", _csrf: extractCsrfToken(loginForm.body) },
    });

    expect(loginResponse.statusCode).toBe(302);
    expect(loginResponse.headers.location).toBe("/dashboard");
  });

  it("rejects the wrong current password and persists nothing", async () => {
    const { app: testApp, settingsRepo } = await buildAuthedTestApp();
    app = testApp;
    const cookies = await login(app);
    const form = await app.inject({ method: "GET", url: "/settings", cookies });

    const response = await app.inject({
      method: "POST",
      url: "/settings/admin-password",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: {
        currentPassword: "wrong",
        newPassword: "a new secret",
        newPasswordConfirm: "a new secret",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Aktuelles Passwort ist falsch.");
    expect(await settingsRepo.adminPasswordHash()).toBeNull();
  });

  it("rejects a mismatched confirmation and persists nothing", async () => {
    const { app: testApp, settingsRepo } = await buildAuthedTestApp();
    app = testApp;
    const cookies = await login(app);
    const form = await app.inject({ method: "GET", url: "/settings", cookies });

    const response = await app.inject({
      method: "POST",
      url: "/settings/admin-password",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "a new secret",
        newPasswordConfirm: "does not match",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Neue Passwörter stimmen nicht überein.");
    expect(await settingsRepo.adminPasswordHash()).toBeNull();
  });

  it("invalidates every other session but keeps the current one", async () => {
    const { app: testApp, sessions } = await buildAuthedTestApp();
    app = testApp;
    const cookies = await login(app);
    const otherSession = sessions.create();
    const form = await app.inject({ method: "GET", url: "/settings", cookies });

    await app.inject({
      method: "POST",
      url: "/settings/admin-password",
      cookies: { ...cookies, ...cookieHeader(form) },
      payload: {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "a new secret",
        newPasswordConfirm: "a new secret",
        _csrf: extractCsrfToken(form.body),
      },
    });

    expect(sessions.verify(cookies.session)).toBe(true);
    expect(sessions.verify(otherSession.token)).toBe(false);
  });
});
