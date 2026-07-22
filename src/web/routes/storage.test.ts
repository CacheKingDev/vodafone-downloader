import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import type { FileStorage } from "../../domain/ports/file-storage.js";
import type { StorageConfig } from "../../domain/storage-config.js";
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
import { DrizzleMigrationRepository } from "../../infrastructure/persistence/repositories/migration-repository.js";
import { DrizzleRunRepository } from "../../infrastructure/persistence/repositories/run-repository.js";
import { DrizzleSettingsRepository } from "../../infrastructure/persistence/repositories/settings-repository.js";
import { DrizzleStorageTargetRepository } from "../../infrastructure/persistence/repositories/storage-target-repository.js";
import { AtomicFileStorage } from "../../infrastructure/storage/atomic-file-storage.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;
let testOutcome: "success" | "failure" = "success";
let migrationRuns: number[] = [];

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
  targets: DrizzleStorageTargetRepository;
}> {
  dir = mkdtempSync(join(tmpdir(), "vid-storage-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const targets = new DrizzleStorageTargetRepository(db, cipher);
  const localId = await targets.create({
    name: "Lokaler Speicher",
    purpose: "document",
    description: null,
    config: { backend: "local" },
    status: "connected",
  });
  await targets.setDefault(localId);
  testOutcome = "success";
  migrationRuns = [];
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
    buildFileStorage: (config) => testStorageFor(config),
    storageTargets: targets,
    migrations: new DrizzleMigrationRepository(db),
    runStorageMigration: (migrationId) => {
      migrationRuns.push(migrationId);
    },
  });
  return { app: testApp, targets };
}

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function testStorageFor(config: StorageConfig): FileStorage {
  if (config.backend === "local") return new AtomicFileStorage(join(dir, "downloads"));
  const success = testOutcome === "success";
  return {
    store: async (relativePath, bytes) => ({
      relativePath,
      sha256: "test",
      sizeBytes: bytes.length,
    }),
    retrieve: async () => Buffer.from(""),
    remove: async () => undefined,
    testConnection: async () => ({
      success,
      pathMissing: false,
      steps: [
        {
          id: "authenticated",
          label: "Authentifizierung erfolgreich",
          status: success ? "ok" : "failed",
          ...(success ? {} : { message: "Anmeldung fehlgeschlagen." }),
        },
      ],
    }),
    checkReadAccess: async () => success,
    checkWriteAccess: async () => success,
    createDirectory: async () => undefined,
  };
}

describe("GET /storage", () => {
  it("shows the empty-state prompt when nothing but the seeded default exists", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/storage" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Speicher");
    expect(response.body).toContain("Lokaler Speicher");
    expect(response.body).toContain("Speicherziel hinzufügen");
  });
});

describe("GET /storage/new", () => {
  it("shows the four backend type cards", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/storage/new" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SMB / Windows-Freigabe");
    expect(response.body).toContain("SFTP");
    expect(response.body).toContain("FTP / FTPS");
    expect(response.body).toContain("WebDAV");
  });
});

describe("GET /storage/new/:type", () => {
  it("shows only the selected backend's fields", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/storage/new/sftp" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("sftpHost");
    expect(response.body).not.toContain("smbShare");
    expect(response.body).not.toContain("webdavUrl");
  });
});

describe("POST /storage/test", () => {
  it("tests an SFTP config without storing it", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/sftp" });

    const response = await app.inject({
      method: "POST",
      url: "/storage/test",
      cookies: cookieHeader(form),
      payload: sftpPayload(extractCsrfToken(form.body)),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Verbindung erfolgreich");
    expect(await targets.list()).toHaveLength(1);
  });
});

describe("POST /storage", () => {
  it("saves an untested SFTP target explicitly", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/sftp" });

    const response = await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: { ...sftpPayload(extractCsrfToken(form.body)), action: "save_untested" },
    });

    expect(response.statusCode).toBe(200);
    const list = await targets.list();
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.name === "NAS")).toMatchObject({ status: "untested" });
  });

  it("tests before saving by default and rejects on failure", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    testOutcome = "failure";
    const form = await app.inject({ method: "GET", url: "/storage/new/sftp" });

    const response = await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: sftpPayload(extractCsrfToken(form.body)),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("fehlgeschlagen");
    expect(await targets.list()).toHaveLength(1);
  });

  it("saves as connected once the automatic test succeeds", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/sftp" });

    await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: sftpPayload(extractCsrfToken(form.body)),
    });

    const list = await targets.list();
    expect(list.find((t) => t.name === "NAS")).toMatchObject({ status: "connected" });
  });
});

