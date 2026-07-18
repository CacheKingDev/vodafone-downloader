# Meilenstein 3: Domäne & Storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein getesteter Sync-Pfad von „Session vorhanden" bis „PDF liegt validiert auf der Platte": Use Case `syncAccount` mit `SyncReport`, Repositories mit Entschlüsselung, Dateinamen-Template, PDF-Validierung, atomares Schreiben.

**Architecture:** Ein Use Case orchestriert ausschließlich Ports (`VodafoneProvider`, drei Repositories, `FileStorage`) plus zwei injizierte reine Funktionen (`renderFilename`, `validatePdf`). Die reinen Funktionen liegen in `infrastructure/storage`, ihre **Typen** im Domain-Port — so bleibt die Dependency-Regel (application kennt nur domain) intakt. Entschlüsselung passiert in den Repository-Implementierungen; die Application-Schicht sieht nie Crypto.

**Tech Stack:** Node 24 LTS · TypeScript 5 (strict) · Drizzle + better-sqlite3 · Zod 4 · Vitest 3 · Biome 2

**Spec:** `docs/superpowers/specs/2026-07-18-meilenstein-3-domaene-storage-design.md`

## Global Constraints

- **TypeScript strict.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Kein `any`** — auch nicht in Tests.
- **Keine TODO-Kommentare, keine Platzhalter, keine Mock-Implementierungen.** Jede Funktion ist vollständig.
- **ESM only.** Imports mit `.js`-Endung. Node-Builtins mit `node:`-Präfix.
- **Geld niemals als Float**, Kalenderdaten als TEXT `YYYY-MM-DD`, Zeitpunkte als Unix-Integer (Sekunden).
- **Keine Secrets/Tokens im Log.**
- **Auth-Fehler werden niemals wiederholt.** Konto → `needs_action`, Lauf endet.
- **Drizzle mit better-sqlite3 ist synchron** (`.all()`, `.get()`, `.run()`); die Ports sind trotzdem `Promise`-basiert — Implementierungen sind `async` und resolven sofort.
- **Sprache:** Code/Bezeichner/Kommentare Englisch. Commit-Body Deutsch.
- **Commits:** Conventional Commits, deutschsprachiger Body, mit
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
  **Commit-Message über das Bash-Tool mit Single-Quote-Heredoc absetzen**
  (`git commit -F - <<'EOF' … EOF`) — PowerShell transliteriert sonst Umlaute.
- **Formatstil (Biome):** doppelte Anführungszeichen, 2-Space-Indent, Zeilenbreite 100. Nach jedem Task `npm run lint`; bei Formatfehlern `npx biome check --write <pfad>`.

---

## File Structure

| Datei | Verantwortung |
|---|---|
| `src/domain/errors.ts` (erweitern) | `TemplateError`, `DocumentValidationError`, `StorageError` |
| `src/domain/account.ts` | Entität `Account` (entschlüsselte Sicht), `AccountStatus` |
| `src/domain/ports/repositories.ts` | `AccountRepository`, `InvoiceRepository`, `SettingsRepository`, `RetryableDocument` |
| `src/domain/ports/file-storage.ts` | `FileStorage`, `StoredFile`, `TemplateContext`, `FilenameRenderer`, `PdfValidator` |
| `src/application/sync-invoices.ts` | `syncAccount`, `SyncDeps`, `SyncReport`, `DocumentFailure` |
| `src/infrastructure/storage/filename-template.ts` | `validateTemplate`, `renderFilename`, `DEFAULT_FILENAME_TEMPLATE` |
| `src/infrastructure/storage/pdf.ts` | `validatePdf` |
| `src/infrastructure/storage/atomic-file-storage.ts` | `AtomicFileStorage` |
| `src/infrastructure/persistence/repositories/account-repository.ts` | `DrizzleAccountRepository` (mit `Cipher`) |
| `src/infrastructure/persistence/repositories/invoice-repository.ts` | `DrizzleInvoiceRepository` |
| `src/infrastructure/persistence/repositories/settings-repository.ts` | `DrizzleSettingsRepository` |
| `src/composition-root.ts` (erweitern) | Verdrahtung: Repos, Storage, Provider, `sync`-Funktion |

Vorhandene Bausteine (nicht anfassen, nur benutzen): `Cipher` (`encrypt(string): Buffer`, `decrypt(Buffer): string`), `Database` (Drizzle + `$client`), Schema-Tabellen `account`/`invoice`/`invoiceDocument`/`setting`, `VodafoneProviderFacade` (Port `VodafoneProvider`), Domänentypen `Invoice`, `InvoiceDocumentMeta`, `AccountCredentials`, `DocumentPayload`, `AuthSession`.

---

### Task 1: Fehlerklassen, Account-Entität, Ports

**Files:**
- Modify: `src/domain/errors.ts`, `src/domain/errors.test.ts`
- Create: `src/domain/account.ts`, `src/domain/ports/repositories.ts`, `src/domain/ports/file-storage.ts`

**Interfaces:**
- Consumes: `AppError`, `AccountCredentials`, `AuthSession`, `Invoice`
- Produces: `TemplateError` (`code: "TEMPLATE"`), `DocumentValidationError` (`"DOCUMENT_INVALID"`), `StorageError` (`"STORAGE"`); `AccountStatus`, `Account`; `AccountRepository`, `InvoiceRepository`, `SettingsRepository`, `RetryableDocument`; `FileStorage`, `StoredFile`, `TemplateContext`, `FilenameRenderer`, `PdfValidator`

- [ ] **Step 1: Failing test für die Fehlerklassen ergänzen**

An `src/domain/errors.test.ts` anhängen (Import um die drei Klassen erweitern):

```ts
describe("storage errors", () => {
  it("exposes a stable code per subclass", () => {
    expect(new TemplateError("x").code).toBe("TEMPLATE");
    expect(new DocumentValidationError("x").code).toBe("DOCUMENT_INVALID");
    expect(new StorageError("x").code).toBe("STORAGE");
  });

  it("is an AppError with preserved cause", () => {
    const cause = new Error("root");
    const error = new StorageError("boom", { cause });
    expect(error).toBeInstanceOf(AppError);
    expect(error.cause).toBe(cause);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: FAIL — `TemplateError` ist kein Export.

- [ ] **Step 3: Fehlerklassen implementieren**

An `src/domain/errors.ts` anhängen:

```ts
/** A filename template names unknown placeholders or renders an unsafe path. */
export class TemplateError extends AppError {
  readonly code = "TEMPLATE";
}

