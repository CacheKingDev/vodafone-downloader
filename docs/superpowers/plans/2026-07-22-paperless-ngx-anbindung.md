# Paperless-ngx-Anbindung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rechnungen zusätzlich (nicht ersetzend) an eine Paperless-ngx-Instanz weiterreichen — als neuer, nie als Standard wählbarer Backend-Typ in der bestehenden Speicherziel-Verwaltung.

**Architecture:** Paperless wird ein neuer `StorageBackendKind` mit eigenem `PaperlessConfig`. Ein schlanker `PaperlessClient` (natives `fetch`) übernimmt den Upload mit Titel + echtem Rechnungsdatum. Ein neuer, von `sync-invoices.ts` komplett entkoppelter Use Case `exportToPaperless` läuft nach jedem `RunCoordinator`-Zyklus, liest Kandidaten aus einer neuen `invoice_document_export`-Tabelle (Idempotenz/Retry) und lädt sie über alle aktivierten Paperless-Ziele hoch. `PaperlessFileStorage implements FileStorage` existiert nur, damit der bestehende generische Verbindungstest-Button funktioniert — der echte Upload läuft nicht über diesen Port, da er keine reichhaltigen Metadaten (Titel/Datum) transportiert.

**Tech Stack:** TypeScript (Node ≥24), Fastify, Drizzle ORM/SQLite, Vitest, natives `fetch`/`FormData`/`Blob`, `undici` (nur für `Agent`, TLS-Bypass bei selbstsignierten Zertifikaten).

## Global Constraints

- Alle UI-Texte, Fehlermeldungen und Kommentare auf Deutsch, im bestehenden knappen Ton (siehe vorhandene Backends).
- Keine Kommentare, die nur wiederholen, was der Code schon sagt — nur für nicht offensichtliche Gründe/Constraints.
- `npm run typecheck`, `npm run lint`, `npm test` müssen nach jedem Task grün sein, bevor committet wird.
- Datenbankmigrationen ausschließlich über `npm run db:generate` (Drizzle-Kit) erzeugen, niemals von Hand ins `drizzle/`-Verzeichnis schreiben.
- Commits klein und pro Task, Commit-Messages im bestehenden Stil (`feat:`/`fix:`/`test:`/`docs:` Präfix, Deutsch).
- Spec: `docs/superpowers/specs/2026-07-22-paperless-ngx-anbindung-design.md` — bei Unklarheiten dort nachschlagen, nicht neu entscheiden.

---

## Task 1: Datenbankschema — `paperless`-Backend-Enum + `invoice_document_export`-Tabelle

**Files:**
- Modify: `src/infrastructure/persistence/schema.ts:89-149`
- Create (generiert): `drizzle/000X_<name>.sql` (Name wird von Drizzle-Kit vergeben)

**Interfaces:**
- Produces: `invoiceDocumentExport` Drizzle-Tabelle, `InvoiceDocumentExportRow`/`NewInvoiceDocumentExportRow`-Typen, `storageTarget.backend`-Enum erweitert um `"paperless"`.

- [ ] **Step 1: `backend`-Enum in `storageTarget` erweitern**

In `src/infrastructure/persistence/schema.ts` Zeile 94-96 ändern:

```ts
    backend: text("backend", {
      enum: ["local", "smb", "ftp", "sftp", "webdav", "paperless"],
    }).notNull(),
```

- [ ] **Step 2: Neue Tabelle `invoice_document_export` anlegen**

Direkt nach dem `storageMigration`-Block (nach Zeile 149, vor `adminSession`) einfügen:

```ts
export const invoiceDocumentExport = sqliteTable(
  "invoice_document_export",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .notNull()
      .references(() => invoiceDocument.id, { onDelete: "cascade" }),
    storageTargetId: integer("storage_target_id")
      .notNull()
      .references(() => storageTarget.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["uploaded", "failed"] }).notNull(),
    errorMessage: text("error_message"),
    attemptedAt: integer("attempted_at").notNull(),
  },
  (table) => [
    uniqueIndex("invoice_document_export_unique").on(table.documentId, table.storageTargetId),
  ],
);
```

- [ ] **Step 3: Row-Typen exportieren**

Am Ende von `schema.ts` (nach `export type StorageTargetRow = ...` / `NewStorageTargetRow`) ergänzen:

```ts
export type InvoiceDocumentExportRow = typeof invoiceDocumentExport.$inferSelect;
export type NewInvoiceDocumentExportRow = typeof invoiceDocumentExport.$inferInsert;
```

- [ ] **Step 4: Migration generieren**

Run: `npm run db:generate`

Erwartete Ausgabe: Drizzle-Kit meldet eine neue Migrationsdatei unter `./drizzle` (z. B. `0003_<adjektiv>_<name>.sql`). Da `storage_target.backend` ein CHECK-Constraint-Enum ist, rekonstruiert SQLite die Tabelle (Muster wie in `drizzle/0002_brief_terrax.sql`: `CREATE TABLE __new_storage_target`, `INSERT INTO __new_storage_target SELECT ...`, `DROP TABLE`, `RENAME TO`) — das ist erwartetes Verhalten, keine manuelle Korrektur nötig. Prüfen, dass die generierte Datei sowohl die `storage_target`-Rekonstruktion als auch ein `CREATE TABLE invoice_document_export` enthält.

- [ ] **Step 5: Bestehende Tests laufen lassen, um die Migration zu verifizieren**

Run: `npx vitest run src/infrastructure/persistence/repositories/storage-target-repository.test.ts src/composition-root.test.ts`
Expected: PASS (diese Tests bauen die DB über `migrationsFolder: "./drizzle"` frisch auf und scheitern, wenn die generierte Migration fehlerhaft ist)

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/persistence/schema.ts drizzle/
git commit -m "$(cat <<'EOF'
feat: DB-Schema für Paperless-Backend und Export-Tracking

storage_target.backend akzeptiert jetzt "paperless"; neue Tabelle
invoice_document_export verfolgt pro Dokument und Speicherziel, ob ein
Export erfolgreich war (Grundlage für Idempotenz/Retry).
EOF
)"
```

---

## Task 2: Domain-Typen + Zod-Validierung für `PaperlessConfig`

**Files:**
- Modify: `src/domain/storage-config.ts`
- Modify: `src/infrastructure/storage/storage-config-schema.ts`
- Modify: `src/infrastructure/persistence/repositories/storage-target-repository.test.ts`

**Interfaces:**
- Consumes: Task 1's DB-Enum (`"paperless"` jetzt gültig).
- Produces: `PaperlessConfig` (`url: string`, `apiToken: string`, `rejectUnauthorized: boolean`, `deleteAfterUpload: boolean`), `StorageBackendKind` inkl. `"paperless"`, `StorageConfig`-Zweig `{ backend: "paperless"; paperless: PaperlessConfig }`, `describeStorageDestination` liefert für Paperless die Server-URL, `storageConfigSchema` validiert den neuen Zweig.

- [ ] **Step 1: Fehlschlagenden Test schreiben (Repository-Rundlauf)**

In `src/infrastructure/persistence/repositories/storage-target-repository.test.ts` nach der bestehenden `sftpConfig`-Konstante (Zeile 16-25) ergänzen:

```ts
const paperlessConfig: StorageConfig = {
  backend: "paperless",
  paperless: {
    url: "https://paperless.example.com",
    apiToken: "tok_abc123",
    rejectUnauthorized: true,
    deleteAfterUpload: true,
  },
};
```

Und im `describe("DrizzleStorageTargetRepository.create/findById", ...)`-Block (nach dem `it("stores a local target ...")`-Test, vor `it("does not store plaintext credentials", ...)`) einen neuen Test ergänzen:

```ts
  it("round-trips a paperless target's config", async () => {
    const id = await repo.create({
      name: "Paperless",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "untested",
    });
    const target = await repo.findById(id);
    expect(target?.config).toEqual(paperlessConfig);
    expect(target?.backend).toBe("paperless");
    expect(target?.destination).toBe("https://paperless.example.com");
  });
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/storage-target-repository.test.ts`
Expected: FAIL — TypeScript-Fehler, da `StorageConfig` noch keinen `"paperless"`-Zweig kennt (`Type '"paperless"' is not assignable to type ...`)

- [ ] **Step 3: `PaperlessConfig` und `StorageConfig`-Zweig ergänzen**

In `src/domain/storage-config.ts` Zeile 1 ändern:

```ts
export type StorageBackendKind = "local" | "smb" | "ftp" | "sftp" | "webdav" | "paperless";
```

Nach dem `WebDavConfig`-Interface (nach Zeile 65, vor `export type StorageConfig = ...`) einfügen:

```ts
export interface PaperlessConfig {
  readonly url: string;
  readonly apiToken: string;
  readonly rejectUnauthorized: boolean;
  readonly deleteAfterUpload: boolean;
}
```

`StorageConfig` (Zeile 67-72) um einen Zweig erweitern:

```ts
export type StorageConfig =
  | { readonly backend: "local" }
  | { readonly backend: "smb"; readonly smb: SmbConfig }
  | { readonly backend: "ftp"; readonly ftp: FtpConfig }
  | { readonly backend: "sftp"; readonly sftp: SftpConfig }
  | { readonly backend: "webdav"; readonly webdav: WebDavConfig }
  | { readonly backend: "paperless"; readonly paperless: PaperlessConfig };
```

`describeStorageDestination` (Zeile 79-92) um einen `case` erweitern:

```ts
    case "webdav":
      return joinNonEmpty([config.webdav.url, config.webdav.path]);
    case "paperless":
      return config.paperless.url;
  }
```

- [ ] **Step 4: Zod-Schema für `paperless` ergänzen**

In `src/infrastructure/storage/storage-config-schema.ts` nach `webdavSchema` (nach Zeile 62, vor `export const storageConfigSchema = ...`) einfügen:

```ts
const paperlessSchema = z.object({
  backend: z.literal("paperless"),
  paperless: z.object({
    url: z.url(),
    apiToken: z.string().min(1),
    rejectUnauthorized: z.boolean(),
    deleteAfterUpload: z.boolean(),
  }),
});
```

`storageConfigSchema` (Zeile 64-70) um den neuen Zweig erweitern:

```ts
export const storageConfigSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local") }),
  smbSchema,
  ftpSchema,
  sftpSchema,
  webdavSchema,
  paperlessSchema,
]) satisfies z.ZodType<StorageConfig>;
```

- [ ] **Step 5: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/storage-target-repository.test.ts`
Expected: PASS (alle Tests in der Datei, inklusive des neuen)

