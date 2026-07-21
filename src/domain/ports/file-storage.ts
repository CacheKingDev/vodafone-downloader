import type { ConnectionTestResult } from "../connection-test.js";

/** Result of a completed store: the path actually used (after collision
 * resolution), plus integrity metadata for persistence. */
export interface StoredFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface FileStorage {
  /**
   * Writes bytes atomically below the downloads root. On a path collision the
   * implementation appends _2, _3, … before the extension; the path actually
   * used is returned.
   */
  store(relativePath: string, bytes: Buffer): Promise<StoredFile>;
  /** Reads bytes back. Throws StorageError if the path does not exist or is unreachable. */
  retrieve(relativePath: string): Promise<Buffer>;
  /** Deletes the file. A missing file is not an error. */
  remove(relativePath: string): Promise<void>;
  /**
   * Verifies the backend step by step (host/auth/path/read/write, spec
   * section 9) and reports each step individually — never throws for an
   * ordinary connectivity/auth/permission failure, only for programmer error.
   */
  testConnection(): Promise<ConnectionTestResult>;
  /** Whether the configured root path can be listed/read. */
  checkReadAccess(): Promise<boolean>;
  /** Whether a file can be created below the configured root path. */
  checkWriteAccess(): Promise<boolean>;
  /** Creates the configured root path if it does not exist yet. */
  createDirectory(): Promise<void>;
}

/** Everything the filename template may reference for one document. */
export interface TemplateContext {
  readonly accountLabel: string;
  readonly invoiceNumber: string;
  /** 'YYYY-MM-DD' — year/month/day placeholders derive from this. */
  readonly issuedOn: string;
  readonly subType: string | null;
  readonly contractNumber: string | null;
}

/**
 * Pure functions injected into the sync use case. Their implementations live
 * in infrastructure/storage; only these types cross the boundary, keeping the
 * dependency rule (application imports domain only) intact.
 */
export type FilenameRenderer = (template: string, context: TemplateContext) => string;
export type PdfValidator = (bytes: Buffer) => void;
