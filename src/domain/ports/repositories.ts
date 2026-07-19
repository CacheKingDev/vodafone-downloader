import type { Account, AccountStatus } from "../account.js";
import type { Invoice } from "../invoice.js";
import type { AuthSession } from "../vodafone-session.js";
import type { StoredFile } from "./file-storage.js";

/** A document in state pending or failed, joined with its invoice for naming. */
export interface RetryableDocument {
  /** invoice_document.id — the local row, not the portal id. */
  readonly id: number;
  readonly remoteDocumentId: string;
  readonly subType: string | null;
  readonly invoiceNumber: string;
  readonly issuedOn: string;
  readonly contractNumber: string | null;
}

export interface AccountRepository {
  findById(id: number): Promise<Account | undefined>;
  /** Persists a renewed session encrypted, stamping session_refreshed_at. */
  saveSession(id: number, session: AuthSession): Promise<void>;
  setStatus(id: number, status: AccountStatus, detail?: string): Promise<void>;
}

export interface InvoiceRepository {
  /** All invoice numbers already known for the account — the dedup set. */
  existingNumbers(accountId: number): Promise<Set<string>>;
  /** Inserts the invoice and its documents (state=pending) in one transaction. */
  insertInvoice(accountId: number, invoice: Invoice): Promise<void>;
  /** Documents in state pending OR failed — only `stored` is final. */
  listRetryableDocuments(accountId: number): Promise<RetryableDocument[]>;
  markStored(documentId: number, file: StoredFile, nowSeconds: number): Promise<void>;
  markFailed(documentId: number, message: string): Promise<void>;
}

export interface SettingsRepository {
  /** The validated filename template, falling back to the default. */
  filenameTemplate(): Promise<string>;
}
