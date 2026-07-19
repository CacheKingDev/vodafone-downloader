import { and, eq, inArray } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type { Invoice } from "../../../domain/invoice.js";
import type { StoredFile } from "../../../domain/ports/file-storage.js";
import type { InvoiceRepository, RetryableDocument } from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { invoice, invoiceDocument } from "../schema.js";

/**
 * Dedup lives here as a set of known invoice numbers per account, backed by
 * UNIQUE(account_id, number). Only state=stored is final: pending and failed
 * documents reappear in listRetryableDocuments until a run stores them.
 */
export class DrizzleInvoiceRepository implements InvoiceRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async existingNumbers(accountId: number): Promise<Set<string>> {
    const rows = this.#db
      .select({ number: invoice.number })
      .from(invoice)
      .where(eq(invoice.accountId, accountId))
      .all();
    return new Set(rows.map((row) => row.number));
  }

  async insertInvoice(accountId: number, entry: Invoice): Promise<void> {
    this.#db.transaction((tx) => {
      const [row] = tx
        .insert(invoice)
        .values({
          accountId,
          number: entry.number,
          issuedOn: entry.issuedOn,
          dueOn: entry.dueOn,
          amountCents: entry.amountCents,
          currency: entry.currency,
          subject: entry.subject,
          contractNumber: entry.contractNumber,
        })
        .returning()
        .all();
      if (row === undefined) {
        throw new PersistenceError("Invoice insert returned no row");
      }
      for (const doc of entry.documents) {
        tx.insert(invoiceDocument)
          .values({
            invoiceId: row.id,
            remoteDocumentId: doc.documentId,
            subType: doc.subType,
            category: doc.category,
          })
          .run();
      }
    });
  }

  async listRetryableDocuments(accountId: number): Promise<RetryableDocument[]> {
    return this.#db
      .select({
        id: invoiceDocument.id,
        remoteDocumentId: invoiceDocument.remoteDocumentId,
        subType: invoiceDocument.subType,
        invoiceNumber: invoice.number,
        issuedOn: invoice.issuedOn,
        contractNumber: invoice.contractNumber,
      })
      .from(invoiceDocument)
      .innerJoin(invoice, eq(invoiceDocument.invoiceId, invoice.id))
      .where(
        and(
          eq(invoice.accountId, accountId),
          inArray(invoiceDocument.state, ["pending", "failed"]),
        ),
      )
      .all();
  }

  async markStored(documentId: number, file: StoredFile, nowSeconds: number): Promise<void> {
    this.#db
      .update(invoiceDocument)
      .set({
        state: "stored",
        relativePath: file.relativePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        storedAt: nowSeconds,
        lastError: null,
      })
      .where(eq(invoiceDocument.id, documentId))
      .run();
  }

  async markFailed(documentId: number, message: string): Promise<void> {
    this.#db
      .update(invoiceDocument)
      .set({ state: "failed", lastError: message })
      .where(eq(invoiceDocument.id, documentId))
      .run();
  }
}
