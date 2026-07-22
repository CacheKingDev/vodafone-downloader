import { describe, expect, it, vi } from "vitest";
import type {
  MigrationRepository,
  StorageTargetUiRepository,
} from "../domain/ports/repositories.js";
import type { StorageTargetSummary } from "../domain/storage-target.js";
import { deleteStorageTarget } from "./delete-storage-target.js";

function summary(overrides: Partial<StorageTargetSummary> = {}): StorageTargetSummary {
  return {
    id: 1,
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
    ...overrides,
  };
}

function makeTargets(
  target: StorageTargetSummary | undefined,
  all: StorageTargetSummary[],
): StorageTargetUiRepository {
  return {
    list: vi.fn(async () => all),
    findById: vi.fn(async () =>
      target === undefined ? undefined : { ...target, config: { backend: "local" as const } },
    ),
    findDefault: vi.fn(async () => undefined),
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

function makeMigrations(running?: {
  fromTargetId: number;
  toTargetId: number;
}): MigrationRepository {
  return {
    listStoredDocuments: vi.fn(async () => []),
    createMigration: vi.fn(async () => 1),
    findRunningMigration: vi.fn(async () =>
      running === undefined
        ? undefined
        : {
            id: 1,
            fromTargetId: running.fromTargetId,
            toTargetId: running.toTargetId,
            mode: "migrate" as const,
            status: "running" as const,
            totalDocuments: 0,
            migratedDocuments: 0,
            failedDocuments: 0,
            startedAt: 0,
            finishedAt: null,
            errorMessage: null,
          },
    ),
    findMigration: vi.fn(async () => undefined),
    incrementProgress: vi.fn(async () => undefined),
    setTotalDocuments: vi.fn(async () => undefined),
    completeMigration: vi.fn(async () => undefined),
    failMigration: vi.fn(async () => undefined),
  };
}

describe("deleteStorageTarget", () => {
  it("refuses to delete the default target", async () => {
    const target = summary({ isDefault: true });
    const targets = makeTargets(target, [target, summary({ id: 2 })]);
    await expect(deleteStorageTarget({ targets, migrations: makeMigrations() }, 1)).rejects.toThrow(
      /Standardspeicher/,
    );
  });

  it("refuses to delete the last remaining target", async () => {
    const target = summary();
    const targets = makeTargets(target, [target]);
    await expect(deleteStorageTarget({ targets, migrations: makeMigrations() }, 1)).rejects.toThrow(
      /letzte verbleibende/,
    );
  });

  it("refuses to delete a target involved in a running migration", async () => {
    const target = summary({ id: 2 });
    const targets = makeTargets(target, [summary({ id: 1, isDefault: true }), target]);
    const migrations = makeMigrations({ fromTargetId: 1, toTargetId: 2 });
    await expect(deleteStorageTarget({ targets, migrations }, 2)).rejects.toThrow(/migriert/);
  });

  it("deletes an eligible target", async () => {
    const target = summary({ id: 2 });
    const targets = makeTargets(target, [summary({ id: 1, isDefault: true }), target]);
    await deleteStorageTarget({ targets, migrations: makeMigrations() }, 2);
    expect(targets.delete).toHaveBeenCalledWith(2);
  });
});
