import { basename } from "node:path";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type {
  DocumentExportRepository,
  StorageTargetRepository,
} from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";

export interface PaperlessUploader {
  upload(
    bytes: Buffer,
    meta: { filename: string; title: string; createdOn?: string },
  ): Promise<void>;
}

export interface ExportLogger {
  warn(context: object, message: string): void;
}

export interface ExportToPaperlessDeps {
  readonly targets: Pick<StorageTargetRepository, "listEnabledPaperlessTargets">;
  readonly exports: DocumentExportRepository;
  readonly resolveDefaultStorage: () => Promise<FileStorage>;
  readonly buildPaperlessClient: (target: StorageTarget) => PaperlessUploader;
  readonly logger: ExportLogger;
  readonly now?: () => number;
}

/**
 * Runs after every sync (RunCoordinator hook, spec section 4), decoupled
 * from any single account or Vodafone session: pushes every `stored`
 * document to each currently enabled Paperless target that hasn't received
 * it yet, and — once a document has an `uploaded` row for every enabled
 * Paperless target and at least one of them wants `deleteAfterUpload` —
 * removes the local copy from the default storage. A document that becomes
 * fully exported only because deleteAfterUpload was turned on after the
 * fact (no new upload happens) is not retroactively deleted — an accepted,
 * narrow gap (spec section 8: no retroactive processing).
 */
export async function exportToPaperless(deps: ExportToPaperlessDeps): Promise<void> {
  const targets = await deps.targets.listEnabledPaperlessTargets();
  if (targets.length === 0) return;

  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const defaultStorage = await deps.resolveDefaultStorage();
  const targetIds = targets.map((target) => target.id);
  const relativePathsById = new Map<number, string>();
  const documentsNeedingDeleteCheck = new Set<number>();

  for (const target of targets) {
    if (target.config.backend !== "paperless") continue;
    const client = deps.buildPaperlessClient(target);
    const candidates = await deps.exports.listExportCandidates(target.id);
    for (const candidate of candidates) {
      relativePathsById.set(candidate.documentId, candidate.relativePath);
      try {
        const bytes = await defaultStorage.retrieve(candidate.relativePath);
        await client.upload(bytes, {
          filename: basename(candidate.relativePath),
          title: `${candidate.accountLabel} – Rechnung ${candidate.invoiceNumber}`,
          createdOn: candidate.issuedOn,
        });
        await deps.exports.recordSuccess(candidate.documentId, target.id, now());
        if (target.config.paperless.deleteAfterUpload) {
          documentsNeedingDeleteCheck.add(candidate.documentId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.exports.recordFailure(candidate.documentId, target.id, message, now());
        deps.logger.warn(
          { err: error, documentId: candidate.documentId, storageTargetId: target.id },
          "paperless export failed",
        );
      }
    }
  }

  for (const documentId of documentsNeedingDeleteCheck) {
    const relativePath = relativePathsById.get(documentId);
    if (relativePath === undefined) continue;
    if (await deps.exports.isFullyExported(documentId, targetIds)) {
      await defaultStorage.remove(relativePath).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, documentId },
          "failed to remove document after paperless export",
        );
      });
    }
  }
}
