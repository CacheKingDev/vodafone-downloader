import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";

export interface SetStorageTargetEnabledDeps {
  readonly targets: StorageTargetUiRepository;
}

export async function setStorageTargetEnabled(
  deps: SetStorageTargetEnabledDeps,
  id: number,
  enabled: boolean,
): Promise<void> {
  const target = await deps.targets.findById(id);
  if (target === undefined) throw new Error("Speicherziel wurde nicht gefunden.");
  if (!enabled && target.isDefault) {
    throw new Error("Der Standardspeicher kann nicht deaktiviert werden.");
  }
  await deps.targets.setDisabled(id, !enabled);
}
