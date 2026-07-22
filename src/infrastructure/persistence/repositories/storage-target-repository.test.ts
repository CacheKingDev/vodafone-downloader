import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageConfig } from "../../../domain/storage-config.js";
import { Cipher } from "../../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { storageTarget } from "../schema.js";
import { DrizzleStorageTargetRepository } from "./storage-target-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleStorageTargetRepository;

const sftpConfig: StorageConfig = {
  backend: "sftp",
  sftp: {
    host: "nas.local",
    port: 22,
    path: "vodafone",
    username: "vid",
    auth: { kind: "password", password: "s3cret" },
  },
};

const paperlessConfig: StorageConfig = {
  backend: "paperless",
  paperless: {
    url: "https://paperless.example.com",
    apiToken: "tok_abc123",
    rejectUnauthorized: true,
    deleteAfterUpload: true,
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-storage-target-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleStorageTargetRepository(db, new Cipher(randomBytes(32)));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleStorageTargetRepository.create/findById", () => {
  it("round-trips a remote target's config", async () => {
    const id = await repo.create({
      name: "NAS SFTP",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "untested",
    });

    const target = await repo.findById(id);
    expect(target?.config).toEqual(sftpConfig);
    expect(target?.backend).toBe("sftp");
    expect(target?.destination).toBe("nas.local:22 · vodafone");
  });

  it("stores a local target without an encrypted config", async () => {
    const id = await repo.create({
      name: "Lokal",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    const target = await repo.findById(id);
    expect(target?.config).toEqual({ backend: "local" });
  });

  it("round-trips a paperless target's config", async () => {
    const id = await repo.create({
      name: "Paperless",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "untested",
    });
    const target = await repo.findById(id);
    expect(target?.config).toEqual(paperlessConfig);
    expect(target?.backend).toBe("paperless");
    expect(target?.destination).toBe("https://paperless.example.com");
  });

  it("does not store plaintext credentials", async () => {
    await repo.create({
      name: "NAS SFTP",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "untested",
    });
    const row = db.select().from(storageTarget).get();
    const raw = row?.configEnc?.toString("utf8") ?? "";
    expect(raw).not.toContain("s3cret");
  });
});

describe("DrizzleStorageTargetRepository.list", () => {
  it("never exposes the config field", async () => {
    await repo.create({
      name: "NAS SFTP",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "untested",
    });
    const summaries = await repo.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("config");
  });
});

describe("DrizzleStorageTargetRepository.nameExists", () => {
  it("detects a duplicate name", async () => {
    await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    await expect(repo.nameExists("NAS")).resolves.toBe(true);
    await expect(repo.nameExists("Anderer Name")).resolves.toBe(false);
  });

  it("excludes the given id (editing without renaming)", async () => {
    const id = await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    await expect(repo.nameExists("NAS", id)).resolves.toBe(false);
  });
});

describe("DrizzleStorageTargetRepository.update", () => {
  it("resets status to untested when the config changes", async () => {
    const id = await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "connected",
    });
    await repo.recordTestResult(id, { success: true, errorMessage: null });

    await repo.update(id, {
      config: { ...sftpConfig, sftp: { ...sftpConfig.sftp, host: "nas2.local" } },
    });

    const target = await repo.findById(id);
    expect(target?.status).toBe("untested");
    expect(target?.lastTestedAt).toBeNull();
    if (target?.config.backend === "sftp") {
      expect(target.config.sftp.host).toBe("nas2.local");
    }
  });

  it("renames without touching the stored config", async () => {
    const id = await repo.create({
      name: "Alt",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "connected",
    });
    await repo.update(id, { name: "Neu" });
    const target = await repo.findById(id);
    expect(target?.name).toBe("Neu");
    expect(target?.status).toBe("connected");
  });
});

describe("DrizzleStorageTargetRepository.setDefault", () => {
  it("ensures only one target is marked default", async () => {
    const first = await repo.create({
      name: "Erstes",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    const second = await repo.create({
      name: "Zweites",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "untested",
    });
    await repo.setDefault(first);
    await repo.setDefault(second);

    const list = await repo.list();
    const defaults = list.filter((t) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(second);
    expect((await repo.findDefault())?.id).toBe(second);
  });
});

describe("DrizzleStorageTargetRepository.setDisabled/recordTestResult/delete", () => {
  it("toggles disabled status", async () => {
    const id = await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    await repo.setDisabled(id, true);
    expect((await repo.findById(id))?.status).toBe("disabled");
    await repo.setDisabled(id, false);
    expect((await repo.findById(id))?.status).toBe("untested");
  });

  it("records a failed test result with its message", async () => {
    const id = await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: sftpConfig,
      status: "testing",
    });
    await repo.recordTestResult(id, { success: false, errorMessage: "Host nicht erreichbar" });
    const target = await repo.findById(id);
    expect(target?.status).toBe("failed");
    expect(target?.lastTestError).toBe("Host nicht erreichbar");
  });

  it("removes the row on delete", async () => {
    const id = await repo.create({
      name: "NAS",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });
    await repo.delete(id);
    expect(await repo.findById(id)).toBeUndefined();
  });
});

describe("DrizzleStorageTargetRepository.listEnabledPaperlessTargets", () => {
  it("returns only enabled paperless targets, decrypted", async () => {
    const enabledId = await repo.create({
      name: "Paperless aktiv",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "connected",
    });
    const disabledId = await repo.create({
      name: "Paperless deaktiviert",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "connected",
    });
    await repo.setDisabled(disabledId, true);
    await repo.create({
      name: "Lokal",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });

    const targets = await repo.listEnabledPaperlessTargets();
    expect(targets.map((t) => t.id)).toEqual([enabledId]);
    expect(targets[0]?.config).toEqual(paperlessConfig);
  });
});
