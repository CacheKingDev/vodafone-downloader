import { and, eq, inArray } from "drizzle-orm";
import type {
  DocumentExportRepository,
  ExportCandidate,
} from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { account, invoice, invoiceDocument, invoiceDocumentExport } from "../schema.js";

/**
 * Filters candidates in JS rather than a SQL anti-join (mirrors the
 * Set-based dedup already used by DrizzleInvoiceRepository.existingNumbers) —
 * invoice volumes here are small enough that this stays simple and fast.
 */
export class DrizzleDocumentExportRepository implements DocumentExportRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async listExportCandidates(storageTargetId: number): Promise<ExportCandidate[]> {
    const uploaded = this.#db
      .select({ documentId: invoiceDocumentExport.documentId })
      .from(invoiceDocumentExport)
      .where(
        and(
          eq(invoiceDocumentExport.storageTargetId, storageTargetId),
          eq(invoiceDocumentExport.status, "uploaded"),
        ),
      )
      .all();
    const uploadedIds = new Set(uploaded.map((row) => row.documentId));

    const stored = this.#db
      .select({
        documentId: invoiceDocument.id,
        relativePath: invoiceDocument.relativePath,
        accountLabel: account.label,
        invoiceNumber: invoice.number,
        issuedOn: invoice.issuedOn,
      })
      .from(invoiceDocument)
      .innerJoin(invoice, eq(invoiceDocument.invoiceId, invoice.id))
      .innerJoin(account, eq(invoice.accountId, account.id))
      .where(eq(invoiceDocument.state, "stored"))
      .all();

    return stored
      .filter((row) => row.relativePath !== null && !uploadedIds.has(row.documentId))
      .map((row) => ({
        documentId: row.documentId,
        relativePath: row.relativePath as string,
        accountLabel: row.accountLabel,
        invoiceNumber: row.invoiceNumber,
        issuedOn: row.issuedOn,
      }));
  }

  async recordSuccess(
    documentId: number,
    storageTargetId: number,
    attemptedAtSeconds: number,
  ): Promise<void> {
    this.#upsert(documentId, storageTargetId, {
      status: "uploaded",
      errorMessage: null,
      attemptedAt: attemptedAtSeconds,
    });
  }

  async recordFailure(
    documentId: number,
    storageTargetId: number,
    message: string,
    attemptedAtSeconds: number,
  ): Promise<void> {
    this.#upsert(documentId, storageTargetId, {
      status: "failed",
      errorMessage: message,
      attemptedAt: attemptedAtSeconds,
    });
  }

  async isFullyExported(documentId: number, storageTargetIds: readonly number[]): Promise<boolean> {
    if (storageTargetIds.length === 0) return false;
    const rows = this.#db
      .select({ storageTargetId: invoiceDocumentExport.storageTargetId })
      .from(invoiceDocumentExport)
      .where(
        and(
          eq(invoiceDocumentExport.documentId, documentId),
          eq(invoiceDocumentExport.status, "uploaded"),
          inArray(invoiceDocumentExport.storageTargetId, [...storageTargetIds]),
        ),
      )
      .all();
    const uploadedTargetIds = new Set(rows.map((row) => row.storageTargetId));
    return storageTargetIds.every((id) => uploadedTargetIds.has(id));
  }

  #upsert(
    documentId: number,
    storageTargetId: number,
    values: { status: "uploaded" | "failed"; errorMessage: string | null; attemptedAt: number },
  ): void {
    this.#db
      .insert(invoiceDocumentExport)
      .values({ documentId, storageTargetId, ...values })
      .onConflictDoUpdate({
        target: [invoiceDocumentExport.documentId, invoiceDocumentExport.storageTargetId],
        set: values,
      })
      .run();
  }
}