- [ ] **Step 6: Typecheck über das ganze Projekt**

Run: `npm run typecheck`
Expected: PASS — falls hier Fehler auftauchen (z. B. in `resolve-file-storage.ts`s `switch` über `StorageBackendKind`, der jetzt einen Fall nicht abdeckt), das ist erwartet und wird in Task 6/7 behoben; für diesen Task genügt es, dass **dieser** Bereich (Domain + Schema) sauber ist. Falls der Compiler an einer Stelle bricht, die in einem späteren Task behoben wird, das im Commit-Message-Body kurz vermerken.

- [ ] **Step 7: Commit**

```bash
git add src/domain/storage-config.ts src/infrastructure/storage/storage-config-schema.ts src/infrastructure/persistence/repositories/storage-target-repository.test.ts
git commit -m "$(cat <<'EOF'
feat: PaperlessConfig als neuer StorageConfig-Zweig

url/apiToken/rejectUnauthorized/deleteAfterUpload, validiert per Zod
und per Repository-Rundlauf-Test abgesichert.
EOF
)"
```

---

## Task 3: `DocumentExportRepository` — Port + Drizzle-Implementierung

**Files:**
- Modify: `src/domain/ports/repositories.ts`
- Create: `src/infrastructure/persistence/repositories/document-export-repository.ts`
- Create: `src/infrastructure/persistence/repositories/document-export-repository.test.ts`

**Interfaces:**
- Consumes: `invoiceDocumentExport`-Tabelle (Task 1), `invoiceDocument`/`invoice`/`account`-Tabellen (bestehend).
- Produces: `ExportCandidate` (`documentId: number`, `relativePath: string`, `accountLabel: string`, `invoiceNumber: string`, `issuedOn: string`), `DocumentExportRepository` (`listExportCandidates(storageTargetId): Promise<ExportCandidate[]>`, `recordSuccess(documentId, storageTargetId, attemptedAtSeconds): Promise<void>`, `recordFailure(documentId, storageTargetId, message, attemptedAtSeconds): Promise<void>`, `isFullyExported(documentId, storageTargetIds): Promise<boolean>`), `DrizzleDocumentExportRepository`.

- [ ] **Step 1: Port-Typen ergänzen**

In `src/domain/ports/repositories.ts` nach dem `MigrationRepository`-Interface (nach Zeile 195, vor dem `StorageTargetRepository`-Kommentar) einfügen:

```ts
/** One document queued for export to one Paperless-like target — state=stored, no successful export row yet. */
export interface ExportCandidate {
  readonly documentId: number;
  readonly relativePath: string;
  readonly accountLabel: string;
  readonly invoiceNumber: string;
  readonly issuedOn: string;
}

/**
 * Tracks per-(document, storage target) export outcomes for backends that
 * receive a one-way copy (Paperless-ngx). Absence of a row means "not yet
 * attempted" — there is no separate "pending" status.
 */
export interface DocumentExportRepository {
  /** invoice_document rows in state=stored without an 'uploaded' row for this target. */
  listExportCandidates(storageTargetId: number): Promise<ExportCandidate[]>;
  recordSuccess(documentId: number, storageTargetId: number, attemptedAtSeconds: number): Promise<void>;
  recordFailure(
    documentId: number,
    storageTargetId: number,
    message: string,
    attemptedAtSeconds: number,
  ): Promise<void>;
  /** True only if documentId has an 'uploaded' row for every id in storageTargetIds. */
  isFullyExported(documentId: number, storageTargetIds: readonly number[]): Promise<boolean>;
}
```

- [ ] **Step 2: Fehlschlagenden Test schreiben**

Create `src/infrastructure/persistence/repositories/document-export-repository.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoice, invoiceDocument, storageTarget } from "../schema.js";
import { DrizzleDocumentExportRepository } from "./document-export-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleDocumentExportRepository;
let documentId: number;
let targetId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-document-export-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleDocumentExportRepository(db);

  const [accountRow] = db
    .insert(account)
    .values({
      label: "Konto A",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:test:1",
    })
    .returning()
    .all();
  const [invoiceRow] = db
    .insert(invoice)
    .values({
      accountId: accountRow!.id,
      number: "R-1",
      issuedOn: "2026-06-01",
      amountCents: 1000,
    })
    .returning()
    .all();
  const [documentRow] = db
    .insert(invoiceDocument)
    .values({
      invoiceId: invoiceRow!.id,
      remoteDocumentId: "doc-1",
      state: "stored",
      relativePath: "2026/r-1.pdf",
      sha256: "abc",
      sizeBytes: 10,
      storedAt: 1,
    })
    .returning()
    .all();
  documentId = documentRow!.id;

  const [targetRow] = db
    .insert(storageTarget)
    .values({ name: "Paperless", backend: "paperless", purpose: "export", status: "connected" })
    .returning()
    .all();
  targetId = targetRow!.id;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleDocumentExportRepository", () => {
  it("lists a stored document without an export row as a candidate", async () => {
    const candidates = await repo.listExportCandidates(targetId);
    expect(candidates).toEqual([
      {
        documentId,
        relativePath: "2026/r-1.pdf",
        accountLabel: "Konto A",
        invoiceNumber: "R-1",
        issuedOn: "2026-06-01",
      },
    ]);
  });

  it("excludes a document after recordSuccess", async () => {
    await repo.recordSuccess(documentId, targetId, 100);
    expect(await repo.listExportCandidates(targetId)).toEqual([]);
  });

  it("keeps listing a document after recordFailure so it is retried", async () => {
    await repo.recordFailure(documentId, targetId, "boom", 100);
    expect(await repo.listExportCandidates(targetId)).toHaveLength(1);
  });

  it("upserts on repeated attempts for the same document/target", async () => {
    await repo.recordFailure(documentId, targetId, "boom", 100);
    await repo.recordSuccess(documentId, targetId, 200);
    expect(await repo.listExportCandidates(targetId)).toEqual([]);
  });

  it("isFullyExported requires an uploaded row for every given target", async () => {
    const [secondTarget] = db
      .insert(storageTarget)
      .values({ name: "Paperless 2", backend: "paperless", purpose: "export", status: "connected" })
      .returning()
      .all();
    await repo.recordSuccess(documentId, targetId, 100);
    expect(await repo.isFullyExported(documentId, [targetId, secondTarget!.id])).toBe(false);
    await repo.recordSuccess(documentId, secondTarget!.id, 100);
    expect(await repo.isFullyExported(documentId, [targetId, secondTarget!.id])).toBe(true);
  });
});
```

- [ ] **Step 3: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/document-export-repository.test.ts`
Expected: FAIL — Modul `./document-export-repository.js` existiert nicht

- [ ] **Step 4: `DrizzleDocumentExportRepository` implementieren**

Create `src/infrastructure/persistence/repositories/document-export-repository.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type {
  DocumentExportRepository,
  ExportCandidate,
} from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { account, invoice, invoiceDocument, invoiceDocumentExport } from "../schema.js";

/**
 * Filters candidates in JS rather than a SQL anti-join (mirrors the
 * Set-based dedup already used by DrizzleInvoiceRepository.existingNumbers) —
 * invoice volumes here are small enough that this stays simple and fast.
 */
export class DrizzleDocumentExportRepository implements DocumentExportRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async listExportCandidates(storageTargetId: number): Promise<ExportCandidate[]> {
    const uploaded = this.#db
      .select({ documentId: invoiceDocumentExport.documentId })
      .from(invoiceDocumentExport)
      .where(
        and(
          eq(invoiceDocumentExport.storageTargetId, storageTargetId),
          eq(invoiceDocumentExport.status, "uploaded"),
        ),
      )
      .all();
    const uploadedIds = new Set(uploaded.map((row) => row.documentId));

    const stored = this.#db
      .select({
        documentId: invoiceDocument.id,
        relativePath: invoiceDocument.relativePath,
        accountLabel: account.label,
        invoiceNumber: invoice.number,
        issuedOn: invoice.issuedOn,
      })
      .from(invoiceDocument)
      .innerJoin(invoice, eq(invoiceDocument.invoiceId, invoice.id))
      .innerJoin(account, eq(invoice.accountId, account.id))
      .where(eq(invoiceDocument.state, "stored"))
      .all();

    return stored
      .filter((row) => row.relativePath !== null && !uploadedIds.has(row.documentId))
      .map((row) => ({
        documentId: row.documentId,
        relativePath: row.relativePath as string,
        accountLabel: row.accountLabel,
        invoiceNumber: row.invoiceNumber,
        issuedOn: row.issuedOn,
      }));
  }

  async recordSuccess(
    documentId: number,
    storageTargetId: number,
    attemptedAtSeconds: number,
  ): Promise<void> {
    this.#upsert(documentId, storageTargetId, {
      status: "uploaded",
      errorMessage: null,
      attemptedAt: attemptedAtSeconds,
    });
  }

  async recordFailure(
    documentId: number,
    storageTargetId: number,
    message: string,
    attemptedAtSeconds: number,
  ): Promise<void> {
    this.#upsert(documentId, storageTargetId, {
      status: "failed",
      errorMessage: message,
      attemptedAt: attemptedAtSeconds,
    });
  }

  async isFullyExported(documentId: number, storageTargetIds: readonly number[]): Promise<boolean> {
    if (storageTargetIds.length === 0) return false;
    const rows = this.#db
      .select({ storageTargetId: invoiceDocumentExport.storageTargetId })
      .from(invoiceDocumentExport)
      .where(
        and(
          eq(invoiceDocumentExport.documentId, documentId),
          eq(invoiceDocumentExport.status, "uploaded"),
          inArray(invoiceDocumentExport.storageTargetId, [...storageTargetIds]),
        ),
      )
      .all();
    const uploadedTargetIds = new Set(rows.map((row) => row.storageTargetId));
    return storageTargetIds.every((id) => uploadedTargetIds.has(id));
  }

  #upsert(
    documentId: number,
    storageTargetId: number,
    values: { status: "uploaded" | "failed"; errorMessage: string | null; attemptedAt: number },
  ): void {
    this.#db
      .insert(invoiceDocumentExport)
      .values({ documentId, storageTargetId, ...values })
      .onConflictDoUpdate({
        target: [invoiceDocumentExport.documentId, invoiceDocumentExport.storageTargetId],
        set: values,
      })
      .run();
  }
}
```

- [ ] **Step 5: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/document-export-repository.test.ts`
Expected: PASS (alle 5 Tests)

