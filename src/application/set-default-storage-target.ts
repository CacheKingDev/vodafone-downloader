import type {
  MigrationRepository,
  StorageTargetUiRepository,
} from "../domain/ports/repositories.js";

export interface SetDefaultStorageTargetDeps {
  readonly targets: StorageTargetUiRepository;
  readonly migrations: MigrationRepository;
  readonly runMigration: (migrationId: number) => void;
}

/**
 * "new_only" switches the default immediately, leaving prior documents where
 * they are; "migrate" starts a background job that only flips the default
 * once every existing document has been verified at the new target (spec
 * section 12) — the previous default keeps serving reads/writes until then.
 */
export type SetDefaultStorageTargetMode = "new_only" | "migrate";

export interface SetDefaultStorageTargetResult {
  readonly status: "updated" | "migration_started" | "migration_already_running";
  readonly migrationId?: number;
}

export async function setDefaultStorageTarget(
  deps: SetDefaultStorageTargetDeps,
  targetId: number,
  mode: SetDefaultStorageTargetMode,
): Promise<SetDefaultStorageTargetResult> {
  const target = await deps.targets.findById(targetId);
  if (target === undefined) throw new Error("Speicherziel wurde nicht gefunden.");
  if (target.backend === "paperless") {
    throw new Error("Ein Paperless-Ziel kann nicht Standardspeicher werden.");
  }
  if (target.status === "disabled") {
    throw new Error("Ein deaktiviertes Speicherziel kann nicht zum Standardspeicher werden.");
  }

  const current = await deps.targets.findDefault();
  if (current === undefined || current.id === targetId || mode === "new_only") {
    await deps.targets.setDefault(targetId);
    return { status: "updated" };
  }

  const running = await deps.migrations.findRunningMigration();
  if (running !== undefined) {
    return { status: "migration_already_running", migrationId: running.id };
  }

  const documents = await deps.migrations.listStoredDocuments();
  const migrationId = await deps.migrations.createMigration({
    fromTargetId: current.id,
    toTargetId: targetId,
    mode: "migrate",
    totalDocuments: documents.length,
  });
  await deps.targets.setStatus(targetId, "migration_pending");
  deps.runMigration(migrationId);
  return { status: "migration_started", migrationId };
}
