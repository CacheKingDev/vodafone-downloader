import type {
  MigrationRepository,
  StorageTargetUiRepository,
} from "../domain/ports/repositories.js";

export interface DeleteStorageTargetDeps {
  readonly targets: StorageTargetUiRepository;
  readonly migrations: MigrationRepository;
}

export async function deleteStorageTarget(
  deps: DeleteStorageTargetDeps,
  id: number,
): Promise<void> {
  const target = await deps.targets.findById(id);
  if (target === undefined) return;

  if (target.isDefault) {
    throw new Error(
      "Der Standardspeicher kann nicht gelöscht werden. Bitte zuerst ein anderes Ziel als Standard festlegen.",
    );
  }

  const all = await deps.targets.list();
  if (all.length <= 1) {
    throw new Error("Das letzte verbleibende Speicherziel kann nicht gelöscht werden.");
  }

  const running = await deps.migrations.findRunningMigration();
  if (running !== undefined && (running.fromTargetId === id || running.toTargetId === id)) {
    throw new Error("Speicherziel wird gerade migriert und kann nicht gelöscht werden.");
  }

  await deps.targets.delete(id);
}