- [ ] **Step 6: Commit**

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/document-export-repository.ts src/infrastructure/persistence/repositories/document-export-repository.test.ts
git commit -m "$(cat <<'EOF'
feat: DocumentExportRepository für Paperless-Export-Tracking

Kandidatenauswahl (stored ohne uploaded-Zeile), Upsert bei
Erfolg/Fehler, isFullyExported für die Lösch-Regel bei mehreren
Export-Zielen.
EOF
)"
```

---

## Task 4: `StorageTargetRepository.listEnabledPaperlessTargets`

**Files:**
- Modify: `src/domain/ports/repositories.ts:197-200`
- Modify: `src/infrastructure/persistence/repositories/storage-target-repository.ts`
- Modify: `src/infrastructure/persistence/repositories/storage-target-repository.test.ts`
- Modify (Fakes an neue Methode anpassen, sonst TS-Fehler): `src/application/migrate-storage.test.ts:79`, `src/application/create-storage-target.test.ts:16`, `src/application/delete-storage-target.test.ts:43`, `src/application/set-storage-target-enabled.test.ts:36`, `src/application/set-default-storage-target.test.ts:42`, `src/application/test-storage-target.test.ts:58`, `src/application/update-storage-target.test.ts:48`

**Interfaces:**
- Consumes: Task 2's `PaperlessConfig`/`StorageConfig`.
- Produces: `StorageTargetRepository.listEnabledPaperlessTargets(): Promise<StorageTarget[]>` (narrower Lesepfad, wie `findDefault`, für den Export-Use-Case in Task 9).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

In `src/infrastructure/persistence/repositories/storage-target-repository.test.ts` einen neuen `describe`-Block am Ende der Datei ergänzen:

```ts
describe("DrizzleStorageTargetRepository.listEnabledPaperlessTargets", () => {
  it("returns only enabled paperless targets, decrypted", async () => {
    const enabledId = await repo.create({
      name: "Paperless aktiv",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "connected",
    });
    const disabledId = await repo.create({
      name: "Paperless deaktiviert",
      purpose: "export",
      description: null,
      config: paperlessConfig,
      status: "connected",
    });
    await repo.setDisabled(disabledId, true);
    await repo.create({
      name: "Lokal",
      purpose: "document",
      description: null,
      config: { backend: "local" },
      status: "connected",
    });

    const targets = await repo.listEnabledPaperlessTargets();
    expect(targets.map((t) => t.id)).toEqual([enabledId]);
    expect(targets[0]?.config).toEqual(paperlessConfig);
  });
});
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/storage-target-repository.test.ts`
Expected: FAIL — `repo.listEnabledPaperlessTargets is not a function`

- [ ] **Step 3: Port-Interface erweitern**

In `src/domain/ports/repositories.ts` Zeile 197-200 ändern:

```ts
/** Narrow read path used by sync and downloads — resolving the active target's config. */
export interface StorageTargetRepository {
  findDefault(): Promise<StorageTarget | undefined>;
  /** Enabled (status != 'disabled') targets with backend='paperless', full config decrypted. */
  listEnabledPaperlessTargets(): Promise<StorageTarget[]>;
}
```

- [ ] **Step 4: Drizzle-Implementierung ergänzen**

In `src/infrastructure/persistence/repositories/storage-target-repository.ts` Zeile 1 den Import erweitern:

```ts
import { and, eq, ne } from "drizzle-orm";
```

Nach der `findDefault`-Methode (nach Zeile 48) einfügen:

```ts
  async listEnabledPaperlessTargets(): Promise<StorageTarget[]> {
    const rows = this.#db
      .select()
      .from(storageTarget)
      .where(and(eq(storageTarget.backend, "paperless"), ne(storageTarget.status, "disabled")))
      .all();
    return rows.map((row) => this.#toTarget(row));
  }
```

- [ ] **Step 5: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/persistence/repositories/storage-target-repository.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck laufen lassen, um die 7 betroffenen Fakes zu finden**

Run: `npm run typecheck`
Expected: FAIL in genau diesen 7 Dateien mit einer Meldung wie `Property 'listEnabledPaperlessTargets' is missing in type ...`:
`src/application/migrate-storage.test.ts`, `src/application/create-storage-target.test.ts`,
`src/application/delete-storage-target.test.ts`, `src/application/set-storage-target-enabled.test.ts`,
`src/application/set-default-storage-target.test.ts`, `src/application/test-storage-target.test.ts`,
`src/application/update-storage-target.test.ts`

- [ ] **Step 7: Alle 7 Fakes reparieren**

In jeder der 7 Dateien direkt nach der Zeile `setDisabled: vi.fn(async () => undefined),` folgende Zeile einfügen:

```ts
    listEnabledPaperlessTargets: vi.fn(async () => []),
```

Konkret (Zeilennummern vor dieser Änderung):
- `src/application/migrate-storage.test.ts:79`
- `src/application/create-storage-target.test.ts:16`
- `src/application/delete-storage-target.test.ts:43`
- `src/application/set-storage-target-enabled.test.ts:36`
- `src/application/set-default-storage-target.test.ts:42`
- `src/application/test-storage-target.test.ts:58`
- `src/application/update-storage-target.test.ts:48`

- [ ] **Step 8: Typecheck erneut laufen lassen**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Gesamten Testlauf durchführen**

Run: `npm test`
Expected: PASS (alle Suites)

- [ ] **Step 10: Commit**

```bash
git add src/domain/ports/repositories.ts src/infrastructure/persistence/repositories/storage-target-repository.ts src/infrastructure/persistence/repositories/storage-target-repository.test.ts src/application/migrate-storage.test.ts src/application/create-storage-target.test.ts src/application/delete-storage-target.test.ts src/application/set-storage-target-enabled.test.ts src/application/set-default-storage-target.test.ts src/application/test-storage-target.test.ts src/application/update-storage-target.test.ts
git commit -m "$(cat <<'EOF'
feat: listEnabledPaperlessTargets im StorageTargetRepository

Narrow-Read-Path analog zu findDefault, für den kommenden
Paperless-Export-Use-Case. Bestehende Fakes der sieben Anwendungstests
um die neue Interface-Methode ergänzt.
EOF
)"
```

---

## Task 5: `PaperlessClient` — schlanker HTTP-Client

**Files:**
- Create: `src/infrastructure/paperless/paperless-client.ts`
- Create: `src/infrastructure/paperless/paperless-client.test.ts`

**Interfaces:**
- Produces: `FetchLike`, `PaperlessUploadMeta` (`filename: string`, `title: string`, `createdOn?: string`), `PaperlessClientOptions` (`url`, `apiToken`, `rejectUnauthorized`, `fetchImpl?`), `PaperlessClient` mit `upload(bytes: Buffer, meta: PaperlessUploadMeta): Promise<void>` und `checkAuth(): Promise<void>`.

- [ ] **Step 1: `undici` als Abhängigkeit installieren**

Run: `npm install undici`
Expected: `package.json`/`package-lock.json` bekommen `undici` als neuen Eintrag unter `dependencies`. Begründung: Node ≥24s globales `fetch` unterstützt bei selbstsigniertem TLS (Paperless-Feld `rejectUnauthorized`) nur über die `dispatcher`-Option einen eigenen `Agent` — dafür wird `undici.Agent` gebraucht (analog dazu, wie `webdav-file-storage.ts` für denselben Zweck `node:https`' `Agent` nutzt).

- [ ] **Step 2: Fehlschlagenden Test schreiben**

Create `src/infrastructure/paperless/paperless-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { type FetchLike, PaperlessClient } from "./paperless-client.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clientWith(fetchImpl: FetchLike, rejectUnauthorized = true): PaperlessClient {
  return new PaperlessClient({
    url: "https://paperless.example.com",
    apiToken: "tok_abc123",
    rejectUnauthorized,
    fetchImpl,
  });
}

describe("PaperlessClient.checkAuth", () => {
  it("resolves when the API answers 200", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).checkAuth();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://paperless.example.com/api/");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Token tok_abc123");
  });

  it("throws when the API rejects the token", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(401));
    await expect(clientWith(fetchImpl).checkAuth()).rejects.toThrow(/401/);
  });
});

describe("PaperlessClient.upload", () => {
  it("posts a multipart form with document, title, and created date", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).upload(Buffer.from("%PDF-1.4"), {
      filename: "rechnung.pdf",
      title: "Konto A – Rechnung R-1",
      createdOn: "2026-06-01",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://paperless.example.com/api/documents/post_document/");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("title")).toBe("Konto A – Rechnung R-1");
    expect(form.get("created")).toBe("2026-06-01");
    const document = form.get("document") as File;
    expect(document.name).toBe("rechnung.pdf");
  });

  it("omits 'created' when no date is given", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(200));
    await clientWith(fetchImpl).upload(Buffer.from("%PDF-1.4"), {
      filename: "rechnung.pdf",
      title: "Rechnung",
    });
    const form = fetchImpl.mock.calls[0]![1]?.body as FormData;
    expect(form.get("created")).toBeNull();
  });

  it("throws with the response status on a non-ok upload", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse(400, { document: ["invalid"] }));
    await expect(
      clientWith(fetchImpl).upload(Buffer.from("x"), { filename: "a.pdf", title: "a" }),
    ).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 3: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/paperless/paperless-client.test.ts`
Expected: FAIL — Modul `./paperless-client.js` existiert nicht

- [ ] **Step 4: `PaperlessClient` implementieren**

Create `src/infrastructure/paperless/paperless-client.ts`:

```ts
import { Agent } from "undici";

