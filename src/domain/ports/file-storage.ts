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
