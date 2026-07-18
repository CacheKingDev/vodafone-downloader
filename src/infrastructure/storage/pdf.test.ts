import { describe, expect, it } from "vitest";
import { DocumentValidationError } from "../../domain/errors.js";
import { MIN_PDF_BYTES, validatePdf } from "./pdf.js";

const pdfOf = (size: number): Buffer => {
  const bytes = Buffer.alloc(size, "x");
  bytes.write("%PDF-1.4\n", 0, "ascii");
  return bytes;
};

describe("validatePdf", () => {
  it("accepts a buffer with %PDF- magic and sufficient size", () => {
    expect(() => validatePdf(pdfOf(MIN_PDF_BYTES))).not.toThrow();
  });

  it("rejects a buffer below the minimum size", () => {
    expect(() => validatePdf(pdfOf(MIN_PDF_BYTES - 1))).toThrow(DocumentValidationError);
  });

  it("rejects a buffer without the magic bytes", () => {
    const html = Buffer.alloc(MIN_PDF_BYTES, "x");
    html.write("<html>err", 0, "ascii");
    expect(() => validatePdf(html)).toThrow(DocumentValidationError);
    expect(() => validatePdf(html)).toThrow(/%PDF-/);
  });
});