/** A narrow, injectable fetch: avoids the extra static members on `typeof fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PaperlessClientOptions {
  readonly url: string;
  readonly apiToken: string;
  readonly rejectUnauthorized: boolean;
  readonly fetchImpl?: FetchLike;
}

export interface PaperlessUploadMeta {
  readonly filename: string;
  readonly title: string;
  /** ISO 'YYYY-MM-DD'; omitted lets Paperless guess the date itself. */
  readonly createdOn?: string;
}

/**
 * Thin wrapper around Paperless-ngx's REST API. Deliberately does not wait
 * for or report back the consumption task's outcome (spec section 8) — an
 * accepted HTTP status is treated as "handed off successfully".
 */
export class PaperlessClient {
  readonly #baseUrl: string;
  readonly #apiToken: string;
  readonly #fetch: FetchLike;
  readonly #dispatcher: Agent | undefined;

  constructor(options: PaperlessClientOptions) {
    this.#baseUrl = options.url.replace(/\/$/, "");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#dispatcher = options.rejectUnauthorized
      ? undefined
      : new Agent({ connect: { rejectUnauthorized: false } });
  }

  async checkAuth(): Promise<void> {
    const response = await this.#request("/api/");
    if (!response.ok) {
      throw new Error(`Anmeldung fehlgeschlagen (HTTP ${response.status}).`);
    }
  }

  async upload(bytes: Buffer, meta: PaperlessUploadMeta): Promise<void> {
    const form = new FormData();
    form.set("document", new Blob([bytes], { type: "application/pdf" }), meta.filename);
    form.set("title", meta.title);
    if (meta.createdOn !== undefined) form.set("created", meta.createdOn);

    const response = await this.#request("/api/documents/post_document/", {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Paperless-Upload fehlgeschlagen (HTTP ${response.status}): ${body}`);
    }
  }

  async #request(path: string, init?: RequestInit): Promise<Response> {
    return this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Token ${this.#apiToken}` },
      ...(this.#dispatcher === undefined ? {} : { dispatcher: this.#dispatcher }),
    });
  }
}
```

- [ ] **Step 5: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/paperless/paperless-client.test.ts`
Expected: PASS (alle 5 Tests)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/infrastructure/paperless/paperless-client.ts src/infrastructure/paperless/paperless-client.test.ts
git commit -m "$(cat <<'EOF'
feat: PaperlessClient für Dokument-Upload per REST-API

Token-Auth, optionaler TLS-Bypass für selbstsignierte Zertifikate
(undici.Agent), Titel + echtes Rechnungsdatum im Upload — kein
Warten auf das Ergebnis der asynchronen Paperless-Verarbeitung.
EOF
)"
```

---

## Task 6: `PaperlessFileStorage` — nur für den generischen Verbindungstest

**Files:**
- Create: `src/infrastructure/storage/paperless-file-storage.ts`
- Create: `src/infrastructure/storage/paperless-file-storage.test.ts`

**Interfaces:**
- Consumes: `PaperlessClient`/`FetchLike` (Task 5), `PaperlessConfig` (Task 2), `ConnectionProbes`/`runConnectionTestSteps` (bestehend, `src/infrastructure/storage/connection-test-runner.ts`).
- Produces: `PaperlessFileStorage implements FileStorage`.

- [ ] **Step 1: Fehlschlagenden Test schreiben**

Create `src/infrastructure/storage/paperless-file-storage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { PaperlessConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { PaperlessFileStorage } from "./paperless-file-storage.js";

const config: PaperlessConfig = {
  url: "https://paperless.example.com",
  apiToken: "tok_abc123",
  rejectUnauthorized: true,
  deleteAfterUpload: false,
};

function okProbes(): ConnectionProbes {
  return { hostReachable: vi.fn(async () => undefined), portReachable: vi.fn(async () => undefined) };
}

/** Both PaperlessClientLike methods are required — overrides patch just the one under test. */
function stubClient(overrides: {
  checkAuth?: () => Promise<void>;
  upload?: (bytes: Buffer, meta: { filename: string; title: string; createdOn?: string }) => Promise<void>;
}) {
  return {
    checkAuth: overrides.checkAuth ?? (async () => undefined),
    upload: overrides.upload ?? (async () => undefined),
  };
}

describe("PaperlessFileStorage.testConnection", () => {
  it("succeeds when host/port/auth all check out", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}), okProbes());
    const result = await storage.testConnection();
    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual(["host_reachable", "port_reachable", "authenticated"]);
  });

  it("reports a failed authentication step without throwing", async () => {
    const storage = new PaperlessFileStorage(
      config,
      () =>
        stubClient({
          checkAuth: async () => {
            throw new Error("HTTP 401");
          },
        }),
      okProbes(),
    );
    const result = await storage.testConnection();
    expect(result.success).toBe(false);
    expect(result.steps.find((s) => s.id === "authenticated")?.status).toBe("failed");
  });
});

describe("PaperlessFileStorage unsupported operations", () => {
  it("retrieve/remove throw StorageError", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}));
    await expect(storage.retrieve("a.pdf")).rejects.toBeInstanceOf(StorageError);
    await expect(storage.remove("a.pdf")).rejects.toBeInstanceOf(StorageError);
  });

  it("checkReadAccess/checkWriteAccess report false, createDirectory is a no-op", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}));
    expect(await storage.checkReadAccess()).toBe(false);
    expect(await storage.checkWriteAccess()).toBe(false);
    await expect(storage.createDirectory()).resolves.toBeUndefined();
  });
});

describe("PaperlessFileStorage.store (defensive fallback)", () => {
  it("uploads with a title derived from the filename", async () => {
    const upload = vi.fn(async () => undefined);
    const storage = new PaperlessFileStorage(config, () => stubClient({ upload }));
    const result = await storage.store("2026/rechnung-42.pdf", Buffer.from("%PDF-1.4"));
    expect(upload).toHaveBeenCalledWith(
      Buffer.from("%PDF-1.4"),
      expect.objectContaining({ filename: "rechnung-42.pdf", title: "rechnung-42" }),
    );
    expect(result.relativePath).toBe("2026/rechnung-42.pdf");
  });
});
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/storage/paperless-file-storage.test.ts`
Expected: FAIL — Modul `./paperless-file-storage.js` existiert nicht

- [ ] **Step 3: `PaperlessFileStorage` implementieren**

Create `src/infrastructure/storage/paperless-file-storage.ts`:

```ts
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { PaperlessConfig } from "../../domain/storage-config.js";
import { PaperlessClient } from "../paperless/paperless-client.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";

interface PaperlessClientLike {
  checkAuth(): Promise<void>;
  upload(bytes: Buffer, meta: { filename: string; title: string; createdOn?: string }): Promise<void>;
}

export type PaperlessClientFactory = (config: PaperlessConfig) => PaperlessClientLike;

/**
 * Exists solely so the generic "Verbindung testen" wiring
 * (buildFileStorage(config).testConnection()) works for Paperless targets
 * unchanged. The real export path (application/export-to-paperless.ts) talks
 * to PaperlessClient directly instead, because it needs richer metadata
 * (real invoice date, descriptive title) that this port's store(relativePath,
 * bytes) signature cannot carry. retrieve/remove/checkReadAccess/
 * checkWriteAccess/createDirectory are unreachable in practice — Paperless
 * targets can never become the default or a migration participant (spec
 * section 2) — and are implemented defensively rather than left unsafe.
 */
export class PaperlessFileStorage implements FileStorage {
  readonly #config: PaperlessConfig;
  readonly #client: PaperlessClientLike;
  readonly #probes: ConnectionProbes;

