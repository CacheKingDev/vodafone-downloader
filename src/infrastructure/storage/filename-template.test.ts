import { describe, expect, it } from "vitest";
import { TemplateError } from "../../domain/errors.js";
import type { TemplateContext } from "../../domain/ports/file-storage.js";
import {
  DEFAULT_FILENAME_TEMPLATE,
  renderFilename,
  validateTemplate,
} from "./filename-template.js";

const context: TemplateContext = {
  accountLabel: "Privat",
  invoiceNumber: "123456789012",
  issuedOn: "2026-03-01",
  subType: "Rechnung",
  contractNumber: "9876",
};

describe("validateTemplate", () => {
  it("accepts the default template", () => {
    expect(() => validateTemplate(DEFAULT_FILENAME_TEMPLATE)).not.toThrow();
  });

  it("rejects unknown placeholders, naming them", () => {
    expect(() => validateTemplate("{account_label}/{nope}.pdf")).toThrow(TemplateError);
    expect(() => validateTemplate("{account_label}/{nope}.pdf")).toThrow(/nope/);
  });
});

describe("renderFilename", () => {
  it("renders the default template", () => {
    expect(renderFilename(DEFAULT_FILENAME_TEMPLATE, context)).toBe(
      "Privat/2026/2026-03-01_123456789012_Rechnung.pdf",
    );
  });

  it("derives year, month and day from issuedOn", () => {
    expect(renderFilename("{year}/{month}/{day}.pdf", context)).toBe("2026/03/01.pdf");
  });

  it("renders null values as 'unknown'", () => {
    const bare: TemplateContext = { ...context, subType: null, contractNumber: null };
    expect(renderFilename("{sub_type}_{contract_number}.pdf", bare)).toBe("unknown_unknown.pdf");
  });

  it("strips path separators and traversal from values", () => {
    const hostile: TemplateContext = {
      ...context,
      accountLabel: "../..",
      subType: "a/b\\c",
    };
    const rendered = renderFilename("{account_label}/{sub_type}.pdf", hostile);
    expect(rendered).not.toContain("..");
    expect(rendered.split("/").length).toBe(2);
  });

  it("replaces characters SMB/Windows forbids", () => {
    const hostile: TemplateContext = { ...context, accountLabel: 'a<b>c:d"e|f?g*h' };
    const rendered = renderFilename("{account_label}.pdf", hostile);
    expect(rendered).toBe("a_b_c_d_e_f_g_h.pdf");
  });

  it("rejects a template that renders an empty segment", () => {
    const empty: TemplateContext = { ...context, accountLabel: "" };
    // "unknown" fills the empty value, so this passes ...
    expect(renderFilename("{account_label}/x.pdf", empty)).toBe("unknown/x.pdf");
    // ... but a template with a literal empty segment fails.
    expect(() => renderFilename("a//x.pdf", context)).toThrow(TemplateError);
  });

  it("collapses backslashes in values", () => {
    const hostile: TemplateContext = { ...context, accountLabel: "..\\..\\evil" };
    const rendered = renderFilename("{account_label}/x.pdf", hostile);
    expect(rendered).not.toContain("\\");
    expect(rendered.split("/").length).toBe(2);
  });
});