describe("POST /storage/:id/default", () => {
  it("switches immediately in new_only mode", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const secondId = await targets.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    const overview = await app.inject({ method: "GET", url: "/storage" });

    const response = await app.inject({
      method: "POST",
      url: `/storage/${secondId}/default`,
      cookies: cookieHeader(overview),
      payload: { mode: "new_only", _csrf: extractCsrfToken(overview.body) },
    });

    expect(response.statusCode).toBe(200);
    expect((await targets.findDefault())?.id).toBe(secondId);
    expect(migrationRuns).toEqual([]);
  });

  it("starts a background migration in migrate mode", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const secondId = await targets.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    const overview = await app.inject({ method: "GET", url: "/storage" });

    const response = await app.inject({
      method: "POST",
      url: `/storage/${secondId}/default`,
      cookies: cookieHeader(overview),
      payload: { mode: "migrate", _csrf: extractCsrfToken(overview.body) },
    });

    expect(response.statusCode).toBe(200);
    expect(migrationRuns).toHaveLength(1);
    // The default only flips once the migration completes.
    expect((await targets.findDefault())?.id).not.toBe(secondId);
  });
});

describe("POST /storage/:id/disable and DELETE /storage/:id", () => {
  it("refuses to disable or delete the default target", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const defaultTarget = await targets.findDefault();
    if (defaultTarget === undefined) throw new Error("expected a seeded default target");
    const overview = await app.inject({ method: "GET", url: "/storage" });
    const csrf = extractCsrfToken(overview.body);
    const cookies = cookieHeader(overview);

    const disableResponse = await app.inject({
      method: "POST",
      url: `/storage/${defaultTarget.id}/disable`,
      cookies,
      payload: { _csrf: csrf },
    });
    expect(disableResponse.body).toContain("Standardspeicher");
    expect((await targets.findById(defaultTarget.id))?.status).not.toBe("disabled");

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/storage/${defaultTarget.id}`,
      cookies,
      payload: { _csrf: csrf },
    });
    expect(deleteResponse.body).toContain("Standardspeicher");
    expect(await targets.findById(defaultTarget.id)).toBeDefined();
  });

  it("deletes an eligible, non-default target", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const secondId = await targets.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    const overview = await app.inject({ method: "GET", url: "/storage" });
    const csrf = extractCsrfToken(overview.body);
    const cookies = cookieHeader(overview);

    const response = await app.inject({
      method: "DELETE",
      url: `/storage/${secondId}`,
      cookies,
      payload: { _csrf: csrf },
    });

    expect(response.statusCode).toBe(200);
    expect(await targets.findById(secondId)).toBeUndefined();
  });
});

function sftpPayload(csrfToken: string): Record<string, string> {
  return {
    type: "sftp",
    name: "NAS",
    purpose: "document",
    sftpHost: "nas.local",
    sftpPort: "22",
    sftpPath: "vodafone",
    sftpUsername: "vid",
    sftpAuthKind: "password",
    sftpPassword: "secret",
    _csrf: csrfToken,
  };
}

function paperlessPayload(csrfToken: string): Record<string, string> {
  return {
    type: "paperless",
    name: "Paperless",
    paperlessUrl: "https://paperless.example.com",
    paperlessApiToken: "tok_abc123",
    _csrf: csrfToken,
  };
}

describe("Paperless storage target", () => {
  it("hides the purpose selector and the default checkbox on the create form", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/storage/new/paperless" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("paperlessUrl");
    expect(response.body).not.toContain('name="purpose"');
    expect(response.body).not.toContain('name="isDefault"');
  });

  it("saves a paperless target with purpose=export regardless of form input, and ignores isDefault", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/paperless" });

    const response = await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: {
        ...paperlessPayload(extractCsrfToken(form.body)),
        purpose: "document",
        isDefault: "on",
        action: "save_untested",
      },
    });

    expect(response.statusCode).toBe(200);
    const list = await targets.list();
    const saved = list.find((t) => t.name === "Paperless");
    expect(saved).toMatchObject({ purpose: "export", isDefault: false, backend: "paperless" });
  });

  it("does not offer 'Standard setzen' for a paperless row", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/paperless" });
    await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: { ...paperlessPayload(extractCsrfToken(form.body)), action: "save_untested" },
    });

    const overview = await app.inject({ method: "GET", url: "/storage" });
    const paperlessRowStart = overview.body.indexOf("Paperless<");
    const rowSlice = overview.body.slice(paperlessRowStart, paperlessRowStart + 800);
    expect(rowSlice).not.toContain("Standard setzen");
  });
});
