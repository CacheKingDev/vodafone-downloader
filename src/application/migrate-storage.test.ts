import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type {
  MigrationRepository,
  StorageMigrationRecord,
  StorageTargetUiRepository,
  StoredDocumentRecord,
} from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { AtomicFileStorage } from "../infrastructure/storage/atomic-file-storage.js";
import { StorageMigrationRunner } from "./migrate-storage.js";

const sourceConfig: StorageConfig = { backend: "local" };
const targetConfig: StorageConfig = {
  backend: "sftp",
  sftp: {
    host: "nas.local",
    port: 22,
    path: "",
    username: "vid",
    auth: { kind: "password", password: "secret" },
  },
};

const FROM_TARGET_ID = 10;
const TO_TARGET_ID = 20;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-migrate-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeTarget(id: number, config: StorageConfig): StorageTarget {
  return {
    id,
    name: config.backend,
    backend: config.backend,
    destination: config.backend,
    purpose: "document",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: null,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config,
  };
}

function makeTargets(): StorageTargetUiRepository & {
  setDefault: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
} {
  const byId = new Map<number, StorageTarget>([
    [FROM_TARGET_ID, makeTarget(FROM_TARGET_ID, sourceConfig)],
    [TO_TARGET_ID, makeTarget(TO_TARGET_ID, targetConfig)],
  ]);
  return {
    list: vi.fn(async () => [...byId.values()]),
    findById: vi.fn(async (id: number) => byId.get(id)),
    findDefault: vi.fn(async () => byId.get(FROM_TARGET_ID)),
    nameExists: vi.fn(async () => false),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordTestResult: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    setDisabled: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function makeMigration(id: number): StorageMigrationRecord {
  return {
    id,
    fromTargetId: FROM_TARGET_ID,
    toTargetId: TO_TARGET_ID,
    mode: "migrate",
    status: "running",
    totalDocuments: 0,
    migratedDocuments: 0,
    failedDocuments: 0,
    startedAt: 1,
    finishedAt: null,
    errorMessage: null,
  };
}

function makeMigrations(
  documents: StoredDocumentRecord[],
  migration: StorageMigrationRecord | undefined = makeMigration(1),
): MigrationRepository & {
  incrementProgress: ReturnType<typeof vi.fn>;
  completeMigration: ReturnType<typeof vi.fn>;
  failMigration: ReturnType<typeof vi.fn>;
  setTotalDocuments: ReturnType<typeof vi.fn>;
} {
  return {
    listStoredDocuments: vi.fn(async () => documents),
    createMigration: vi.fn(async () => 1),
    findRunningMigration: vi.fn(async () => migration),
    findMigration: vi.fn(async () => migration),
    incrementProgress: vi.fn(async () => undefined),
    setTotalDocuments: vi.fn(async () => undefined),
    completeMigration: vi.fn(async () => undefined),
    failMigration: vi.fn(async () => undefined),
  };
}

function buildStorageFactory(source: FileStorage, target: FileStorage) {
  return (config: StorageConfig): FileStorage => {
    if (config.backend === "local") return source;
    return target;
  };
}

describe("StorageMigrationRunner", () => {
  it("copies, verifies and removes documents before switching the default target", async () => {
    const source = new AtomicFileStorage(join(dir, "source"));
    const target = new AtomicFileStorage(join(dir, "target"));
    const bytes = Buffer.from("%PDF-1.4 migration");
    await source.store("2026/r.pdf", bytes);
    const documents = [{ id: 1, relativePath: "2026/r.pdf", sha256: sha256(bytes) }];
    const migrations = makeMigrations(documents);
    const targets = makeTargets();

    await new StorageMigrationRunner({
      migrations,
      targets,
      buildFileStorage: buildStorageFactory(source, target),
      logger: { warn: vi.fn(), error: vi.fn() },
    }).run(1);

    await expect(target.retrieve("2026/r.pdf")).resolves.toEqual(bytes);
    await expect(source.retrieve("2026/r.pdf")).rejects.toThrow();
    expect(migrations.incrementProgress).toHaveBeenCalledWith(1, "migrated");
    expect(targets.setDefault).toHaveBeenCalledWith(TO_TARGET_ID);
    expect(targets.setStatus).toHaveBeenCalledWith(TO_TARGET_ID, "connected");
    expect(migrations.completeMigration).toHaveBeenCalledWith(1);
    expect(migrations.failMigration).not.toHaveBeenCalled();
  });

  it("fails the migration and keeps the previous default when a document cannot be read", async () => {
    const source = new AtomicFileStorage(join(dir, "source"));
    const target = new AtomicFileStorage(join(dir, "target"));
    const migrations = makeMigrations([
      { id: 1, relativePath: "missing.pdf", sha256: sha256(Buffer.from("missing")) },
    ]);
    const targets = makeTargets();

    await new StorageMigrationRunner({
      migrations,
      targets,
      buildFileStorage: buildStorageFactory(source, target),
      logger: { warn: vi.fn(), error: vi.fn() },
    }).run(1);

    expect(migrations.incrementProgress).toHaveBeenCalledWith(1, "failed");
    expect(migrations.failMigration).toHaveBeenCalledWith(
      1,
      "1 Dokumente konnten nicht migriert werden.",
    );
    expect(targets.setDefault).not.toHaveBeenCalled();
    expect(targets.setStatus).toHaveBeenCalledWith(TO_TARGET_ID, "migration_failed");
    expect(migrations.completeMigration).not.toHaveBeenCalled();
  });

  it("skips work for missing or no longer running migrations", async () => {
    const migrations = makeMigrations([], { ...makeMigration(99), status: "completed" });
    const targets = makeTargets();
    const buildFileStorage = vi.fn();

    await new StorageMigrationRunner({
      migrations,
      targets,
      buildFileStorage,
      logger: { warn: vi.fn(), error: vi.fn() },
    }).run(99);

    expect(buildFileStorage).not.toHaveBeenCalled();
    expect(migrations.completeMigration).not.toHaveBeenCalled();
  });
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
