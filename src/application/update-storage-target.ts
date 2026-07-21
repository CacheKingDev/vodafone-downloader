import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";
import type { StoragePurpose } from "../domain/storage-target.js";

export interface UpdateStorageTargetDeps {
  readonly targets: StorageTargetUiRepository;
}

export interface UpdateStorageTargetRequest {
  readonly name?: string;
  readonly purpose?: StoragePurpose;
  readonly description?: string | null;
  /** Omitted entirely means "keep the stored secret" (spec section 11). */
  readonly config?: StorageConfig;
}

export async function updateStorageTarget(
  deps: UpdateStorageTargetDeps,
  id: number,
  request: UpdateStorageTargetRequest,
): Promise<void> {
  const existing = await deps.targets.findById(id);
  if (existing === undefined) throw new Error("Speicherziel wurde nicht gefunden.");

  let name: string | undefined;
  if (request.name !== undefined) {
    name = request.name.trim();
    if (name === "") throw new Error("Name ist erforderlich.");
    if (await deps.targets.nameExists(name, id)) {
      throw new Error(`Ein Speicherziel namens "${name}" existiert bereits.`);
    }
  }

  if (request.config !== undefined && request.config.backend !== existing.backend) {
    throw new Error("Der Speichertyp eines bestehenden Speicherziels kann nicht geändert werden.");
  }

  await deps.targets.update(id, {
    ...(name === undefined ? {} : { name }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.config === undefined ? {} : { config: request.config }),
  });
}