  constructor(
    config: PaperlessConfig,
    clientFactory: PaperlessClientFactory = (cfg) => new PaperlessClient(cfg),
    probes: ConnectionProbes = defaultConnectionProbes,
  ) {
    this.#config = config;
    this.#client = clientFactory(config);
    this.#probes = probes;
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    const filename = basename(relativePath);
    const title = filename.replace(/\.[^./]+$/, "");
    try {
      await this.#client.upload(bytes, { filename, title });
    } catch (cause) {
      throw new StorageError(`Paperless-Upload fehlgeschlagen: ${relativePath}`, { cause });
    }
    return {
      relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  async retrieve(): Promise<Buffer> {
    throw new StorageError("Paperless-Ziele unterstützen kein Lesen einzelner Dokumente.");
  }

  async remove(): Promise<void> {
    throw new StorageError("Paperless-Ziele unterstützen kein Löschen einzelner Dokumente.");
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const url = new URL(this.#config.url);
    return runConnectionTestSteps([
      { id: "host_reachable", run: () => this.#probes.hostReachable(url.hostname) },
      {
        id: "port_reachable",
        run: () =>
          this.#probes.portReachable(
            url.hostname,
            url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
          ),
      },
      {
        id: "authenticated",
        run: async () => {
          try {
            await this.#client.checkAuth();
          } catch (cause) {
            throw new Error("Anmeldung fehlgeschlagen. API-Token ist ungültig.", { cause });
          }
        },
      },
    ]);
  }

  async checkReadAccess(): Promise<boolean> {
    return false;
  }

  async checkWriteAccess(): Promise<boolean> {
    return false;
  }

  async createDirectory(): Promise<void> {
    // No-op: Paperless has no directory concept to create.
  }
}
```

- [ ] **Step 4: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/storage/paperless-file-storage.test.ts`
Expected: PASS (alle 6 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/storage/paperless-file-storage.ts src/infrastructure/storage/paperless-file-storage.test.ts
git commit -m "$(cat <<'EOF'
feat: PaperlessFileStorage für den generischen Verbindungstest

Nur host/port/auth-Schritte, kein Schreibtest (kein billiges
Anlegen-und-Löschen bei Paperless' asynchroner Task-Queue).
retrieve/remove/checkReadAccess/checkWriteAccess defensiv, da im
Betrieb unerreichbar (Paperless ist nie Standard oder
Migrationsziel).
EOF
)"
```

---

## Task 7: `resolveFileStorage`/`buildFileStorage` — `paperless`-Fall

**Files:**
- Modify: `src/infrastructure/storage/resolve-file-storage.ts`
- Modify: `src/infrastructure/storage/resolve-file-storage.test.ts`

**Interfaces:**
- Consumes: `PaperlessFileStorage` (Task 6).
- Produces: `buildFileStorage` deckt `StorageBackendKind` wieder vollständig ab (behebt den in Task 2 Step 6 hingenommenen Compile-Fehler).

- [ ] **Step 1: Fehlschlagenden Test schreiben**

In `src/infrastructure/storage/resolve-file-storage.test.ts` im `describe("buildFileStorage", ...)`-Block ergänzen:

```ts
  it("builds a PaperlessFileStorage for backend='paperless'", () => {
    const storage = buildFileStorage(
      {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: false,
        },
      },
      dir,
    );
    expect(storage).toBeInstanceOf(PaperlessFileStorage);
  });
```

Und den Import am Dateianfang ergänzen: `import { PaperlessFileStorage } from "./paperless-file-storage.js";`

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/infrastructure/storage/resolve-file-storage.test.ts`
Expected: FAIL — TypeScript-Fehler, `buildFileStorage`s `switch` deckt `"paperless"` nicht ab (bzw. Laufzeitfehler, falls `switch` ohne `default` durchfällt)

- [ ] **Step 3: `switch` erweitern**

In `src/infrastructure/storage/resolve-file-storage.ts` Import ergänzen:

```ts
import { PaperlessFileStorage } from "./paperless-file-storage.js";
```

Und den `switch` in `buildFileStorage` (Zeile 11-22) erweitern:

```ts
    case "webdav":
      return new WebDavFileStorage(config.webdav);
    case "paperless":
      return new PaperlessFileStorage(config.paperless);
  }
```

- [ ] **Step 4: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/infrastructure/storage/resolve-file-storage.test.ts`
Expected: PASS

- [ ] **Step 5: Ganzes Projekt typchecken**

Run: `npm run typecheck`
Expected: PASS (der in Task 2 Step 6 hingenommene Fehler ist jetzt behoben)

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/storage/resolve-file-storage.ts src/infrastructure/storage/resolve-file-storage.test.ts
git commit -m "feat: buildFileStorage unterstützt backend=paperless"
```

---

## Task 8: `set-default-storage-target` lehnt Paperless-Ziele ab

**Files:**
- Modify: `src/application/set-default-storage-target.ts`
- Modify: `src/application/set-default-storage-target.test.ts`

**Interfaces:**
- Consumes: `StorageBackendKind` (Task 2).
- Produces: `setDefaultStorageTarget` wirft für `backend === "paperless"`, unabhängig vom `mode`.

- [ ] **Step 1: Fehlschlagenden Test schreiben**

In `src/application/set-default-storage-target.test.ts` nach dem Test `"refuses to make a disabled target the default"` (nach Zeile 81) einfügen:

```ts
  it("refuses to make a paperless target the default", async () => {
    const targets = makeTargets(makeTarget({ backend: "paperless" }), undefined);
    await expect(
      setDefaultStorageTarget(
        { targets, migrations: makeMigrations(), runMigration: vi.fn() },
        2,
        "new_only",
      ),
    ).rejects.toThrow(/Paperless/);
  });
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/application/set-default-storage-target.test.ts`
Expected: FAIL — kein Fehler wird geworfen

- [ ] **Step 3: Guard ergänzen**

In `src/application/set-default-storage-target.ts` nach Zeile 31 (`if (target === undefined) throw ...`) einfügen:

```ts
  if (target.backend === "paperless") {
    throw new Error("Ein Paperless-Ziel kann nicht Standardspeicher werden.");
  }
```

- [ ] **Step 4: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/application/set-default-storage-target.test.ts`
Expected: PASS (alle Tests)

- [ ] **Step 5: Commit**

```bash
git add src/application/set-default-storage-target.ts src/application/set-default-storage-target.test.ts
git commit -m "feat: Paperless-Ziele können nicht Standardspeicher werden"
```

---

## Task 9: `exportToPaperless` — der eigentliche Export-Use-Case

**Files:**
- Create: `src/application/export-to-paperless.ts`
- Create: `src/application/export-to-paperless.test.ts`

**Interfaces:**
- Consumes: `DocumentExportRepository`/`ExportCandidate` (Task 3), `StorageTargetRepository.listEnabledPaperlessTargets` (Task 4), `FileStorage` (bestehend), `StorageTarget` (bestehend).
- Produces: `PaperlessUploader` (`upload(bytes, meta): Promise<void>`), `ExportLogger` (`warn(context, message): void`), `ExportToPaperlessDeps`, `exportToPaperless(deps: ExportToPaperlessDeps): Promise<void>` — wird in Task 10 vom `RunCoordinator` aufgerufen.

- [ ] **Step 1: Fehlschlagenden Test schreiben**

Create `src/application/export-to-paperless.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { DocumentExportRepository, ExportCandidate } from "../domain/ports/repositories.js";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { exportToPaperless, type PaperlessUploader } from "./export-to-paperless.js";

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 10,
    name: "Paperless",
    backend: "paperless",
    destination: "https://paperless.example.com",
    purpose: "export",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: null,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config: {
      backend: "paperless",
      paperless: {
        url: "https://paperless.example.com",
        apiToken: "tok",
        rejectUnauthorized: true,
        deleteAfterUpload: false,
      },
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<ExportCandidate> = {}): ExportCandidate {
  return {
    documentId: 1,
    relativePath: "2026/r-1.pdf",
    accountLabel: "Konto A",
    invoiceNumber: "R-1",
    issuedOn: "2026-06-01",
    ...overrides,
  };
}

function makeStorage(bytes: Buffer = Buffer.from("%PDF-1.4")): FileStorage {
  return {
    store: vi.fn(),
    retrieve: vi.fn(async () => bytes),
    remove: vi.fn(async () => undefined),
    testConnection: vi.fn(),
    checkReadAccess: vi.fn(),
    checkWriteAccess: vi.fn(),
    createDirectory: vi.fn(),
  };
}

function makeExports(
  candidates: ExportCandidate[] = [candidate()],
): DocumentExportRepository & { isFullyExported: ReturnType<typeof vi.fn> } {
  return {
    listExportCandidates: vi.fn(async () => candidates),
    recordSuccess: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    isFullyExported: vi.fn(async () => false),
  };
}

describe("exportToPaperless", () => {
  it("does nothing when there are no enabled paperless targets", async () => {
    const storage = makeStorage();
    const exports = makeExports();
    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => []) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(),
      logger: { warn: vi.fn() },
    });
    expect(storage.retrieve).not.toHaveBeenCalled();
  });

  it("uploads each candidate with a title and the real invoice date, then records success", async () => {
    const storage = makeStorage(Buffer.from("bytes"));
    const exports = makeExports([candidate()]);
    const upload = vi.fn(async () => undefined);
    const uploader: PaperlessUploader = { upload };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 999,
    });

    expect(storage.retrieve).toHaveBeenCalledWith("2026/r-1.pdf");
    expect(upload).toHaveBeenCalledWith(
      Buffer.from("bytes"),
      expect.objectContaining({ filename: "r-1.pdf", createdOn: "2026-06-01" }),
    );
    expect(upload.mock.calls[0]![1].title).toContain("Konto A");
    expect(upload.mock.calls[0]![1].title).toContain("R-1");
    expect(exports.recordSuccess).toHaveBeenCalledWith(1, 10, 999);
  });

  it("records failure and continues when one upload throws", async () => {
    const storage = makeStorage();
    const exports = makeExports([candidate({ documentId: 1 }), candidate({ documentId: 2 })]);
    let call = 0;
    const uploader: PaperlessUploader = {
      upload: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
      }),
    };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.recordFailure).toHaveBeenCalledWith(1, 10, "boom", 1);
    expect(exports.recordSuccess).toHaveBeenCalledWith(2, 10, 1);
  });

  it("deletes the local file once all targets with deleteAfterUpload succeeded", async () => {
    const storage = makeStorage();
    const target = makeTarget({
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const exports = makeExports([candidate()]);
    exports.isFullyExported.mockResolvedValue(true);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [target]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.isFullyExported).toHaveBeenCalledWith(1, [10]);
    expect(storage.remove).toHaveBeenCalledWith("2026/r-1.pdf");
  });

  it("does not delete when deleteAfterUpload is off", async () => {
    const storage = makeStorage();
    const exports = makeExports([candidate()]);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("does not delete when isFullyExported is still false (another target pending)", async () => {
    const storage = makeStorage();
    const target = makeTarget({
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const exports = makeExports([candidate()]);
    exports.isFullyExported.mockResolvedValue(false);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [target]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("deletes once the last missing target succeeds, even though THAT target's own deleteAfterUpload is off", async () => {
    // Regression test: target 10 (deleteAfterUpload=true) already succeeded in
    // an earlier run, so it has no candidate left; target 20
    // (deleteAfterUpload=false) is the one completing the set THIS run. The
    // delete must still fire — gating the check on "the just-succeeded
    // target's own flag" instead of "does any enabled target want delete"
    // would silently never re-trigger it here.
    const storage = makeStorage();
    const targetWithDelete = makeTarget({
      id: 10,
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const targetWithoutDelete = makeTarget({
      id: 20,
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless2.example.com",
          apiToken: "tok2",
          rejectUnauthorized: true,
          deleteAfterUpload: false,
        },
      },
    });
    const exports: DocumentExportRepository & { isFullyExported: ReturnType<typeof vi.fn> } = {
      listExportCandidates: vi.fn(async (storageTargetId: number) =>
        storageTargetId === 20 ? [candidate()] : [],
      ),
      recordSuccess: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      isFullyExported: vi.fn(async () => true),
    };
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: {
        listEnabledPaperlessTargets: vi.fn(async () => [targetWithDelete, targetWithoutDelete]),
      },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.isFullyExported).toHaveBeenCalledWith(1, [10, 20]);
    expect(storage.remove).toHaveBeenCalledWith("2026/r-1.pdf");
  });
});
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/application/export-to-paperless.test.ts`
Expected: FAIL — Modul `./export-to-paperless.js` existiert nicht

- [ ] **Step 3: `exportToPaperless` implementieren**

Create `src/application/export-to-paperless.ts`:

```ts
import { basename } from "node:path";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type { DocumentExportRepository, StorageTargetRepository } from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";

export interface PaperlessUploader {
  upload(bytes: Buffer, meta: { filename: string; title: string; createdOn?: string }): Promise<void>;
}

export interface ExportLogger {
  warn(context: object, message: string): void;
}

export interface ExportToPaperlessDeps {
  readonly targets: Pick<StorageTargetRepository, "listEnabledPaperlessTargets">;
  readonly exports: DocumentExportRepository;
  readonly resolveDefaultStorage: () => Promise<FileStorage>;
  readonly buildPaperlessClient: (target: StorageTarget) => PaperlessUploader;
  readonly logger: ExportLogger;
  readonly now?: () => number;
}

/**
 * Runs after every sync (RunCoordinator hook, spec section 4), decoupled
 * from any single account or Vodafone session: pushes every `stored`
 * document to each currently enabled Paperless target that hasn't received
 * it yet, and — once a document has an `uploaded` row for every enabled
 * Paperless target and at least one of them wants `deleteAfterUpload` —
 * removes the local copy from the default storage. A document that becomes
 * fully exported only because deleteAfterUpload was turned on after the
 * fact (no new upload happens for it in this run) is not retroactively
 * deleted — an accepted, narrow gap (spec section 8: no retroactive
 * processing).
 *
 * The delete-check trigger is deliberately "does ANY currently enabled
 * target want deleteAfterUpload", not "did the target that just succeeded
 * want it" — the latter silently never re-triggers a check for a document
 * whose LAST missing target happens to be one without the flag set (the
 * ordinary case of a previously-failed upload succeeding on a later retry,
 * or a second Paperless target catching up after the first). Gating on the
 * per-run-successful target's own flag would let such a document sit
 * fully-exported-but-undeleted forever.
 */
export async function exportToPaperless(deps: ExportToPaperlessDeps): Promise<void> {
  const targets = await deps.targets.listEnabledPaperlessTargets();
  if (targets.length === 0) return;

  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));
  const defaultStorage = await deps.resolveDefaultStorage();
  const targetIds = targets.map((target) => target.id);
  const anyTargetWantsDelete = targets.some(
    (target) => target.config.backend === "paperless" && target.config.paperless.deleteAfterUpload,
  );

  // One retrieve() per document, regardless of how many enabled targets
  // still need it — group candidates by document first.
  const pending = new Map<
    number,
    { relativePath: string; title: string; createdOn: string; targets: StorageTarget[] }
  >();
  for (const target of targets) {
    if (target.config.backend !== "paperless") continue;
    const candidates = await deps.exports.listExportCandidates(target.id);
    for (const candidate of candidates) {
      const existing = pending.get(candidate.documentId);
      if (existing === undefined) {
        pending.set(candidate.documentId, {
          relativePath: candidate.relativePath,
          title: `${candidate.accountLabel} – Rechnung ${candidate.invoiceNumber}`,
          createdOn: candidate.issuedOn,
          targets: [target],
        });
      } else {
        existing.targets.push(target);
      }
    }
  }

  const documentsNeedingDeleteCheck = new Set<number>();

  for (const [documentId, entry] of pending) {
    let bytes: Buffer;
    try {
      bytes = await defaultStorage.retrieve(entry.relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const target of entry.targets) {
        await deps.exports.recordFailure(documentId, target.id, message, now());
      }
      deps.logger.warn({ err: error, documentId }, "paperless export failed to read source file");
      continue;
    }

    for (const target of entry.targets) {
      const client = deps.buildPaperlessClient(target);
      try {
        await client.upload(bytes, {
          filename: basename(entry.relativePath),
          title: entry.title,
          createdOn: entry.createdOn,
        });
        await deps.exports.recordSuccess(documentId, target.id, now());
        if (anyTargetWantsDelete) documentsNeedingDeleteCheck.add(documentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.exports.recordFailure(documentId, target.id, message, now());
        deps.logger.warn(
          { err: error, documentId, storageTargetId: target.id },
          "paperless export failed",
        );
      }
    }
  }

  for (const documentId of documentsNeedingDeleteCheck) {
    const relativePath = pending.get(documentId)?.relativePath;
    if (relativePath === undefined) continue;
    if (await deps.exports.isFullyExported(documentId, targetIds)) {
      await defaultStorage.remove(relativePath).catch((error: unknown) => {
        deps.logger.warn(
          { err: error, documentId },
          "failed to remove document after paperless export",
        );
      });
    }
  }
}
```

- [ ] **Step 4: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/application/export-to-paperless.test.ts`
Expected: PASS (alle 7 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/application/export-to-paperless.ts src/application/export-to-paperless.test.ts
git commit -m "$(cat <<'EOF'
feat: exportToPaperless-Use-Case

Lädt stored-Dokumente ohne uploaded-Zeile pro aktiviertem
Paperless-Ziel hoch, verzeichnet Erfolg/Fehler und löscht die lokale
Datei erst, wenn alle aktivierten Ziele erfolgreich waren und
mindestens eines deleteAfterUpload verlangt.
EOF
)"
```

---

## Task 10: `RunCoordinator` ruft `exportToPaperless` nach jedem Lauf auf

**Files:**
- Modify: `src/application/run-sync.ts`
- Modify: `src/application/run-sync.test.ts`

**Interfaces:**
- Consumes: `exportToPaperless`-Signatur `() => Promise<void>` (Task 9, hier als injizierte Dependency `exportToPaperless: () => Promise<void>`).
- Produces: `CoordinatorDeps.exportToPaperless`, aufgerufen am Ende von `runAll()` und `runAccount()`, Fehler darin werden geloggt und schlucken den Rest nicht.

- [ ] **Step 1: Fehlschlagenden Test schreiben**

In `src/application/run-sync.test.ts` die `makeDeps`-Funktion (Zeile 14-28) erweitern:

```ts
function makeDeps(overrides?: {
  syncableIds?: number[];
  sync?: (accountId: number) => Promise<SyncReport>;
  exportToPaperless?: () => Promise<void>;
}) {
  let nextRunId = 100;
  return {
    accounts: { listSyncableIds: vi.fn(async () => overrides?.syncableIds ?? [1, 2]) },
    runs: {
      startRun: vi.fn(async () => nextRunId++),
      finishRun: vi.fn(async () => undefined),
    },
    sync: vi.fn(overrides?.sync ?? (async () => reportOf("success"))),
    exportToPaperless: vi.fn(overrides?.exportToPaperless ?? (async () => undefined)),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}
```

Und zwei neue Tests am Ende der Datei (vor dem letzten schließenden `});` von `describe("RunCoordinator.runAccount", ...)`) ergänzen:

```ts
  it("runs the paperless export step once after runAll", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    await coordinator.runAll("schedule");
    expect(deps.exportToPaperless).toHaveBeenCalledOnce();
  });

  it("runs the paperless export step after runAccount", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    await coordinator.runAccount(7, "manual");
    expect(deps.exportToPaperless).toHaveBeenCalledOnce();
  });

  it("logs and swallows a crash in the paperless export step", async () => {
    const deps = makeDeps({
      exportToPaperless: async () => {
        throw new Error("paperless down");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.started).toBe(true);
    expect(deps.logger.error).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/application/run-sync.test.ts`
Expected: FAIL — `deps.exportToPaperless` wurde nie aufgerufen (bzw. TypeScript-Fehler, da `CoordinatorDeps` das Feld noch nicht kennt)

- [ ] **Step 3: `CoordinatorDeps` und `RunCoordinator` erweitern**

In `src/application/run-sync.ts` Zeile 21-26 (`CoordinatorDeps`) erweitern:

```ts
export interface CoordinatorDeps {
  readonly accounts: Pick<AccountRepository, "listSyncableIds">;
  readonly runs: RunRepository;
  readonly sync: (accountId: number) => Promise<SyncReport>;
  readonly exportToPaperless: () => Promise<void>;
  readonly logger: RunLogger;
}
```

`runAll` (Zeile 42-58) und `runAccount` (Zeile 60-71) ändern:

```ts
  async runAll(trigger: RunTrigger): Promise<RunAllResult> {
    if (this.#busy) {
      this.#deps.logger.warn({ trigger }, "sync run already in progress; skipping tick");
      return { started: false, runs: [] };
    }
    this.#busy = true;
    try {
      const accountIds = await this.#deps.accounts.listSyncableIds();
      const runs: RunSummary[] = [];
      for (const accountId of accountIds) {
        runs.push(await this.#runOne(accountId, trigger));
      }
      await this.#runExport();
      return { started: true, runs };
    } finally {
      this.#busy = false;
    }
  }

  async runAccount(accountId: number, trigger: RunTrigger): Promise<RunSummary | null> {
    if (this.#busy) {
      this.#deps.logger.warn({ trigger, accountId }, "sync run already in progress; skipping");
      return null;
    }
    this.#busy = true;
    try {
      const summary = await this.#runOne(accountId, trigger);
      await this.#runExport();
      return summary;
    } finally {
      this.#busy = false;
    }
  }

  async #runExport(): Promise<void> {
    try {
      await this.#deps.exportToPaperless();
    } catch (error) {
      this.#deps.logger.error({ err: error }, "paperless export step crashed");
    }
  }
```

- [ ] **Step 4: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/application/run-sync.test.ts`
Expected: PASS (alle Tests, inklusive der 3 neuen)

- [ ] **Step 5: Commit**

```bash
git add src/application/run-sync.ts src/application/run-sync.test.ts
git commit -m "$(cat <<'EOF'
feat: RunCoordinator stößt Paperless-Export nach jedem Lauf an

Läuft nach runAll und runAccount, unabhängig vom Sync-Ergebnis; ein
Crash im Export-Schritt wird geloggt, ohne den Lauf als Ganzes
scheitern zu lassen.
EOF
)"
```

---

## Task 11: Composition-Root-Wiring

**Files:**
- Modify: `src/composition-root.ts`

**Interfaces:**
- Consumes: `DrizzleDocumentExportRepository` (Task 3), `exportToPaperless` (Task 9), `PaperlessClient` (Task 5), `resolveDefaultFileStorage` (bestehend).
- Produces: Vollständig verdrahtete Anwendung — `RunCoordinator` bekommt eine echte `exportToPaperless`-Funktion.

- [ ] **Step 1: Imports ergänzen**

In `src/composition-root.ts` nach der bestehenden `migrate-storage.js`-Import-Zeile (Zeile 4) und den anderen Repository-Imports ergänzen:

```ts
import { exportToPaperless } from "./application/export-to-paperless.js";
```

Nach dem `DrizzleMigrationRepository`-Import (Zeile 24) ergänzen:

```ts
import { DrizzleDocumentExportRepository } from "./infrastructure/persistence/repositories/document-export-repository.js";
```

Nach dem `PaperlessFileStorage`/`resolveFileStorage`-Import-Block ergänzen:

```ts
import { PaperlessClient } from "./infrastructure/paperless/paperless-client.js";
```

- [ ] **Step 2: Repository und Export-Schritt verdrahten**

Nach der Zeile `const storageTargets = new DrizzleStorageTargetRepository(db, cipher);` (Zeile 87) und vor `await ensureInitialStorageTarget(...)` bleibt die Reihenfolge gleich; direkt danach (nach Zeile 88) ergänzen:

```ts
  const documentExports = new DrizzleDocumentExportRepository(db);
```

Nach dem bestehenden `const sync = async (...) => {...};`-Block (nach Zeile 128) einfügen:

```ts
  const runPaperlessExport = (): Promise<void> =>
    exportToPaperless({
      targets: storageTargets,
      exports: documentExports,
      resolveDefaultStorage: () => resolveDefaultFileStorage(storageTargets, config.downloadsDir),
      buildPaperlessClient: (target) => {
        if (target.config.backend !== "paperless") {
          throw new Error("listEnabledPaperlessTargets returned a non-paperless target");
        }
        return new PaperlessClient({
          url: target.config.paperless.url,
          apiToken: target.config.paperless.apiToken,
          rejectUnauthorized: target.config.paperless.rejectUnauthorized,
        });
      },
      logger,
    });
```

- [ ] **Step 3: `RunCoordinator`-Konstruktion anpassen**

Zeile 136 ändern:

```ts
  const coordinator = new RunCoordinator({
    accounts,
    runs,
    sync,
    exportToPaperless: runPaperlessExport,
    logger,
  });
```

- [ ] **Step 4: Bestehenden Composition-Root-Smoke-Test laufen lassen**

Run: `npx vitest run src/composition-root.test.ts`
Expected: PASS — bestätigt, dass die App mit der neuen Verdrahtung weiterhin sauber bootet

- [ ] **Step 5: Ganzes Projekt typchecken und testen**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/composition-root.ts
git commit -m "$(cat <<'EOF'
feat: Paperless-Export in der Composition Root verdrahten

RunCoordinator bekommt eine echte exportToPaperless-Funktion, die
DrizzleDocumentExportRepository, resolveDefaultFileStorage und einen
frisch gebauten PaperlessClient pro aktiviertem Ziel zusammenführt.
EOF
)"
```

---

## Task 12: UI — Speicherziel-Typ-Karte, Formular, Listen-Anpassungen

**Files:**
- Modify: `src/web/views/storage-form.ts`
- Modify: `src/web/views/storage.ts`

**Interfaces:**
- Consumes: `PaperlessConfig`/`StorageBackendKind` (Task 2).
- Produces: `paperlessFields()`, neue Karte in `TYPE_CARDS`, `BACKEND_LABEL`/`BACKEND_LABEL_SHORT` inkl. `paperless`, `storageTargetRow` blendet „Standard setzen" für Paperless aus, `commonFields`/`storageCreateForm` blenden Verwendungszweck-Auswahl und „Als Standardspeicher verwenden" für Paperless aus.

- [ ] **Step 1: `TYPE_CARDS` erweitern**

In `src/web/views/storage-form.ts` nach dem `webdav`-Eintrag (Zeile 21-25) ergänzen:

```ts
  {
    type: "paperless",
    title: "Paperless-ngx",
    description: "Zusätzlicher Export bereits gespeicherter Rechnungen zu einer Paperless-ngx-Instanz.",
  },
```

- [ ] **Step 2: `paperlessFields` implementieren und in `backendFields` einhängen**

Nach der `webdavFields`-Funktion (nach Zeile 279, vor `function backendFields`) einfügen:

```ts
function paperlessFields(values: StorageFormValues, mode: "create" | "edit", hasSecret: boolean): string {
  return `<div class="form-grid">
    ${field(`
    <label for="paperlessUrl">Server-URL</label>
    <input id="paperlessUrl" name="paperlessUrl" type="url" required value="${escapeHtml(values.paperlessUrl ?? "")}" placeholder="https://paperless.example.com">`)}
    ${secretField("paperlessApiToken", "paperlessApiToken", "API-Token", values, mode, hasSecret)}
    ${field(
      `
    <details>
      <summary>Erweiterte Einstellungen</summary>
      <label>
        <input type="checkbox" name="paperlessRejectUnauthorized" value="false"${values.paperlessRejectUnauthorized === "false" ? " checked" : ""}>
        TLS-Zertifikat nicht prüfen
      </label>
      <p class="security-warning security-warning-danger">Unsicher: Die Identität des Servers kann nicht zuverlässig geprüft werden.</p>
      <label>
        <input type="checkbox" name="paperlessDeleteAfterUpload" value="on"${values.paperlessDeleteAfterUpload === "on" ? " checked" : ""}>
        Nach erfolgreichem Upload am Speicherziel löschen
      </label>
      <p class="muted">Die Datei ist danach nur noch über Paperless einsehbar, nicht mehr über die Rechnungen-Ansicht dieser App.</p>
    </details>`,
      true,
    )}
  </div>`;
}
```

`backendFields` (Zeile 279-297 nach der vorherigen Einfügung verschoben, ursprünglich Zeile 279-297) um einen `case` erweitern:

```ts
    case "webdav":
      return webdavFields(values, mode, hasSecret);
    case "paperless":
      return paperlessFields(values, mode, hasSecret);
    case "local":
      return "";
```

- [ ] **Step 3: Verwendungszweck-Auswahl und „Als Standard"-Checkbox für Paperless ausblenden**

In `storageCreateForm` (Zeile 306-336) ändern:

```ts
export function storageCreateForm(options: StorageCreateFormOptions): string {
  const tested = options.testResult?.success === true;
  const isPaperless = options.type === "paperless";
  return `
<section>
  <h1>Speicherziel hinzufügen — ${escapeHtml(BACKEND_LABEL[options.type])}</h1>
  ${wizardSteps(2)}
  <form method="post" action="/storage" id="storage-form" class="wide-form" autocomplete="off" data-bwignore data-lpignore="true" data-1p-ignore data-form-type="other" data-storage-form>
    <input type="hidden" name="_csrf" value="${escapeHtml(options.csrfToken)}">
    <input type="hidden" name="type" value="${options.type}">
    <div class="form-grid">
      ${commonFields(options.values, !isPaperless)}
      ${
        isPaperless
          ? ""
          : field(
              `
      <label>
        <input type="checkbox" name="isDefault" value="on"${options.values.isDefault === "on" ? " checked" : ""}>
        Als Standardspeicher verwenden
      </label>`,
              true,
            )
      }
    </div>
    ${backendFields(options.type, options.values, "create", false)}
    ${testResultPanel(options.testResult)}
    <div class="table-actions">
      <a class="btn-secondary" role="button" href="/storage/new">Zurück</a>
      <button class="btn-secondary" type="submit" formaction="/storage/test" formnovalidate>Verbindung testen</button>
      <button class="btn-secondary" type="submit" name="action" value="save_untested" formnovalidate>Als ungetestet speichern</button>
      <button type="submit" name="action" value="save"${tested ? "" : " data-requires-test"}>Speichern</button>
    </div>
  </form>
</section>`;
}
```

`storageEditForm` (Zeile 347-363) Zeile `${field(\`commonFields...\`)}` ändern — konkret Zeile 353:

```ts
    <div class="form-grid">${commonFields(options.values, options.type !== "paperless")}</div>
```

- [ ] **Step 4: `BACKEND_LABEL`/`BACKEND_LABEL_SHORT` in `storage.ts` ergänzen**

In `src/web/views/storage.ts` Zeile 6-12 und 15-21 erweitern:

```ts
export const BACKEND_LABEL: Record<StorageBackendKind, string> = {
  local: "Lokal",
  smb: "SMB/Windows-Freigabe",
  sftp: "SFTP",
  ftp: "FTP/FTPS",
  webdav: "WebDAV",
  paperless: "Paperless-ngx",
};

/** Short form for the overview table, where "SMB/Windows-Freigabe" alone would blow out the column. */
const BACKEND_LABEL_SHORT: Record<StorageBackendKind, string> = {
  local: "Lokal",
  smb: "SMB",
  sftp: "SFTP",
  ftp: "FTP/FTPS",
  webdav: "WebDAV",
  paperless: "Paperless",
};
```

- [ ] **Step 5: „Standard setzen" für Paperless-Zeilen ausblenden**

In `src/web/views/storage.ts` Zeile 79-83 (`setDefaultAction`) ändern:

```ts
  const setDefaultAction =
    target.isDefault || target.backend === "paperless"
      ? ""
      : `<form class="inline-form" hx-get="/storage/${target.id}/default-confirm" hx-target="#default-confirm-dialog" hx-swap="innerHTML">
        <button class="btn-secondary" type="submit">Standard setzen</button>
      </form>`;
```

- [ ] **Step 6: Typecheck (Formular-Route referenziert noch fehlende Felder — wird in Task 13 behoben, hier nur der View-Layer selbst)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "storage-form|storage\.ts" || true`
Expected: Keine Fehler in `storage-form.ts`/`storage.ts` selbst (Fehler in `web/routes/storage.ts`, falls vorhanden, sind erwartet und werden in Task 13 behoben)

- [ ] **Step 7: Commit**

```bash
git add src/web/views/storage-form.ts src/web/views/storage.ts
git commit -m "$(cat <<'EOF'
feat: Paperless-ngx-Karte und -Formular im Speicherziel-Wizard

Verwendungszweck-Auswahl und "Als Standardspeicher verwenden"
werden für Paperless ausgeblendet (immer purpose=export, nie
Standard); "Standard setzen" fehlt konsequent auch in der Liste.
EOF
)"
```

---

## Task 13: Web-Route — Formular-Parsing + Route-Tests

**Files:**
- Modify: `src/web/routes/storage.ts`
- Modify: `src/web/routes/storage.test.ts`

**Interfaces:**
- Consumes: `PaperlessConfig` (Task 2), UI aus Task 12.
- Produces: `parseBackendType` akzeptiert `"paperless"`, `buildConfigFromForm`/`valuesFromConfig`/`targetHasSecret` decken `paperless` ab, `purpose` wird für Paperless serverseitig auf `"export"` erzwungen, `isDefault`-Checkbox wird für Paperless serverseitig ignoriert.

- [ ] **Step 1: Fehlschlagenden Test schreiben**

In `src/web/routes/storage.test.ts` nach der `sftpPayload`-Funktion (nach Zeile 356) ergänzen:

```ts
function paperlessPayload(csrfToken: string): Record<string, string> {
  return {
    type: "paperless",
    name: "Paperless",
    paperlessUrl: "https://paperless.example.com",
    paperlessApiToken: "tok_abc123",
    _csrf: csrfToken,
  };
}
```

Und einen neuen `describe`-Block am Ende der Datei ergänzen:

```ts
describe("Paperless storage target", () => {
  it("hides the purpose selector and the default checkbox on the create form", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/storage/new/paperless" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("paperlessUrl");
    expect(response.body).not.toContain('name="purpose"');
    expect(response.body).not.toContain('name="isDefault"');
  });

  it("saves a paperless target with purpose=export regardless of form input, and ignores isDefault", async () => {
    const { app: testApp, targets } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/paperless" });

    const response = await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: {
        ...paperlessPayload(extractCsrfToken(form.body)),
        purpose: "document",
        isDefault: "on",
        action: "save_untested",
      },
    });

    expect(response.statusCode).toBe(200);
    const list = await targets.list();
    const saved = list.find((t) => t.name === "Paperless");
    expect(saved).toMatchObject({ purpose: "export", isDefault: false, backend: "paperless" });
  });

  it("does not offer 'Standard setzen' for a paperless row", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;
    const form = await app.inject({ method: "GET", url: "/storage/new/paperless" });
    await app.inject({
      method: "POST",
      url: "/storage",
      cookies: cookieHeader(form),
      payload: { ...paperlessPayload(extractCsrfToken(form.body)), action: "save_untested" },
    });

    const overview = await app.inject({ method: "GET", url: "/storage" });
    const paperlessRowStart = overview.body.indexOf("Paperless<");
    const rowSlice = overview.body.slice(paperlessRowStart, paperlessRowStart + 800);
    expect(rowSlice).not.toContain("Standard setzen");
  });
});
```

- [ ] **Step 2: Test laufen lassen, um das Scheitern zu bestätigen**

Run: `npx vitest run src/web/routes/storage.test.ts`
Expected: FAIL — `/storage/new/paperless` liefert 404 (Route erkennt `paperless` noch nicht als gültigen Typ)

- [ ] **Step 3: `parseBackendType` erweitern**

In `src/web/routes/storage.ts` Zeile 494-505 ändern:

```ts
function parseBackendType(value: string | undefined): StorageBackendKind | undefined {
  if (
    value === "smb" ||
    value === "sftp" ||
    value === "ftp" ||
    value === "webdav" ||
    value === "paperless" ||
    value === "local"
  ) {
    return value;
  }
  return undefined;
}
```

- [ ] **Step 4: `buildConfigFromForm`/`valuesFromConfig`/`targetHasSecret` um `paperless` ergänzen**

Import-Zeile 17-24 erweitern:

```ts
import type {
  FtpConfig,
  PaperlessConfig,
  SftpConfig,
  SmbConfig,
  StorageBackendKind,
  StorageConfig,
  WebDavConfig,
} from "../../domain/storage-config.js";
```

`buildConfigFromForm` (Zeile 533-550) erweitern:

```ts
function buildConfigFromForm(
  type: StorageBackendKind,
  body: StorageFormBody,
  existing?: StorageConfig,
): StorageConfig | undefined {
  switch (type) {
    case "smb":
      return buildSmbConfig(body, existing?.backend === "smb" ? existing.smb : undefined);
    case "sftp":
      return buildSftpConfig(body, existing?.backend === "sftp" ? existing.sftp : undefined);
    case "ftp":
      return buildFtpConfig(body, existing?.backend === "ftp" ? existing.ftp : undefined);
    case "webdav":
      return buildWebDavConfig(body, existing?.backend === "webdav" ? existing.webdav : undefined);
    case "paperless":
      return buildPaperlessConfig(
        body,
        existing?.backend === "paperless" ? existing.paperless : undefined,
      );
    case "local":
      return undefined;
  }
}

