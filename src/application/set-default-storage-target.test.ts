import { describe, expect, it, vi } from "vitest";
import type {
  MigrationRepository,
  StorageTargetUiRepository,
} from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { setDefaultStorageTarget } from "./set-default-storage-target.js";

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 2,
    name: "NAS",
    backend: "local",
    destination: "Lokaler Ordner",
    purpose: "document",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: null,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config: { backend: "local" },
    ...overrides,
  };
}

function makeTargets(
  target: StorageTarget | undefined,
  current: StorageTarget | undefined,
): StorageTargetUiRepository {
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => target),
    findDefault: vi.fn(async () => current),
    nameExists: vi.fn(async () => false),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordTestResult: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    setDisabled: vi.fn(async () => undefined),
    listEnabledPaperlessTargets: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
  };
}

function makeMigrations(running?: unknown): MigrationRepository {
  return {
    listStoredDocuments: vi.fn(async () => [{ id: 1, relativePath: "a.pdf", sha256: "x" }]),
    createMigration: vi.fn(async () => 42),
    findRunningMigration: vi.fn(async () => running as never),
    findMigration: vi.fn(async () => undefined),
    incrementProgress: vi.fn(async () => undefined),
    setTotalDocuments: vi.fn(async () => undefined),
    completeMigration: vi.fn(async () => undefined),
    failMigration: vi.fn(async () => undefined),
  };
}

describe("setDefaultStorageTarget", () => {
  it("throws when the target does not exist", async () => {
    const targets = makeTargets(undefined, undefined);
    await expect(
      setDefaultStorageTarget(
        { targets, migrations: makeMigrations(), runMigration: vi.fn() },
        2,
        "new_only",
      ),
    ).rejects.toThrow("Speicherziel wurde nicht gefunden.");
  });

  it("refuses to make a disabled target the default", async () => {
    const targets = makeTargets(makeTarget({ status: "disabled" }), undefined);
    await expect(
      setDefaultStorageTarget(
        { targets, migrations: makeMigrations(), runMigration: vi.fn() },
        2,
        "new_only",
      ),
    ).rejects.toThrow(/deaktiviertes/);
  });

  it("switches immediately in new_only mode without starting a migration", async () => {
    const current = makeTarget({ id: 1, isDefault: true });
    const targets = makeTargets(makeTarget(), current);
    const runMigration = vi.fn();
    const migrations = makeMigrations();

    const result = await setDefaultStorageTarget(
      { targets, migrations, runMigration },
      2,
      "new_only",
    );

    expect(result.status).toBe("updated");
    expect(targets.setDefault).toHaveBeenCalledWith(2);
    expect(migrations.createMigration).not.toHaveBeenCalled();
    expect(runMigration).not.toHaveBeenCalled();
  });

  it("switches immediately when there is no current default, even in migrate mode", async () => {
    const targets = makeTargets(makeTarget(), undefined);
    const runMigration = vi.fn();
    const result = await setDefaultStorageTarget(
      { targets, migrations: makeMigrations(), runMigration },
      2,
      "migrate",
    );
    expect(result.status).toBe("updated");
    expect(targets.setDefault).toHaveBeenCalledWith(2);
  });

  it("starts a background migration in migrate mode when a different target is currently default", async () => {
    const current = makeTarget({ id: 1, isDefault: true });
    const targets = makeTargets(makeTarget(), current);
    const runMigration = vi.fn();
    const migrations = makeMigrations();

    const result = await setDefaultStorageTarget(
      { targets, migrations, runMigration },
      2,
      "migrate",
    );

    expect(result.status).toBe("migration_started");
    expect(migrations.createMigration).toHaveBeenCalledWith({
      fromTargetId: 1,
      toTargetId: 2,
      mode: "migrate",
      totalDocuments: 1,
    });
    expect(runMigration).toHaveBeenCalledWith(42);
    expect(targets.setDefault).not.toHaveBeenCalled();
    expect(targets.setStatus).toHaveBeenCalledWith(2, "migration_pending");
  });

  it("does not start a second migration while one is already running", async () => {
    const current = makeTarget({ id: 1, isDefault: true });
    const targets = makeTargets(makeTarget(), current);
    const migrations = makeMigrations({
      id: 7,
      fromTargetId: 1,
      toTargetId: 2,
      mode: "migrate",
      status: "running",
      totalDocuments: 1,
      migratedDocuments: 0,
      failedDocuments: 0,
      startedAt: 0,
      finishedAt: null,
      errorMessage: null,
    });

    const result = await setDefaultStorageTarget(
      { targets, migrations, runMigration: vi.fn() },
      2,
      "migrate",
    );

    expect(result).toEqual({ status: "migration_already_running", migrationId: 7 });
    expect(migrations.createMigration).not.toHaveBeenCalled();
  });
});