/** A downloaded document failed validation (magic bytes, minimum size). */
export class DocumentValidationError extends AppError {
  readonly code = "DOCUMENT_INVALID";
}

/** Writing a file to the downloads directory failed or was rejected as unsafe. */
export class StorageError extends AppError {
  readonly code = "STORAGE";
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/domain/errors.test.ts`
Erwartet: PASS.

- [ ] **Step 5: Account-Entität schreiben**

Datei `src/domain/account.ts`:

```ts
import type { AccountCredentials } from "./invoice.js";
import type { AuthSession } from "./vodafone-session.js";

export type AccountStatus = "ok" | "needs_action" | "error";

/**
 * The decrypted domain view of an account. Repositories decrypt on read;
 * this layer never sees ciphertext or the cipher.
 */
export interface Account {
  readonly id: number;
  readonly label: string;
  readonly credentials: AccountCredentials;
  readonly customerUrn: string;
  readonly enabled: boolean;
  /** 'YYYY-MM-DD' — invoices issued before this date are never synced. Null = all. */
  readonly backfillFrom: string | null;
  readonly status: AccountStatus;
  readonly session: AuthSession | null;
}
```

- [ ] **Step 6: Repository-Ports schreiben**

Datei `src/domain/ports/repositories.ts`:

```ts
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
```

- [ ] **Step 7: FileStorage-Port schreiben**

Datei `src/domain/ports/file-storage.ts`:

```ts
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
```

- [ ] **Step 8: Typecheck und Lint**

Run: `npm run typecheck && npm run lint`
Erwartet: sauber (reine Typen — kein weiterer Test nötig).

- [ ] **Step 9: Commit**

```bash
git add src/domain/errors.ts src/domain/errors.test.ts src/domain/account.ts src/domain/ports/repositories.ts src/domain/ports/file-storage.ts
git commit -F - <<'EOF'
feat: Domänenschicht für Sync und Storage

Drei Fehlerklassen (Template, Dokument, Storage), die entschlüsselte
Account-Sicht und die Ports: Repositories, FileStorage sowie die Typen der
injizierten reinen Funktionen (Renderer, PDF-Validator), damit die
Application-Schicht keine Infrastruktur importieren muss.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Dateinamen-Template

**Files:**
- Create: `src/infrastructure/storage/filename-template.ts`
- Test: `src/infrastructure/storage/filename-template.test.ts`

**Interfaces:**
- Consumes: `TemplateError`, `TemplateContext`
- Produces:
  - `const DEFAULT_FILENAME_TEMPLATE = "{account_label}/{year}/{issued_on}_{invoice_number}_{sub_type}.pdf"`
  - `function validateTemplate(template: string): void` — wirft `TemplateError` bei unbekannten Platzhaltern
  - `function renderFilename(template: string, context: TemplateContext): string` (erfüllt `FilenameRenderer`)

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/storage/filename-template.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/storage/filename-template.test.ts`
Erwartet: FAIL — `Failed to resolve import "./filename-template.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/storage/filename-template.ts`:

```ts
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
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
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
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/storage/filename-template.test.ts`
Erwartet: PASS — 8 Assertions in 7 Tests. Hinweis: das letzte Segment endet auf `.pdf` und hat damit keinen trailing dot — `replace(/[. ]+$/, "")` greift dort nicht.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/storage/filename-template.ts src/infrastructure/storage/filename-template.test.ts
git commit -F - <<'EOF'
feat: Dateinamen-Template mit Whitelist und Sanitizing

validateTemplate weist unbekannte Platzhalter namentlich ab. renderFilename
lässt Pfadstruktur nur aus dem Template selbst zu: Werte verlieren Trenner,
Traversal, Steuer- und SMB-verbotene Zeichen; leere Werte werden "unknown";
jedes finale Segment wird erneut geprüft.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: PDF-Validierung

**Files:**
- Create: `src/infrastructure/storage/pdf.ts`
- Test: `src/infrastructure/storage/pdf.test.ts`

**Interfaces:**
- Consumes: `DocumentValidationError`
- Produces: `function validatePdf(bytes: Buffer): void` (erfüllt `PdfValidator`), `const MIN_PDF_BYTES = 100`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/storage/pdf.test.ts`:

```ts
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
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/storage/pdf.test.ts`
Erwartet: FAIL — `Failed to resolve import "./pdf.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/storage/pdf.ts`:

```ts
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
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/storage/pdf.test.ts`
Erwartet: PASS — 3 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/storage/pdf.ts src/infrastructure/storage/pdf.test.ts
git commit -F - <<'EOF'
feat: PDF-Validierung vor dem Schreiben

Magic Bytes und Mindestgröße; ein Fehlschlag markiert das Dokument als
failed, statt eine Fehlerseite als Rechnung zu speichern.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Atomarer FileStorage

**Files:**
- Create: `src/infrastructure/storage/atomic-file-storage.ts`
- Test: `src/infrastructure/storage/atomic-file-storage.test.ts`

**Interfaces:**
- Consumes: `FileStorage`, `StoredFile`, `StorageError`
- Produces: `class AtomicFileStorage implements FileStorage` mit `constructor(rootDir: string)` und `store(relativePath: string, bytes: Buffer): Promise<StoredFile>`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/storage/atomic-file-storage.test.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";

let root: string;
let storage: AtomicFileStorage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vid-storage-"));
  storage = new AtomicFileStorage(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const bytes = Buffer.from("%PDF-1.4 test content");

describe("AtomicFileStorage", () => {
  it("stores bytes at the relative path and reports hash and size", async () => {
    const stored = await storage.store("a/2026/rechnung.pdf", bytes);
    expect(stored.relativePath).toBe("a/2026/rechnung.pdf");
    expect(stored.sizeBytes).toBe(bytes.length);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(join(root, "a", "2026", "rechnung.pdf"))).toEqual(bytes);
  });

  it("appends _2 before the extension on collision", async () => {
    await storage.store("a/r.pdf", bytes);
    const second = await storage.store("a/r.pdf", Buffer.from("%PDF- other"));
    expect(second.relativePath).toBe("a/r_2.pdf");
    expect(existsSync(join(root, "a", "r.pdf"))).toBe(true);
    expect(existsSync(join(root, "a", "r_2.pdf"))).toBe(true);
  });

  it("continues the suffix sequence on repeated collisions", async () => {
    await storage.store("r.pdf", bytes);
    await storage.store("r.pdf", bytes);
    const third = await storage.store("r.pdf", bytes);
    expect(third.relativePath).toBe("r_3.pdf");
  });

  it("leaves no temp files behind after storing", async () => {
    await storage.store("x.pdf", bytes);
    expect(readdirSync(join(root, ".tmp"))).toEqual([]);
  });

  it("rejects paths that escape the root", async () => {
    await expect(storage.store("../evil.pdf", bytes)).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects absolute paths", async () => {
    await expect(storage.store("/etc/evil.pdf", bytes)).rejects.toBeInstanceOf(StorageError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/storage/atomic-file-storage.test.ts`
Erwartet: FAIL — `Failed to resolve import "./atomic-file-storage.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/storage/atomic-file-storage.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";

/**
 * Writes below a fixed root only. The write is atomic: bytes go to
 * root/.tmp/<uuid>, are fsynced, then renamed to the target — same
 * filesystem, so a crashed run never leaves a half-written PDF in place.
 * Collisions resolve by appending _2, _3, … before the extension.
 */
export class AtomicFileStorage implements FileStorage {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    if (isAbsolute(relativePath)) {
      throw new StorageError(`Refusing absolute path: ${relativePath}`);
    }
    const target = resolve(this.#root, relativePath);
    if (!target.startsWith(this.#root + sep)) {
      throw new StorageError(`Path escapes the downloads root: ${relativePath}`);
    }
    const finalPath = this.resolveCollision(target);

    const tmpDir = join(this.#root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = join(tmpDir, randomUUID());
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);

    return {
      relativePath: relative(this.#root, finalPath).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  private resolveCollision(target: string): string {
    if (!existsSync(target)) return target;
    const ext = extname(target);
    const base = ext === "" ? target : target.slice(0, -ext.length);
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}_${suffix}${ext}`;
      if (!existsSync(candidate)) return candidate;
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/storage/atomic-file-storage.test.ts`
Erwartet: PASS — 6 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/storage/atomic-file-storage.ts src/infrastructure/storage/atomic-file-storage.test.ts
git commit -F - <<'EOF'
feat: atomarer FileStorage unter dem Downloads-Root

Schreiben nach .tmp mit fsync, dann rename im selben Dateisystem — kein
halbes PDF am Zielort. Kollisionen erhalten _2, _3 vor der Endung; Pfade
außerhalb des Roots und absolute Pfade werden abgewiesen.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: SettingsRepository

**Files:**
- Create: `src/infrastructure/persistence/repositories/settings-repository.ts`
- Test: `src/infrastructure/persistence/repositories/settings-repository.test.ts`

**Interfaces:**
- Consumes: `SettingsRepository` (Port), `Database`, `setting`-Tabelle, `validateTemplate`, `DEFAULT_FILENAME_TEMPLATE`, `TemplateError`
- Produces: `class DrizzleSettingsRepository implements SettingsRepository` mit `constructor(db: Database)`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/persistence/repositories/settings-repository.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateError } from "../../../domain/errors.js";
import { DEFAULT_FILENAME_TEMPLATE } from "../../storage/filename-template.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { setting } from "../schema.js";
import { DrizzleSettingsRepository } from "./settings-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleSettingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleSettingsRepository(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleSettingsRepository.filenameTemplate", () => {
  it("returns the default when no setting exists", async () => {
    await expect(repo.filenameTemplate()).resolves.toBe(DEFAULT_FILENAME_TEMPLATE);
  });

  it("returns a stored, valid template", async () => {
    db.insert(setting)
      .values({ key: "filename_template", value: JSON.stringify("{invoice_number}.pdf") })
      .run();
    await expect(repo.filenameTemplate()).resolves.toBe("{invoice_number}.pdf");
  });

  it("throws TemplateError for a stored template with unknown placeholders", async () => {
    db.insert(setting)
      .values({ key: "filename_template", value: JSON.stringify("{bogus}.pdf") })
      .run();
    await expect(repo.filenameTemplate()).rejects.toBeInstanceOf(TemplateError);
  });

  it("throws TemplateError when the stored value is not JSON for a string", async () => {
    db.insert(setting).values({ key: "filename_template", value: "not json{" }).run();
    await expect(repo.filenameTemplate()).rejects.toBeInstanceOf(TemplateError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Erwartet: FAIL — `Failed to resolve import "./settings-repository.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/persistence/repositories/settings-repository.ts`:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TemplateError } from "../../../domain/errors.js";
import type { SettingsRepository } from "../../../domain/ports/repositories.js";
import { DEFAULT_FILENAME_TEMPLATE, validateTemplate } from "../../storage/filename-template.js";
import type { Database } from "../database.js";
import { setting } from "../schema.js";

const FILENAME_TEMPLATE_KEY = "filename_template";

/**
 * Settings are stored as JSON strings and validated on read (spec section 5):
 * a corrupt or invalid template must fail loudly here, not render a wrong
 * path silently during a sync.
 */
export class DrizzleSettingsRepository implements SettingsRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async filenameTemplate(): Promise<string> {
    const row = this.#db
      .select()
      .from(setting)
      .where(eq(setting.key, FILENAME_TEMPLATE_KEY))
      .get();
    if (row === undefined) return DEFAULT_FILENAME_TEMPLATE;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (cause) {
      throw new TemplateError("Stored filename_template is not valid JSON", { cause });
    }
    const result = z.string().min(1).safeParse(parsed);
    if (!result.success) {
      throw new TemplateError("Stored filename_template is not a non-empty string");
    }
    validateTemplate(result.data);
    return result.data;
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Erwartet: PASS — 4 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/repositories/settings-repository.ts src/infrastructure/persistence/repositories/settings-repository.test.ts
git commit -F - <<'EOF'
feat: SettingsRepository liest das Dateinamen-Template

JSON-Wert aus der setting-Tabelle, beim Lesen Zod- und Whitelist-validiert;
fehlt der Eintrag, gilt der Default. Kaputte Werte scheitern laut als
TemplateError statt still einen falschen Pfad zu rendern.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: AccountRepository

**Files:**
- Create: `src/infrastructure/persistence/repositories/account-repository.ts`
- Test: `src/infrastructure/persistence/repositories/account-repository.test.ts`

**Interfaces:**
- Consumes: `AccountRepository` (Port), `Account`, `AuthSession`, `Database`, `account`-Tabelle, `Cipher`
- Produces: `class DrizzleAccountRepository implements AccountRepository` mit `constructor(db: Database, cipher: Cipher)`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/persistence/repositories/account-repository.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../../../domain/vodafone-session.js";
import { Cipher } from "../../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account } from "../schema.js";
import { DrizzleAccountRepository } from "./account-repository.js";

let dir: string;
let db: Database;
let cipher: Cipher;
let repo: DrizzleAccountRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-accounts-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  cipher = new Cipher(randomBytes(32));
  repo = new DrizzleAccountRepository(db, cipher);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function insertAccount(sessionStateEnc: Buffer | null = null): number {
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: cipher.encrypt("user@example.com"),
      passwordEnc: cipher.encrypt("s3cret"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
      backfillFrom: "2024-01-01",
      status: "ok",
      sessionStateEnc,
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  return row.id;
}

const session: AuthSession = { accessToken: "tok", expiresAt: 4600, storageState: "{}" };

describe("DrizzleAccountRepository", () => {
  it("returns undefined for a missing id", async () => {
    await expect(repo.findById(999)).resolves.toBeUndefined();
  });

  it("decrypts credentials and maps fields", async () => {
    const id = insertAccount();
    const found = await repo.findById(id);
    expect(found?.credentials).toEqual({ username: "user@example.com", password: "s3cret" });
    expect(found?.label).toBe("Privat");
    expect(found?.customerUrn).toBe("urn:vf-de:cable:can:0000000001");
    expect(found?.backfillFrom).toBe("2024-01-01");
    expect(found?.status).toBe("ok");
    expect(found?.enabled).toBe(true);
    expect(found?.session).toBeNull();
  });

  it("round-trips a session through saveSession", async () => {
    const id = insertAccount();
    await repo.saveSession(id, session);
    const found = await repo.findById(id);
    expect(found?.session).toEqual(session);
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.sessionRefreshedAt).toBeTypeOf("number");
    // The stored blob must not contain the plaintext token.
    expect(row?.sessionStateEnc?.includes(Buffer.from("tok"))).toBe(false);
  });

  it("returns a null session for an undecryptable blob instead of throwing", async () => {
    const id = insertAccount(Buffer.from("garbage-not-encrypted"));
    const found = await repo.findById(id);
    expect(found?.session).toBeNull();
  });

  it("updates status with detail", async () => {
    const id = insertAccount();
    await repo.setStatus(id, "needs_action", "credentials rejected");
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.status).toBe("needs_action");
    expect(row?.statusDetail).toBe("credentials rejected");
  });

  it("clears the detail when none is given", async () => {
    const id = insertAccount();
    await repo.setStatus(id, "needs_action", "old detail");
    await repo.setStatus(id, "ok");
    const row = db.select().from(account).where(eq(account.id, id)).get();
    expect(row?.statusDetail).toBeNull();
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: FAIL — `Failed to resolve import "./account-repository.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/persistence/repositories/account-repository.ts`:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Account, AccountStatus } from "../../../domain/account.js";
import type { AccountRepository } from "../../../domain/ports/repositories.js";
import type { AuthSession } from "../../../domain/vodafone-session.js";
import type { Cipher } from "../../crypto/cipher.js";
import type { Database } from "../database.js";
import { account } from "../schema.js";

const authSessionSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().int(),
  storageState: z.string(),
});

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * The only place account ciphertext is decrypted. A session blob that fails
 * to decrypt or parse yields session=null — the sync then performs a full
 * login instead of crashing over a recoverable artifact.
 */
export class DrizzleAccountRepository implements AccountRepository {
  readonly #db: Database;
  readonly #cipher: Cipher;

  constructor(db: Database, cipher: Cipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  async findById(id: number): Promise<Account | undefined> {
    const row = this.#db.select().from(account).where(eq(account.id, id)).get();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      label: row.label,
      credentials: {
        username: this.#cipher.decrypt(row.usernameEnc),
        password: this.#cipher.decrypt(row.passwordEnc),
      },
      customerUrn: row.customerUrn,
      enabled: row.enabled,
      backfillFrom: row.backfillFrom,
      status: row.status,
      session: this.decodeSession(row.sessionStateEnc),
    };
  }

  async saveSession(id: number, session: AuthSession): Promise<void> {
    this.#db
      .update(account)
      .set({
        sessionStateEnc: this.#cipher.encrypt(JSON.stringify(session)),
        sessionRefreshedAt: nowSeconds(),
        updatedAt: nowSeconds(),
      })
      .where(eq(account.id, id))
      .run();
  }

  async setStatus(id: number, status: AccountStatus, detail?: string): Promise<void> {
    this.#db
      .update(account)
      .set({ status, statusDetail: detail ?? null, updatedAt: nowSeconds() })
      .where(eq(account.id, id))
      .run();
  }

  private decodeSession(blob: Buffer | null): AuthSession | null {
    if (blob === null) return null;
    try {
      const parsed: unknown = JSON.parse(this.#cipher.decrypt(blob));
      const result = authSessionSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/account-repository.test.ts`
Erwartet: PASS — 6 Tests.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/repositories/account-repository.ts src/infrastructure/persistence/repositories/account-repository.test.ts
git commit -F - <<'EOF'
feat: AccountRepository mit Entschlüsselung

Einzige Stelle, an der Konto-Ciphertext entschlüsselt wird. Ein kaputter
Session-Blob ergibt session=null und damit einen Full Login statt eines
Absturzes; saveSession verschlüsselt und stempelt session_refreshed_at.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 7: InvoiceRepository

**Files:**
- Create: `src/infrastructure/persistence/repositories/invoice-repository.ts`
- Test: `src/infrastructure/persistence/repositories/invoice-repository.test.ts`

**Interfaces:**
- Consumes: `InvoiceRepository` (Port), `RetryableDocument`, `Invoice` (Domäne), `StoredFile`, `Database`, Tabellen `account`/`invoice`/`invoiceDocument`, `PersistenceError`
- Produces: `class DrizzleInvoiceRepository implements InvoiceRepository` mit `constructor(db: Database)`

- [ ] **Step 1: Failing test schreiben**

Datei `src/infrastructure/persistence/repositories/invoice-repository.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Invoice } from "../../../domain/invoice.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoiceDocument } from "../schema.js";
import { DrizzleInvoiceRepository } from "./invoice-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleInvoiceRepository;
let accountId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleInvoiceRepository(db);
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  accountId = row.id;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

const sample: Invoice = {
  number: "123456789012",
  issuedOn: "2026-03-01",
  dueOn: "2026-03-15",
  amountCents: 4599,
  currency: "EUR",
  subject: "notSpecified",
  contractNumber: "9876",
  documents: [
    { documentId: "doc-1", category: "invoice", subType: "Rechnung" },
    { documentId: "doc-2", category: "record", subType: "EVN" },
  ],
};

describe("DrizzleInvoiceRepository", () => {
  it("starts with an empty dedup set", async () => {
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set());
  });

  it("inserts an invoice with its documents as pending", async () => {
    await repo.insertInvoice(accountId, sample);
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set(["123456789012"]));
    const docs = await repo.listRetryableDocuments(accountId);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.remoteDocumentId).sort()).toEqual(["doc-1", "doc-2"]);
    const first = docs[0];
    expect(first?.invoiceNumber).toBe("123456789012");
    expect(first?.issuedOn).toBe("2026-03-01");
    expect(first?.contractNumber).toBe("9876");
  });

  it("marks a document stored and drops it from the retryable list", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markStored(
      target.id,
      { relativePath: "a/r.pdf", sha256: "abc", sizeBytes: 21 },
      1700000000,
    );
    const remaining = await repo.listRetryableDocuments(accountId);
    expect(remaining).toHaveLength(1);
    const row = db
      .select()
      .from(invoiceDocument)
      .where(eq(invoiceDocument.id, target.id))
      .get();
    expect(row?.state).toBe("stored");
    expect(row?.relativePath).toBe("a/r.pdf");
    expect(row?.sha256).toBe("abc");
    expect(row?.sizeBytes).toBe(21);
    expect(row?.storedAt).toBe(1700000000);
    expect(row?.lastError).toBeNull();
  });

  it("keeps a failed document in the retryable list with its error", async () => {
    await repo.insertInvoice(accountId, sample);
    const docs = await repo.listRetryableDocuments(accountId);
    const target = docs[0];
    if (target === undefined) throw new Error("no document");
    await repo.markFailed(target.id, "no PDF magic bytes");
    const retryable = await repo.listRetryableDocuments(accountId);
    expect(retryable.map((d) => d.id)).toContain(target.id);
    const row = db
      .select()
      .from(invoiceDocument)
      .where(eq(invoiceDocument.id, target.id))
      .get();
    expect(row?.state).toBe("failed");
    expect(row?.lastError).toBe("no PDF magic bytes");
  });

  it("rolls back the invoice when a document insert fails", async () => {
    const broken: Invoice = {
      ...sample,
      documents: [
        { documentId: "dup", category: null, subType: null },
        { documentId: "dup", category: null, subType: null },
      ],
    };
    await expect(repo.insertInvoice(accountId, broken)).rejects.toThrow();
    await expect(repo.existingNumbers(accountId)).resolves.toEqual(new Set());
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Erwartet: FAIL — `Failed to resolve import "./invoice-repository.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/infrastructure/persistence/repositories/invoice-repository.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type { Invoice } from "../../../domain/invoice.js";
import type { InvoiceRepository, RetryableDocument } from "../../../domain/ports/repositories.js";
import type { StoredFile } from "../../../domain/ports/file-storage.js";
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
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/infrastructure/persistence/repositories/invoice-repository.test.ts`
Erwartet: PASS — 5 Tests. Der Rollback-Test funktioniert, weil `UNIQUE(invoice_id, remote_document_id)` den zweiten `dup`-Insert ablehnt und `db.transaction` dann die gesamte Transaktion zurückrollt.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/repositories/invoice-repository.ts src/infrastructure/persistence/repositories/invoice-repository.test.ts
git commit -F - <<'EOF'
feat: InvoiceRepository mit Dedup und Dokument-Zuständen

existingNumbers liefert das Dedup-Set je Konto; insertInvoice legt Rechnung
und Dokumente (pending) transaktional an; nur stored ist endgültig — pending
und failed erscheinen in listRetryableDocuments, bis ein Lauf sie speichert.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Sync-Use-Case

**Files:**
- Create: `src/application/sync-invoices.ts`
- Test: `src/application/sync-invoices.test.ts`

**Interfaces:**
- Consumes: alle Ports aus Task 1, `VodafoneProvider`, die Fehlerklassen, `renderFilename`/`validatePdf` nur als Typen (`FilenameRenderer`, `PdfValidator`)
- Produces:
  - `interface DocumentFailure { remoteDocumentId: string; message: string }`
  - `interface SyncReport { outcome: "success" | "partial" | "failed"; invoicesSeen: number; invoicesNew: number; documentsStored: number; failures: DocumentFailure[]; errorMessage: string | null }`
  - `interface SyncDeps { provider: VodafoneProvider; accounts: AccountRepository; invoices: InvoiceRepository; settings: SettingsRepository; storage: FileStorage; renderFilename: FilenameRenderer; validatePdf: PdfValidator; now?: () => number }`
  - `function syncAccount(deps: SyncDeps, accountId: number): Promise<SyncReport>`

- [ ] **Step 1: Failing test schreiben**

Datei `src/application/sync-invoices.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Account } from "../domain/account.js";
import {
  AuthenticationFailedError,
  DocumentValidationError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../domain/errors.js";
import type { Invoice } from "../domain/invoice.js";
import type { RetryableDocument } from "../domain/ports/repositories.js";
import type { AuthSession } from "../domain/vodafone-session.js";
import { type SyncDeps, syncAccount } from "./sync-invoices.js";

const session: AuthSession = { accessToken: "tok", expiresAt: 9_999_999_999, storageState: "{}" };

const baseAccount: Account = {
  id: 1,
  label: "Privat",
  credentials: { username: "u", password: "p" },
  customerUrn: "urn:vf-de:cable:can:0000000001",
  enabled: true,
  backfillFrom: null,
  status: "ok",
  session,
};

const invoiceOf = (number: string, issuedOn: string): Invoice => ({
  number,
  issuedOn,
  dueOn: null,
  amountCents: 4599,
  currency: "EUR",
  subject: null,
  contractNumber: null,
  documents: [{ documentId: `${number}-doc`, category: null, subType: "Rechnung" }],
});

const retryableOf = (id: number, remoteDocumentId: string): RetryableDocument => ({
  id,
  remoteDocumentId,
  subType: "Rechnung",
  invoiceNumber: "123456789012",
  issuedOn: "2026-03-01",
  contractNumber: null,
});

const pdfBytes = Buffer.from(`%PDF-1.4\n${"x".repeat(200)}`);

function makeDeps(overrides?: {
  account?: Account | undefined;
  invoices?: Invoice[];
  retryable?: RetryableDocument[];
  known?: Set<string>;
}): SyncDeps & {
  accounts: {
    findById: ReturnType<typeof vi.fn>;
    saveSession: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
  invoices: {
    existingNumbers: ReturnType<typeof vi.fn>;
    insertInvoice: ReturnType<typeof vi.fn>;
    listRetryableDocuments: ReturnType<typeof vi.fn>;
    markStored: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  provider: {
    getSession: ReturnType<typeof vi.fn>;
    discoverAssets: ReturnType<typeof vi.fn>;
    listInvoices: ReturnType<typeof vi.fn>;
    fetchDocument: ReturnType<typeof vi.fn>;
  };
  storage: { store: ReturnType<typeof vi.fn> };
} {
  const account = overrides && "account" in overrides ? overrides.account : baseAccount;
  return {
    provider: {
      getSession: vi.fn(async () => session),
      discoverAssets: vi.fn(async () => []),
      listInvoices: vi.fn(async () => overrides?.invoices ?? []),
      fetchDocument: vi.fn(async () => ({ mime: "application/pdf", bytes: pdfBytes })),
    },
    accounts: {
      findById: vi.fn(async () => account),
      saveSession: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => undefined),
    },
    invoices: {
      existingNumbers: vi.fn(async () => overrides?.known ?? new Set<string>()),
      insertInvoice: vi.fn(async () => undefined),
      listRetryableDocuments: vi.fn(async () => overrides?.retryable ?? []),
      markStored: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
    },
    settings: { filenameTemplate: vi.fn(async () => "{invoice_number}.pdf") },
    storage: {
      store: vi.fn(async (relativePath: string, bytes: Buffer) => ({
        relativePath,
        sha256: "hash",
        sizeBytes: bytes.length,
      })),
    },
    renderFilename: (_template, context) => `${context.invoiceNumber}.pdf`,
    validatePdf: () => undefined,
    now: () => 1_700_000_000,
  };
}

describe("syncAccount guards", () => {
  it("fails without touching the portal when the account does not exist", async () => {
    const deps = makeDeps({ account: undefined });
    const report = await syncAccount(deps, 42);
    expect(report.outcome).toBe("failed");
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });

  it("fails without portal contact when the account is disabled", async () => {
    const deps = makeDeps({ account: { ...baseAccount, enabled: false } });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(report.errorMessage).toMatch(/disabled/);
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });

  it("fails without portal contact when the account needs action", async () => {
    const deps = makeDeps({ account: { ...baseAccount, status: "needs_action" } });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });
});

describe("syncAccount discovery", () => {
  it("persists a renewed session", async () => {
    const renewed: AuthSession = { ...session, accessToken: "new" };
    const deps = makeDeps();
    deps.provider.getSession.mockResolvedValue(renewed);
    await syncAccount(deps, 1);
    expect(deps.accounts.saveSession).toHaveBeenCalledWith(1, renewed);
  });

  it("does not re-persist an unchanged session", async () => {
    const deps = makeDeps();
    deps.provider.getSession.mockResolvedValue(session);
    await syncAccount(deps, 1);
    expect(deps.accounts.saveSession).not.toHaveBeenCalled();
  });

  it("skips known invoices and counts only new ones", async () => {
    const deps = makeDeps({
      invoices: [invoiceOf("111111111111", "2026-01-01"), invoiceOf("222222222222", "2026-02-01")],
      known: new Set(["111111111111"]),
    });
    const report = await syncAccount(deps, 1);
    expect(report.invoicesSeen).toBe(2);
    expect(report.invoicesNew).toBe(1);
    expect(deps.invoices.insertInvoice).toHaveBeenCalledTimes(1);
  });

  it("skips invoices issued before backfillFrom", async () => {
    const deps = makeDeps({
      account: { ...baseAccount, backfillFrom: "2026-02-01" },
      invoices: [invoiceOf("111111111111", "2026-01-31"), invoiceOf("222222222222", "2026-02-01")],
    });
    const report = await syncAccount(deps, 1);
    expect(report.invoicesNew).toBe(1);
  });
});

describe("syncAccount document download", () => {
  it("stores retryable documents and reports success", async () => {
    const deps = makeDeps({ retryable: [retryableOf(10, "doc-1")] });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("success");
    expect(report.documentsStored).toBe(1);
    expect(deps.invoices.markStored).toHaveBeenCalledWith(
      10,
      { relativePath: "123456789012.pdf", sha256: "hash", sizeBytes: pdfBytes.length },
      1_700_000_000,
    );
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "ok");
  });

  it("marks a document failed and continues, reporting partial", async () => {
    // SyncDeps fields are readonly — build a variant instead of mutating.
    const base = makeDeps({ retryable: [retryableOf(10, "doc-1"), retryableOf(11, "doc-2")] });
    let call = 0;
    const deps = {
      ...base,
      validatePdf: (): void => {
        call += 1;
        if (call === 1) throw new DocumentValidationError("not a PDF");
      },
    };
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("partial");
    expect(report.documentsStored).toBe(1);
    expect(report.failures).toEqual([{ remoteDocumentId: "doc-1", message: "not a PDF" }]);
    expect(base.invoices.markFailed).toHaveBeenCalledWith(10, "not a PDF");
  });

  it("aborts the run when the session dies mid-download", async () => {
    const deps = makeDeps({ retryable: [retryableOf(10, "doc-1"), retryableOf(11, "doc-2")] });
    deps.provider.fetchDocument.mockRejectedValue(new SessionExpiredError("gone"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.invoices.markFailed).not.toHaveBeenCalled();
  });
});

describe("syncAccount error mapping", () => {
  it("sets needs_action on AuthenticationFailedError and never retries", async () => {
    const deps = makeDeps();
    deps.provider.getSession.mockRejectedValue(new AuthenticationFailedError("rejected"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "needs_action", "rejected");
    expect(deps.provider.getSession).toHaveBeenCalledTimes(1);
  });

  it("sets error on PortalContractError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new PortalContractError("changed"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "error", "changed");
  });

  it("keeps the status on TransientNetworkError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new TransientNetworkError("offline"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("keeps the status on RateLimitedError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new RateLimitedError("429"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors — bugs must be loud", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new TypeError("bug"));
    await expect(syncAccount(deps, 1)).rejects.toBeInstanceOf(TypeError);
  });
});
```

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/application/sync-invoices.test.ts`
Erwartet: FAIL — `Failed to resolve import "./sync-invoices.js"`.

- [ ] **Step 3: Implementieren**

Datei `src/application/sync-invoices.ts`:

```ts
import {
  AuthenticationFailedError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../domain/errors.js";
import type {
  FileStorage,
  FilenameRenderer,
  PdfValidator,
} from "../domain/ports/file-storage.js";
import type {
  AccountRepository,
  InvoiceRepository,
  SettingsRepository,
} from "../domain/ports/repositories.js";
import type { VodafoneProvider } from "../domain/ports/vodafone-provider.js";

export interface DocumentFailure {
  readonly remoteDocumentId: string;
  readonly message: string;
}

export interface SyncReport {
  readonly outcome: "success" | "partial" | "failed";
  readonly invoicesSeen: number;
  readonly invoicesNew: number;
  readonly documentsStored: number;
  readonly failures: DocumentFailure[];
  readonly errorMessage: string | null;
}

export interface SyncDeps {
  readonly provider: VodafoneProvider;
  readonly accounts: AccountRepository;
  readonly invoices: InvoiceRepository;
  readonly settings: SettingsRepository;
  readonly storage: FileStorage;
  readonly renderFilename: FilenameRenderer;
  readonly validatePdf: PdfValidator;
  readonly now?: () => number;
}

/**
 * One sync for one account: discover new invoices, then store every document
 * still in pending or failed (only `stored` is final). Returns a report; run
 * persistence is milestone 4's job. Error policy (spec section 3): auth
 * failures park the account as needs_action and are NEVER retried; a changed
 * portal parks it as error; network faults leave the status alone. Unexpected
 * errors are rethrown — a bug must not masquerade as a failed run.
 */
export async function syncAccount(deps: SyncDeps, accountId: number): Promise<SyncReport> {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  let invoicesSeen = 0;
  let invoicesNew = 0;
  let documentsStored = 0;
  const failures: DocumentFailure[] = [];

  const failed = (errorMessage: string): SyncReport => ({
    outcome: "failed",
    invoicesSeen,
    invoicesNew,
    documentsStored,
    failures,
    errorMessage,
  });

  const account = await deps.accounts.findById(accountId);
  if (account === undefined) return failed(`Account ${accountId} does not exist`);
  if (!account.enabled) return failed(`Account "${account.label}" is disabled`);
  if (account.status === "needs_action") {
    return failed(
      `Account "${account.label}" needs action; skipping to protect the portal account`,
    );
  }

  try {
    const session = await deps.provider.getSession(
      account.credentials,
      account.session ?? undefined,
    );
    // The facade returns the identical object when the existing session is
    // still valid — only a genuinely new session is worth re-encrypting.
    if (session !== account.session) {
      await deps.accounts.saveSession(accountId, session);
    }

    const invoices = await deps.provider.listInvoices(session, account.customerUrn);
    invoicesSeen = invoices.length;
    const known = await deps.invoices.existingNumbers(accountId);
    for (const entry of invoices) {
      if (known.has(entry.number)) continue;
      if (account.backfillFrom !== null && entry.issuedOn < account.backfillFrom) continue;
      await deps.invoices.insertInvoice(accountId, entry);
      invoicesNew += 1;
    }

    const template = await deps.settings.filenameTemplate();
    const retryable = await deps.invoices.listRetryableDocuments(accountId);
    for (const doc of retryable) {
      try {
        const payload = await deps.provider.fetchDocument(
          session,
          account.customerUrn,
          doc.remoteDocumentId,
        );
        deps.validatePdf(payload.bytes);
        const relativePath = deps.renderFilename(template, {
          accountLabel: account.label,
          invoiceNumber: doc.invoiceNumber,
          issuedOn: doc.issuedOn,
          subType: doc.subType,
          contractNumber: doc.contractNumber,
        });
        const stored = await deps.storage.store(relativePath, payload.bytes);
        await deps.invoices.markStored(doc.id, stored, now());
        documentsStored += 1;
      } catch (error) {
        // A dead session or a rate limit dooms every remaining download —
        // abort the run. Anything else is local to this one document.
        if (error instanceof SessionExpiredError || error instanceof RateLimitedError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ remoteDocumentId: doc.remoteDocumentId, message });
        await deps.invoices.markFailed(doc.id, message);
      }
    }

    await deps.accounts.setStatus(accountId, "ok");
    return {
      outcome: failures.length === 0 ? "success" : "partial",
      invoicesSeen,
      invoicesNew,
      documentsStored,
      failures,
      errorMessage: null,
    };
  } catch (error) {
    if (error instanceof AuthenticationFailedError) {
      await deps.accounts.setStatus(accountId, "needs_action", error.message);
      return failed(error.message);
    }
    if (error instanceof PortalContractError) {
      await deps.accounts.setStatus(accountId, "error", error.message);
      return failed(error.message);
    }
    if (
      error instanceof SessionExpiredError ||
      error instanceof TransientNetworkError ||
      error instanceof RateLimitedError
    ) {
      return failed(error.message);
    }
    throw error;
  }
}
```

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/application/sync-invoices.test.ts`
Erwartet: PASS — 16 Tests.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Erwartet: sauber; bei reinen Formatfehlern `npx biome check --write src/application/`.

- [ ] **Step 6: Commit**

```bash
git add src/application/sync-invoices.ts src/application/sync-invoices.test.ts
git commit -F - <<'EOF'
feat: Sync-Use-Case mit Report

syncAccount orchestriert nur Ports: Session-Kaskade mit Rückspeicherung,
Dedup über bekannte Rechnungsnummern, Backfill-Filter, Nachholen aller
pending/failed-Dokumente. Fehlerpolitik nach Spec: Auth nie wiederholen
(needs_action), Portal-Änderung parkt als error, Netzfehler lassen den
Status unangetastet, unbekannte Fehler fliegen laut weiter.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Composition Root

**Files:**
- Modify: `src/composition-root.ts`
- Test: `src/composition-root.test.ts` (erweitern)

**Interfaces:**
- Consumes: alles aus Tasks 1–8, `VodafoneAuthenticator`, `VodafoneApiClient`, `VodafoneProviderFacade`
- Produces: `Application.sync: (accountId: number) => Promise<SyncReport>`

- [ ] **Step 1: Failing test ergänzen**

An das bestehende `describe` in `src/composition-root.test.ts` (dort, wo bereits gegen eine erzeugte Application geprüft wird) einen Test anhängen — die vorhandenen Setup-Helfer der Datei wiederverwenden:

```ts
  it("exposes a sync function", async () => {
    expect(typeof application.sync).toBe("function");
  });
```

(`application` ist die in der Testdatei bereits erzeugte Instanz; Namen an den lokalen Bestand anpassen. Kein echter Sync-Aufruf — der würde einen Browser starten.)

- [ ] **Step 2: Test ausführen, Fehlschlag prüfen**

Run: `npx vitest run src/composition-root.test.ts`
Erwartet: FAIL — `sync` existiert nicht am `Application`-Objekt.

- [ ] **Step 3: Composition Root erweitern**

In `src/composition-root.ts`:

Imports ergänzen:

```ts
import { syncAccount, type SyncReport } from "./application/sync-invoices.js";
import { DrizzleAccountRepository } from "./infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "./infrastructure/persistence/repositories/invoice-repository.js";
import { DrizzleSettingsRepository } from "./infrastructure/persistence/repositories/settings-repository.js";
import { AtomicFileStorage } from "./infrastructure/storage/atomic-file-storage.js";
import { renderFilename } from "./infrastructure/storage/filename-template.js";
import { validatePdf } from "./infrastructure/storage/pdf.js";
import { VodafoneApiClient } from "./infrastructure/vodafone/api-client.js";
import { VodafoneAuthenticator } from "./infrastructure/vodafone/authenticator.js";
import { VodafoneProviderFacade } from "./infrastructure/vodafone/provider.js";
```

Das `Application`-Interface erweitern:

```ts
  readonly sync: (accountId: number) => Promise<SyncReport>;
```

In `createApplication` nach dem Erzeugen von `db` (vor `buildServer`) verdrahten:

```ts
  const accounts = new DrizzleAccountRepository(db, cipher);
  const invoices = new DrizzleInvoiceRepository(db);
  const settings = new DrizzleSettingsRepository(db);
  const storage = new AtomicFileStorage(config.downloadsDir);

  // Portal endpoints (design spec section 3). Silent renewal is confirmed
  // supported by the milestone 2 smoke experiment.
  const authenticator = new VodafoneAuthenticator({
    loginUrl: "https://www.vodafone.de/meinvodafone/account/",
    tokenUrl: "https://www.vodafone.de/mint/oidc/token",
    authorizeUrl:
      "https://www.vodafone.de/mint/oidc/authorize?prompt=none&response_type=code&scope=openid",
    artifactsDir: join(config.configDir, "artifacts"),
    silentRenewalSupported: true,
    logger,
    headless: true,
  });
  const apiClient = new VodafoneApiClient({
    baseUrl: "https://api.vodafone.de/meinvodafone/v2",
  });
  const provider = new VodafoneProviderFacade({
    authenticator,
    apiClient,
    silentRenewalSupported: true,
  });

  const sync = (accountId: number): Promise<SyncReport> =>
    syncAccount(
      { provider, accounts, invoices, settings, storage, renderFilename, validatePdf },
      accountId,
    );
```

und `sync` in das zurückgegebene Objekt aufnehmen (`return { app, config, logger, cipher, db, sync, shutdown }`).

- [ ] **Step 4: Test ausführen, Erfolg prüfen**

Run: `npx vitest run src/composition-root.test.ts`
Erwartet: PASS — kein Browser startet (der Authenticator wird nur konstruiert, nie aufgerufen).

- [ ] **Step 5: Gesamte Suite, Lint, Typecheck**

Run: `npm run lint && npm run typecheck && npm test`
Erwartet: alles grün.

- [ ] **Step 6: Commit**

```bash
git add src/composition-root.ts src/composition-root.test.ts
git commit -F - <<'EOF'
feat: Sync im Composition Root verdrahtet

Repositories, Storage, Authenticator, ApiClient und Fassade werden an einer
Stelle zusammengesteckt; die Application exponiert sync(accountId) als
gebundene Funktion für Meilenstein 4. Portal-Endpunkte stehen als Konstanten
in der Verdrahtung, Silent Renewal ist laut M2-Experiment aktiv.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
```

---

## Definition of Done für Meilenstein 3

- [ ] `syncAccount` deckt Dedup, Backfill, pending/failed-Nachholen und alle Fehlerklassen mit Tests ab
- [ ] Template-Rendering weist Traversal, Pfadtrenner und SMB-verbotene Zeichen nach (Tests)
- [ ] `AtomicFileStorage`: Atomarität, Kollisions-Suffix, Root-Escape-Abwehr getestet
- [ ] Repositories gegen echte SQLite mit Migrationen getestet; Ciphertext-Roundtrip belegt
- [ ] `npm run lint`, `npm run typecheck`, `npm test` grün; kein Browser in der Testsuite
- [ ] Kein `any`, keine TODOs, keine Secrets in Tests

## Was dieser Meilenstein bewusst nicht enthält

- Schreiben der run-Tabelle, Scheduler, manueller Trigger (M4)
- UI inkl. Settings-Bearbeitung und Konto-Anlage (M5)
- Artefakt-Aufräumung nach 14 Tagen (M4)
- Re-Sync bekannter Rechnungen (Felder werden nicht nachgezogen)
