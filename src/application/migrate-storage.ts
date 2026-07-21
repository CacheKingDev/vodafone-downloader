import { createHash } from "node:crypto";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type {
  MigrationRepository,
  StorageTargetUiRepository,
  StoredDocumentRecord,
} from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";

export interface StorageMigrationLogger {
  error(context: object, message: string): void;
  warn(context: object, message: string): void;
}

export interface StorageMigrationRunnerDeps {
  readonly migrations: MigrationRepository;
  readonly targets: StorageTargetUiRepository;
  readonly buildFileStorage: (config: StorageConfig) => FileStorage;
  readonly logger: StorageMigrationLogger;
}

export class StorageMigrationRunner {
  readonly #deps: StorageMigrationRunnerDeps;

  constructor(deps: StorageMigrationRunnerDeps) {
    this.#deps = deps;
  }

  async run(migrationId: number): Promise<void> {
    const migration = await this.#deps.migrations.findMigration(migrationId);
    if (migration === undefined || migration.status !== "running") return;

    try {
      const fromTarget = await this.#deps.targets.findById(migration.fromTargetId);
      const toTarget = await this.#deps.targets.findById(migration.toTargetId);
      if (fromTarget === undefined || toTarget === undefined) {
        throw new Error("Quelle oder Ziel der Migration wurde inzwischen gelöscht.");
      }

      await this.#deps.targets.setStatus(migration.toTargetId, "migrating");

      const source = this.#deps.buildFileStorage(fromTarget.config);
      const target = this.#deps.buildFileStorage(toTarget.config);
      let failures = 0;

      for (;;) {
        const documents = await this.#deps.migrations.listStoredDocuments();
        await this.#deps.migrations.setTotalDocuments(migrationId, documents.length);
        const passFailures = await this.#migratePass(migrationId, documents, source, target);
        failures += passFailures;

        const afterPass = await this.#deps.migrations.listStoredDocuments();
        const remaining = await this.#countMissingAtTarget(afterPass, target);
        if (remaining === 0) break;
        if (passFailures > 0) break;
      }

      if (failures > 0) {
        await this.#deps.migrations.failMigration(
          migrationId,
          `${failures} Dokumente konnten nicht migriert werden.`,
        );
        await this.#deps.targets.setStatus(migration.toTargetId, "migration_failed");
        return;
      }

      await this.#deps.targets.setDefault(migration.toTargetId);
      await this.#deps.targets.setStatus(migration.toTargetId, "connected");
      await this.#deps.migrations.completeMigration(migrationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.logger.error({ err: error, migrationId }, "storage migration failed");
      await this.#deps.migrations.failMigration(migrationId, message);
      await this.#deps.targets
        .setStatus(migration.toTargetId, "migration_failed")
        .catch(() => undefined);
    }
  }

  async #migratePass(
    migrationId: number,
    documents: readonly StoredDocumentRecord[],
    source: FileStorage,
    target: FileStorage,
  ): Promise<number> {
    let failures = 0;
    for (const document of documents) {
      try {
        if (await this.#targetAlreadyMatches(target, document)) {
          await source.remove(document.relativePath).catch(() => undefined);
          continue;
        }

        const bytes = await source.retrieve(document.relativePath);
        const stored = await target.store(document.relativePath, bytes);
        if (stored.relativePath !== document.relativePath || stored.sha256 !== document.sha256) {
          throw new Error(`SHA-256 verification failed for ${document.relativePath}`);
        }

        await source.remove(document.relativePath);
        await this.#deps.migrations.incrementProgress(migrationId, "migrated");
      } catch (error) {
        failures += 1;
        this.#deps.logger.warn(
          { err: error, documentId: document.id },
          "document migration failed",
        );
        await this.#deps.migrations.incrementProgress(migrationId, "failed");
      }
    }
    return failures;
  }

  async #targetAlreadyMatches(
    target: FileStorage,
    document: StoredDocumentRecord,
  ): Promise<boolean> {
    try {
      const bytes = await target.retrieve(document.relativePath);
      return sha256(bytes) === document.sha256;
    } catch {
      return false;
    }
  }

  async #countMissingAtTarget(
    documents: readonly StoredDocumentRecord[],
    target: FileStorage,
  ): Promise<number> {
    let missing = 0;
    for (const document of documents) {
      if (!(await this.#targetAlreadyMatches(target, document))) missing += 1;
    }
    return missing;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
