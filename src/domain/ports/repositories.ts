import type { Account, AccountStatus } from "../account.js";
import type { Invoice } from "../invoice.js";
import type {
  CreateStorageTargetInput,
  StorageTarget,
  StorageTargetStatus,
  StorageTargetSummary,
  UpdateStorageTargetInput,
} from "../storage-target.js";
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

export type RunTrigger = "schedule" | "manual";

export interface AccountSummary {
  readonly id: number;
  readonly label: string;
  readonly customerUrn: string;
  readonly enabled: boolean;
  readonly backfillFrom: string | null;
  readonly status: AccountStatus;
  readonly statusDetail: string | null;
  readonly sessionRefreshedAt: number | null;
}

export interface CreateAccountInput {
  readonly label: string;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
  readonly customerUrn: string;
  readonly status: AccountStatus;
}

export interface InvoiceListFilters {
  readonly accountId?: number;
  readonly state?: "pending" | "stored" | "failed";
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface InvoiceListItem {
  readonly id: number;
  readonly accountId: number;
  readonly accountLabel: string;
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly subject: string | null;
  readonly contractNumber: string | null;
  readonly documentId: number | null;
  readonly documentState: "pending" | "stored" | "failed" | null;
  readonly relativePath: string | null;
  readonly lastError: string | null;
}

export interface InvoiceListResult {
  readonly items: readonly InvoiceListItem[];
  readonly total: number;
}

export interface StoredDocumentInfo {
  readonly relativePath: string;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
}

export interface RunListItem {
  readonly id: number;
  readonly accountId: number | null;
  readonly accountLabel: string | null;
  readonly trigger: RunTrigger;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly outcome: "success" | "partial" | "failed" | null;
  readonly invoicesSeen: number;
  readonly documentsStored: number;
  readonly errorMessage: string | null;
}

/** What a finished run persists — mirrors SyncReport minus the failure list. */
export interface RunResult {
  readonly outcome: "success" | "partial" | "failed";
  readonly invoicesSeen: number;
  readonly documentsStored: number;
  readonly errorMessage: string | null;
}

/** One row in the run table per account sync. */
export interface RunRepository {
  /** Creates the row with started_at = now and returns its id. */
  startRun(accountId: number, trigger: RunTrigger): Promise<number>;
  finishRun(runId: number, result: RunResult): Promise<void>;
}

export interface AccountRepository {
  findById(id: number): Promise<Account | undefined>;
  /** Persists a renewed session encrypted, stamping session_refreshed_at. */
  saveSession(id: number, session: AuthSession): Promise<void>;
  setStatus(id: number, status: AccountStatus, detail?: string): Promise<void>;
  /**
   * Ids of accounts the scheduler may sync: enabled and not needs_action.
   * Accounts in status "error" ARE included — retrying across runs is how the
   * status heals after an app update (M4 spec section 3).
   */
  listSyncableIds(): Promise<number[]>;
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
  /** The global cron expression for scheduled syncs, falling back to the default. */
  syncSchedule(): Promise<string>;
}

export interface StoredDocumentRecord {
  readonly id: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export type MigrationStatus = "running" | "completed" | "failed";

/**
 * "migrate" transfers existing documents to the new default target in the
 * background (spec section 12); "new_only" switches the default immediately
 * and leaves prior documents where they are.
 */
export type StorageMigrationMode = "migrate" | "new_only";

export interface StorageMigrationRecord {
  readonly id: number;
  readonly fromTargetId: number;
  readonly toTargetId: number;
  readonly mode: StorageMigrationMode;
  readonly status: MigrationStatus;
  readonly totalDocuments: number;
  readonly migratedDocuments: number;
  readonly failedDocuments: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly errorMessage: string | null;
}

export interface CreateMigrationInput {
  readonly fromTargetId: number;
  readonly toTargetId: number;
  readonly mode: StorageMigrationMode;
  readonly totalDocuments: number;
}

export interface MigrationRepository {
  listStoredDocuments(): Promise<StoredDocumentRecord[]>;
  createMigration(input: CreateMigrationInput): Promise<number>;
  findRunningMigration(): Promise<StorageMigrationRecord | undefined>;
  findMigration(id: number): Promise<StorageMigrationRecord | undefined>;
  incrementProgress(id: number, outcome: "migrated" | "failed"): Promise<void>;
  setTotalDocuments(id: number, total: number): Promise<void>;
  completeMigration(id: number): Promise<void>;
  failMigration(id: number, message: string): Promise<void>;
}

/** Narrow read path used by sync and downloads — resolving the active target's config. */
export interface StorageTargetRepository {
  findDefault(): Promise<StorageTarget | undefined>;
}

export interface StorageTargetUiRepository extends StorageTargetRepository {
  list(): Promise<StorageTargetSummary[]>;
  findById(id: number): Promise<StorageTarget | undefined>;
  nameExists(name: string, excludingId?: number): Promise<boolean>;
  create(input: CreateStorageTargetInput): Promise<number>;
  update(id: number, input: UpdateStorageTargetInput): Promise<void>;
  setStatus(id: number, status: StorageTargetStatus): Promise<void>;
  recordTestResult(
    id: number,
    result: { success: boolean; errorMessage: string | null },
  ): Promise<void>;
  /** Atomically clears is_default on every other row and sets it on this one. */
  setDefault(id: number): Promise<void>;
  setDisabled(id: number, disabled: boolean): Promise<void>;
  delete(id: number): Promise<void>;
}

export interface AccountUiRepository extends AccountRepository {
  create(account: CreateAccountInput): Promise<number>;
  listAll(): Promise<AccountSummary[]>;
  updateLabel(id: number, label: string): Promise<void>;
  delete(id: number): Promise<void>;
  setEnabled(id: number, enabled: boolean): Promise<void>;
}

export interface InvoiceUiRepository extends InvoiceRepository {
  listInvoices(filters: InvoiceListFilters): Promise<InvoiceListResult>;
  findStoredDocument(documentId: number): Promise<StoredDocumentInfo | undefined>;
}

export interface SettingsUiRepository extends SettingsRepository {
  setFilenameTemplate(template: string): Promise<void>;
  setSyncSchedule(schedule: string): Promise<void>;
  /** Hex-encoded override hash, or null if the admin password was never changed from its default. */
  adminPasswordHash(): Promise<string | null>;
  setAdminPasswordHash(hashHex: string): Promise<void>;
}

export interface RunUiRepository extends RunRepository {
  listRecent(limit: number): Promise<RunListItem[]>;
  findRun(id: number): Promise<RunListItem | undefined>;
}
