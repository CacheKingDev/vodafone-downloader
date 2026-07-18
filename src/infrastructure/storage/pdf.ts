import { DocumentValidationError } from "../../domain/errors.js";

const PDF_MAGIC = Buffer.from("%PDF-", "ascii");

/** Below this, the "document" is an error page or truncated download. */
export const MIN_PDF_BYTES = 100;

/**
 * Sanity check before anything touches the disk: the portal answered with
 * JSON-wrapped base64, so a decoding or portal error yields bytes that are
 * not a PDF. Failing here marks the document failed instead of storing junk.
 */
export function validatePdf(bytes: Buffer): void {
  if (bytes.length < MIN_PDF_BYTES) {
    throw new DocumentValidationError(
      `Document is too small to be a PDF: ${bytes.length} bytes (minimum ${MIN_PDF_BYTES})`,
    );
  }
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new DocumentValidationError("Document does not start with %PDF- magic bytes");
  }
}