function buildPaperlessConfig(
  body: StorageFormBody,
  existing?: PaperlessConfig,
): StorageConfig | undefined {
  const url = (body.paperlessUrl ?? "").trim();
  try {
    new URL(url);
  } catch {
    return undefined;
  }
  const changeSecrets = body.changeSecrets === "on" || existing === undefined;
  const apiToken = changeSecrets ? (body.paperlessApiToken ?? "").trim() : existing.apiToken;
  if (apiToken === "") return undefined;
  return {
    backend: "paperless",
    paperless: {
      url,
      apiToken,
      rejectUnauthorized: body.paperlessRejectUnauthorized !== "false",
      deleteAfterUpload: body.paperlessDeleteAfterUpload === "on",
    },
  };
}
```

`targetHasSecret` (Zeile 681-700) erweitern:

```ts
function targetHasSecret(config: StorageConfig): boolean {
  switch (config.backend) {
    case "local":
      return false;
    case "smb":
      return config.smb.password !== "";
    case "ftp":
      return config.ftp.password !== "";
    case "sftp":
      return config.sftp.auth.kind === "password"
        ? config.sftp.auth.password !== ""
        : config.sftp.auth.privateKey !== "";
    case "webdav":
      return config.webdav.auth.kind === "basic"
        ? config.webdav.auth.password !== ""
        : config.webdav.auth.kind === "bearer"
          ? config.webdav.auth.token !== ""
          : false;
    case "paperless":
      return config.paperless.apiToken !== "";
  }
}
```

`valuesFromConfig` (Zeile 702-740) erweitern:

```ts
    case "webdav":
      return {
        webdavUrl: config.webdav.url,
        webdavPath: config.webdav.path,
        webdavAuthKind: config.webdav.auth.kind,
        webdavUsername: config.webdav.auth.kind === "basic" ? config.webdav.auth.username : "",
        webdavRejectUnauthorized: config.webdav.rejectUnauthorized ? "true" : "false",
      };
    case "paperless":
      return {
        paperlessUrl: config.paperless.url,
        paperlessRejectUnauthorized: config.paperless.rejectUnauthorized ? "true" : "false",
        paperlessDeleteAfterUpload: config.paperless.deleteAfterUpload ? "on" : "",
      };
  }
}
```

- [ ] **Step 5: `purpose` für Paperless serverseitig erzwingen, `isDefault`-Checkbox ignorieren**

In der `POST /storage`-Route (Zeile 147-157) ändern:

```ts
    try {
      const id = await createStorageTarget(
        { targets: options.targets },
        {
          name: request.body.name ?? "",
          purpose: type === "paperless" ? "export" : parsePurpose(request.body.purpose),
          description: emptyToNull(request.body.description),
          config,
          tested: testResult?.success === true,
        },
      );
      if (request.body.isDefault === "on" && type !== "paperless") {
        await options.targets.setDefault(id);
      }
```

In der `POST /storage/:id`-Route (Zeile 273-279) ändern:

```ts
      try {
        await updateStorageTarget({ targets: options.targets }, id, {
          name: request.body.name ?? "",
          purpose: target.backend === "paperless" ? "export" : parsePurpose(request.body.purpose),
          description: emptyToNull(request.body.description),
          config,
        });
```

- [ ] **Step 6: Test laufen lassen, um das Bestehen zu bestätigen**

Run: `npx vitest run src/web/routes/storage.test.ts`
Expected: PASS (alle Tests, inklusive der 3 neuen)

- [ ] **Step 7: Ganzes Projekt prüfen**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/storage.ts src/web/routes/storage.test.ts
git commit -m "$(cat <<'EOF'
feat: Paperless-Speicherziel per Formular anlegen/bearbeiten

purpose wird für Paperless serverseitig immer auf "export" gesetzt,
ein mitgeschicktes isDefault=on wird ignoriert — auch bei direktem
POST ohne die (in Task 12 bereits ausgeblendeten) UI-Elemente.
EOF
)"
```

---

## Task 14: Abschlussprüfung

**Files:** keine Änderungen — reine Verifikation.

- [ ] **Step 1: Vollständigen Testlauf, Typecheck und Lint ausführen**

Run: `npm run typecheck && npm run lint && npm test`
Expected: Alle drei PASS, keine Warnungen

- [ ] **Step 2: Manuelle Smoke-Prüfung im Browser**

Die `run`-Skill verwenden (Dev-Server starten, per Playwright/`chromium-cli` einloggen, zu `/storage/new/paperless` navigieren, Formular ausfüllen, Speichern, prüfen dass der neue Eintrag in `/storage` ohne „Standard setzen"-Aktion erscheint) — analog zur bereits im Rahmen dieser Konversation durchgeführten Verifikation der FTP-Warnungs-Korrektur. Screenshot als Nachweis.

- [ ] **Step 3: `CHANGELOG.de.md`/`CHANGELOG.md` ergänzen (falls im Projekt üblich vor einem Release)**

Prüfen, ob unveröffentlichte Änderungen üblicherweise vor dem nächsten Versions-Bump gesammelt werden (siehe `git log` auf `CHANGELOG.de.md`); falls ja, einen Eintrag ergänzen: „Paperless-ngx als zusätzliches Exportziel für Speicherziele". Falls das Projekt Changelogs erst beim Versions-Bump pflegt, diesen Schritt auslassen.

- [ ] **Step 4: Finalen Zusammenfassungs-Commit NICHT anlegen**

Kein leerer Abschluss-Commit — jeder Task hat bereits committet. Dieser Task dient nur der Verifikation.
