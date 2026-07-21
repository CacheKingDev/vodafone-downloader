import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";
import type { StoragePurpose } from "../domain/storage-target.js";

export interface CreateStorageTargetDeps {
  readonly targets: StorageTargetUiRepository;
}

export interface CreateStorageTargetRequest {
  readonly name: string;
  readonly purpose: StoragePurpose;
  readonly description: string | null;
  readonly config: StorageConfig;
  /** Whether a connection test already succeeded for exactly this config (spec section 10). */
  readonly tested: boolean;
}

export async function createStorageTarget(
  deps: CreateStorageTargetDeps,
  request: CreateStorageTargetRequest,
): Promise<number> {
  const name = request.name.trim();
  if (name === "") throw new Error("Name ist erforderlich.");
  if (await deps.targets.nameExists(name)) {
    throw new Error(`Ein Speicherziel namens "${name}" existiert bereits.`);
  }
  return deps.targets.create({
    name,
    purpose: request.purpose,
    description: request.description,
    config: request.config,
    status: request.tested ? "connected" : "untested",
  });
}
