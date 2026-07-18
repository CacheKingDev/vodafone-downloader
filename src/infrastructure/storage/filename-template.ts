import { TemplateError } from "../../domain/errors.js";
import type { TemplateContext } from "../../domain/ports/file-storage.js";

export const DEFAULT_FILENAME_TEMPLATE =
  "{account_label}/{year}/{issued_on}_{invoice_number}_{sub_type}.pdf";

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

const ALLOWED_PLACEHOLDERS = new Set([
  "account_label",
  "invoice_number",
  "year",
  "month",
  "day",
  "issued_on",
  "sub_type",
  "contract_number",
]);

/** Throws when the template names placeholders outside the whitelist. */
export function validateTemplate(template: string): void {
  const unknown = [...template.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1] ?? "")
    .filter((name) => !ALLOWED_PLACEHOLDERS.has(name));
  if (unknown.length > 0) {
    throw new TemplateError(`Unknown template placeholders: ${unknown.join(", ")}`);
  }
}

/**
 * A value may never introduce path structure: separators, traversal, control
 * characters and SMB/Windows-forbidden characters collapse to underscores.
 * Empty results become "unknown" so no segment silently vanishes.
 */
function sanitizeValue(value: string): string {
  const cleaned = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we strip
    .replace(/[<>:"/|?*\u0000-\u001f]/g, "_")
    .replace(/\.{2,}/g, "_")
    .trim();
  return cleaned === "" ? "unknown" : cleaned;
}

/**
 * Renders a validated template into a safe relative path. Template literals
 * provide the path structure ('/'); rendered values never can. Each final
 * segment is checked again so a hostile template cannot smuggle '..' through.
 */
export function renderFilename(template: string, context: TemplateContext): string {
  validateTemplate(template);
  const [year = "", month = "", day = ""] = context.issuedOn.split("-");
  const values: Record<string, string> = {
    account_label: context.accountLabel,
    invoice_number: context.invoiceNumber,
    issued_on: context.issuedOn,
    year,
    month,
    day,
    sub_type: context.subType ?? "unknown",
    contract_number: context.contractNumber ?? "unknown",
  };
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_, name: string) =>
    sanitizeValue(values[name] ?? ""),
  );
  const segments = rendered.split("/").map((segment) => segment.replace(/[. ]+$/, ""));
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TemplateError(`Template renders an unsafe path: ${rendered}`);
  }
  return segments.join("/");
}
