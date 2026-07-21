import type { ConnectionTestResult } from "../domain/connection-test.js";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";

export interface TestStorageConfigDeps {
  readonly buildFileStorage: (config: StorageConfig) => FileStorage;
}

/** Ad-hoc test for a not-yet-saved config — the wizard's "Verbindung testen" step. */
export async function testStorageConfig(
  deps: TestStorageConfigDeps,
  config: StorageConfig,
): Promise<ConnectionTestResult> {
  return deps.buildFileStorage(config).testConnection();
}

export interface TestStorageTargetDeps extends TestStorageConfigDeps {
  readonly targets: StorageTargetUiRepository;
}

/** Tests an already-saved target and persists the outcome onto its status. */
export async function testStorageTarget(
  deps: TestStorageTargetDeps,
  id: number,
): Promise<ConnectionTestResult> {
  const target = await deps.targets.findById(id);
  if (target === undefined) throw new Error("Speicherziel wurde nicht gefunden.");

  await deps.targets.setStatus(id, "testing");
  const result = await deps.buildFileStorage(target.config).testConnection();
  const failedStep = result.steps.find((step) => step.status === "failed");
  await deps.targets.recordTestResult(id, {
    success: result.success,
    errorMessage: result.success
      ? null
      : (failedStep?.message ?? "Verbindungstest fehlgeschlagen."),
  });
  return result;
}
