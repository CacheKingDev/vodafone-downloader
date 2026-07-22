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
 * fact (no new upload happens for it in this run) is not retroactively
 * deleted — an accepted, narrow gap (spec section 8: no retroactive
 * processing).
 *
 * The delete-check trigger is deliberately "does ANY currently enabled
 * target want deleteAfterUpload", not "did the target that just succeeded
 * want it" — the latter silently never re-triggers a check for a document
 * whose LAST missing target happens to be one without the flag set (the
 * ordinary case of a previously-failed upload succeeding on a later retry,
 * or a second Paperless target catching up after the first). Gating on the
 * per-run-successful target's own flag would let such a document sit
 * fully-exported-but-undeleted forever.
 */
export async function exportToPaperless(deps: ExportToPaperlessDeps): Promise<void> {
  const targets = await deps.targets.listEnabledPaperlessTargets();
  if (targets.length === 0) return;

  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const defaultStorage = await deps.resolveDefaultStorage();
  const targetIds = targets.map((target) => target.id);
  const anyTargetWantsDelete = targets.some(
    (target) => target.config.backend === "paperless" && target.config.paperless.deleteAfterUpload,
  );

  // One retrieve() per document, regardless of how many enabled targets
  // still need it — group candidates by document first.
  const pending = new Map<
    number,
    { relativePath: string; title: string; createdOn: string; targets: StorageTarget[] }
  >();
  for (const target of targets) {
    if (target.config.backend !== "paperless") continue;
    const candidates = await deps.exports.listExportCandidates(target.id);
    for (const candidate of candidates) {
      const existing = pending.get(candidate.documentId);
      if (existing === undefined) {
        pending.set(candidate.documentId, {
          relativePath: candidate.relativePath,
          title: `${candidate.accountLabel} – Rechnung ${candidate.invoiceNumber}`,
          createdOn: candidate.issuedOn,
          targets: [target],
        });
      } else {
        existing.targets.push(target);
      }
    }
  }

  const documentsNeedingDeleteCheck = new Set<number>();

  for (const [documentId, entry] of pending) {
    let bytes: Buffer;
    try {
      bytes = await defaultStorage.retrieve(entry.relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of entry.targets) {
        await deps.exports.recordFailure(documentId, target.id, message, now());
      }
      deps.logger.warn({ err: error, documentId }, "paperless export failed to read source file");
      continue;
    }

    for (const target of entry.targets) {
      const client = deps.buildPaperlessClient(target);
      try {
        await client.upload(bytes, {
          filename: basename(entry.relativePath),
          title: entry.title,
          createdOn: entry.createdOn,
        });
        await deps.exports.recordSuccess(documentId, target.id, now());
        if (anyTargetWantsDelete) documentsNeedingDeleteCheck.add(documentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.exports.recordFailure(documentId, target.id, message, now());
        deps.logger.warn(
          { err: error, documentId, storageTargetId: target.id },
          "paperless export failed",
        );
      }
    }
  }

  for (const documentId of documentsNeedingDeleteCheck) {
    const relativePath = pending.get(documentId)?.relativePath;
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
