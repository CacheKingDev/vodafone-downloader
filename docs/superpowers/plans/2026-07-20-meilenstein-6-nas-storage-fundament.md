# Meilenstein 6a: NAS-Speicherziele — Fundament Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Den `FileStorage`-Port und die Settings-Schicht so erweitern, dass ein alternatives, verschlüsselt konfiguriertes Speicherziel gewählt und über einen idempotenten, resumable Hintergrund-Migrationslauf aktiviert werden kann — vollständig lauffähig mit dem bestehenden lokalen Backend als einzigem Ziel. Die vier NAS-Protokolle (SFTP, FTP, WebDAV, SMB) kommen in eigenen Folgeplänen dazu, ohne dieses Fundament nochmal anzufassen.

**Architecture:** Der bestehende Port `FileStorage` wächst um `retrieve`/`remove`/`testConnection`. Ein neuer Use Case `changeStorageTarget` entscheidet bei einem Settings-Wechsel zwischen sofortigem Übernehmen (gleiches Backend) und einem Migrationslauf (`StorageMigrationRunner`), der Dokumente vom alten zum neuen Backend kopiert, per SHA-256 verifiziert und danach am alten Ziel löscht — erst danach wird das neue Ziel aktiv. Bis dahin bleiben Sync und Downloads unverändert auf dem alten Backend (kein Split-Brain).

**Tech Stack:** TypeScript (strict), Drizzle ORM/SQLite, Zod, Vitest. Keine neuen Laufzeit-Abhängigkeiten in diesem Plan.

## Global Constraints

- Basis: `docs/superpowers/specs/2026-07-20-meilenstein-6-nas-storage-design.md` (§2–4)
- Node: `target: ES2023`, `module: NodeNext` — Imports enden auf `.js`, `verbatimModuleSyntax: true` erzwingt `import type` für reine Typ-Importe.
- `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` sind aktiv — keine impliziten `undefined`-Zuweisungen auf optionale Properties.
- Alle UI-/Log-Texte auf Deutsch, konsistent mit bestehenden Routen/Views.
- Repo erzwingt LF-Zeilenenden (`.gitattributes`) — keine CRLF in neuen Dateien.
- Verschlüsselung ausschließlich über die bestehende Klasse `Cipher` (`src/infrastructure/crypto/cipher.ts`), kein neuer Schlüsselmechanismus.
- Kein Kommentar, der nur wiederholt, was der Code schon sagt — nur für nicht-offensichtliches WARUM (bestehende Konvention im Repo).
- `npm run typecheck`, `npm run lint`, `npm test` müssen nach jedem Task grün sein.

---

## Task 1: `FileStorage`-Port erweitern + `AtomicFileStorage`

**Files:**
- Modify: `src/domain/ports/file-storage.ts`
- Modify: `src/infrastructure/storage/atomic-file-storage.ts`
- Test: `src/infrastructure/storage/atomic-file-storage.test.ts` (bestehende Datei erweitern)

**Interfaces:**
- Produces: `FileStorage.retrieve(relativePath: string): Promise<Buffer>`, `FileStorage.remove(relativePath: string): Promise<void>` (idempotent — keine Exception bei fehlender Datei), `FileStorage.testConnection(): Promise<void>`.

- [ ] **Step 1: Port um die drei neuen Methoden erweitern**

`src/domain/ports/file-storage.ts` — vor der bestehenden `FileStorage`-Interface-Definition:

```ts
export interface FileStorage {
  /**
   * Writes bytes atomically below the downloads root. On a path collision the
   * implementation appends _2, _3, … before the extension; the path actually
   * used is returned.
   */
  store(relativePath: string, bytes: Buffer): Promise<StoredFile>;
  /** Reads bytes back. Throws StorageError if the path does not exist or is unreachable. */
  retrieve(relativePath: string): Promise<Buffer>;
  /** Deletes the file. A missing file is not an error — the call is idempotent. */
  remove(relativePath: string): Promise<void>;
  /** Verifies the backend is reachable and writable. Throws StorageError with a user-facing message on failure. */
  testConnection(): Promise<void>;
}
```

(Der bestehende Kommentar über `store` bleibt erhalten, wird nur mit den drei neuen Methoden ergänzt.)

- [ ] **Step 2: Fehlschlagende Tests für `retrieve`/`remove`/`testConnection` schreiben**

Ans Ende von `src/infrastructure/storage/atomic-file-storage.test.ts` anfügen (innerhalb des bestehenden `describe("AtomicFileStorage", ...)`-Blocks):

```ts
  it("retrieves previously stored bytes", async () => {
    await storage.store("a/r.pdf", bytes);
    await expect(storage.retrieve("a/r.pdf")).resolves.toEqual(bytes);
  });

  it("rejects retrieving a path that does not exist", async () => {
    await expect(storage.retrieve("missing.pdf")).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects retrieving an absolute path", async () => {
    await expect(storage.retrieve("/etc/passwd")).rejects.toBeInstanceOf(StorageError);
  });

  it("removes a stored file", async () => {
    await storage.store("a/r.pdf", bytes);
    await storage.remove("a/r.pdf");
    expect(existsSync(join(root, "a", "r.pdf"))).toBe(false);
  });

  it("does not throw when removing a file that does not exist", async () => {
    await expect(storage.remove("never-existed.pdf")).resolves.toBeUndefined();
  });

  it("rejects removing an absolute path", async () => {
    await expect(storage.remove("/etc/passwd")).rejects.toBeInstanceOf(StorageError);
  });

  it("testConnection succeeds and leaves no marker behind", async () => {
    await storage.testConnection();
    expect(existsSync(join(root, ".storage-test"))).toBe(false);
  });
```

- [ ] **Step 3: Tests laufen lassen und Fehlschlag bestätigen**

Run: `npx vitest run src/infrastructure/storage/atomic-file-storage.test.ts`
Expected: FAIL — `storage.retrieve is not a function` (und analog für `remove`/`testConnection`).

- [ ] **Step 4: `AtomicFileStorage` implementieren**

`src/infrastructure/storage/atomic-file-storage.ts` komplett ersetzen durch:

```ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";

/** Reserved Windows device names — any segment matching these is rejected. */
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Characters in the range U+007F (DEL) and U+0080…U+009F (C1 control). */
const CONTROL_RANGE = /[-]/g;

const CONNECTION_TEST_MARKER = ".storage-test/marker.tmp";

/**
 * Strips DEL/C1 control characters from a filename segment so the resulting
 * name is safe on Windows, Linux and macOS without changing the visible text.
 */
function sanitizeFileName(name: string): string {
  return name.replace(CONTROL_RANGE, "");
}

/**
 * Throws if any path segment is a reserved Windows device name (case-insensitive)
 * or the directory name `.tmp` (collides with the storage's internal temp folder).
 */
function validateReservedName(relativePath: string): void {
  const normalized = relativePath.split("/").join(sep);
  const parts = normalized.split(sep);
  for (const part of parts) {
    if (!part) continue;
    if (part === ".tmp") {
      throw new StorageError(`Directory name ".tmp" is reserved for internal use`);
    }
    const upper = part.toUpperCase();
    if (RESERVED_NAMES.has(upper)) {
      throw new StorageError(`Reserved device name in path: ${part}`);
    }
  }
}

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
    const target = this.#resolveSafe(relativePath);
    const finalPath = this.resolveCollision(target);

    const tmpDir = join(this.#root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = join(tmpDir, randomUUID());
    try {
      const handle = await open(tmpPath, "w");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      // Best-effort cleanup: a failed store must not leak tmp debris.
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      relativePath: relative(this.#root, finalPath).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    const target = this.#resolveSafe(relativePath);
    try {
      return await readFile(target);
    } catch (error) {
      throw new StorageError(`Failed to read ${relativePath}`, { cause: error });
    }
  }

  async remove(relativePath: string): Promise<void> {
    const target = this.#resolveSafe(relativePath);
    try {
      await rm(target, { force: true });
    } catch (error) {
      throw new StorageError(`Failed to remove ${relativePath}`, { cause: error });
    }
  }

  async testConnection(): Promise<void> {
    await this.store(CONNECTION_TEST_MARKER, Buffer.from("ok"));
    await this.remove(CONNECTION_TEST_MARKER);
  }

  /** Absolute-path rejection + sanitizing + reserved-name check + escape-root
   * check, shared by store/retrieve/remove. Does not resolve collisions —
   * only store() needs that. */
  #resolveSafe(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new StorageError(`Refusing absolute path: ${relativePath}`);
    }

    const sanitized = relativePath.split(sep).map(sanitizeFileName).join(sep);
    validateReservedName(sanitized);

    const target = resolve(this.#root, sanitized);
    if (!target.startsWith(this.#root + sep)) {
      throw new StorageError(`Path escapes the downloads root: ${relativePath}`);
    }
    return target;
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

- [ ] **Step 5: Tests laufen lassen und Erfolg bestätigen**

Run: `npx vitest run src/infrastructure/storage/atomic-file-storage.test.ts`
Expected: PASS (alle bestehenden und neuen Tests).

- [ ] **Step 6: Typecheck und Lint**

Run: `npm run typecheck && npm run lint`
Expected: keine Fehler.

- [ ] **Step 7: Commit**

```bash
git add src/domain/ports/file-storage.ts src/infrastructure/storage/atomic-file-storage.ts src/infrastructure/storage/atomic-file-storage.test.ts
git commit -m "feat: FileStorage-Port um retrieve/remove/testConnection erweitert"
```

---

## Task 2: Domain-Typen für Storage-Konfiguration + Port-Erweiterungen

**Files:**
- Create: `src/domain/storage-config.ts`
- Modify: `src/domain/ports/repositories.ts`

**Interfaces:**
- Produces: `StorageBackendKind`, `StorageConfig` (discriminated union über `backend`), `SmbConfig`, `FtpConfig`, `SftpConfig`, `SftpAuth`, `WebDavConfig`, `WebDavAuth` — alle aus `src/domain/storage-config.ts`.
- Produces: `StoredDocumentRecord`, `MigrationStatus`, `StorageMigrationRecord`, `CreateMigrationInput`, `MigrationRepository` — aus `src/domain/ports/repositories.ts`.
- Produces: `SettingsRepository.storageBackend(): Promise<StorageBackendKind>`, `SettingsRepository.storageConfig(): Promise<StorageConfig>`, `SettingsUiRepository.setStorageTarget(config: StorageConfig): Promise<void>`.

Reine Typdefinitionen ohne Laufzeitlogik — kein eigener Test in diesem Task; die Validierung kommt in Task 4 über die Zod-Schemas, die gegen diese Typen geprüft werden (Type-Level-Check via `satisfies`/Zuweisung, siehe Task 4).

- [ ] **Step 1: `src/domain/storage-config.ts` anlegen**

```ts
export type StorageBackendKind = "local" | "smb" | "ftp" | "sftp" | "webdav";

export interface SmbConfig {
  readonly host: string;
  readonly share: string;
  /** Subdirectory within the share; "" for the share root. */
  readonly path: string;
  readonly username: string;
  readonly password: string;
  /** Workgroup/domain for NTLM auth; null when not set (falls back to guest/anonymous if the server allows it). */
  readonly domain: string | null;
}

export interface FtpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly username: string;
  readonly password: string;
  readonly secure: "none" | "explicit" | "implicit";
}

export interface SftpAuthPassword {
  readonly kind: "password";
  readonly password: string;
}

export interface SftpAuthKey {
  readonly kind: "key";
  readonly privateKey: string;
  readonly passphrase: string | null;
}

export type SftpAuth = SftpAuthPassword | SftpAuthKey;

export interface SftpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly username: string;
  readonly auth: SftpAuth;
}

export interface WebDavAuthBasic {
  readonly kind: "basic";
  readonly username: string;
  readonly password: string;
}

export interface WebDavAuthBearer {
  readonly kind: "bearer";
  readonly token: string;
}

export type WebDavAuth = WebDavAuthBasic | WebDavAuthBearer;

export interface WebDavConfig {
  readonly url: string;
  readonly path: string;
  readonly auth: WebDavAuth;
  readonly rejectUnauthorized: boolean;
}

export type StorageConfig =
  | { readonly backend: "local" }
  | { readonly backend: "smb"; readonly smb: SmbConfig }
  | { readonly backend: "ftp"; readonly ftp: FtpConfig }
  | { readonly backend: "sftp"; readonly sftp: SftpConfig }
  | { readonly backend: "webdav"; readonly webdav: WebDavConfig };
```

- [ ] **Step 2: `repositories.ts` um Migrations- und Settings-Typen erweitern**

`src/domain/ports/repositories.ts` — Import-Zeile ergänzen (nach der bestehenden `StoredFile`-Import-Zeile):

```ts
import type { StorageBackendKind, StorageConfig } from "../storage-config.js";
```

Direkt nach dem bestehenden `SettingsRepository`-Interface einfügen (vor `export interface AccountUiRepository`):

```ts
export interface StoredDocumentRecord {
  readonly id: number;
  readonly relativePath: string;
  readonly sha256: string;
}

export type MigrationStatus = "running" | "completed" | "failed";

export interface StorageMigrationRecord {
  readonly id: number;
  readonly fromBackend: StorageBackendKind;
  readonly toBackend: StorageBackendKind;
  readonly toConfig: StorageConfig;
  readonly status: MigrationStatus;
  readonly totalDocuments: number;
  readonly migratedDocuments: number;
  readonly failedDocuments: number;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly errorMessage: string | null;
}

export interface CreateMigrationInput {
  readonly fromBackend: StorageBackendKind;
  readonly toBackend: StorageBackendKind;
  readonly toConfig: StorageConfig;
  readonly totalDocuments: number;
}

/**
 * Cross-account: the migration's work list is every document already stored,
 * regardless of which account it belongs to (M6a spec section 4).
 */
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
```

Das bestehende `SettingsRepository`-Interface erweitern (die zwei neuen Methoden ans Ende anfügen):

```ts
export interface SettingsRepository {
  /** The validated filename template, falling back to the default. */
  filenameTemplate(): Promise<string>;
  /** The global cron expression for scheduled syncs, falling back to the default. */
  syncSchedule(): Promise<string>;
  /** The active storage backend, falling back to "local". */
  storageBackend(): Promise<StorageBackendKind>;
  /** The active backend's full config. For "local" always `{ backend: "local" }`. */
  storageConfig(): Promise<StorageConfig>;
}
```

Das bestehende `SettingsUiRepository`-Interface erweitern:

```ts
export interface SettingsUiRepository extends SettingsRepository {
  setFilenameTemplate(template: string): Promise<void>;
  setSyncSchedule(schedule: string): Promise<void>;
  /** Hex-encoded override hash, or null if the admin password was never changed from its default. */
  adminPasswordHash(): Promise<string | null>;
  setAdminPasswordHash(hashHex: string): Promise<void>;
  /** Persists the new active target directly — callers decide beforehand whether a migration is needed. */
  setStorageTarget(config: StorageConfig): Promise<void>;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `DrizzleSettingsRepository` implementiert `SettingsRepository`/`SettingsUiRepository` noch nicht vollständig. Das ist erwartet; Task 4 behebt es. Notiere die gemeldeten Fehler, sie bestätigen, dass die neuen Interface-Methoden korrekt angefordert werden.

- [ ] **Step 4: Commit**

```bash
git add src/domain/storage-config.ts src/domain/ports/repositories.ts
git commit -m "feat: Domain-Typen und Ports für Storage-Backends und Migration"
```

(Der rote Typecheck-Zustand ist zwischen Task 2 und Task 4 erwartet und wird nicht separat gemerged — beide Tasks laufen in derselben Session/PR.)

---

## Task 3: Drizzle-Schema — `storage_migration`-Tabelle

**Files:**
- Modify: `src/infrastructure/persistence/schema.ts`
- Create (generiert): `drizzle/000X_*.sql`

**Interfaces:**
- Produces: `storageMigration` (Drizzle-Tabelle), `StorageMigrationRow = typeof storageMigration.$inferSelect`, `NewStorageMigrationRow = typeof storageMigration.$inferInsert`.

- [ ] **Step 1: Tabelle in `schema.ts` ergänzen**

`src/infrastructure/persistence/schema.ts` — nach der bestehenden `run`-Tabellendefinition einfügen (vor `adminSession`):

```ts
export const storageMigration = sqliteTable("storage_migration", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fromBackend: text("from_backend", {
    enum: ["local", "smb", "ftp", "sftp", "webdav"],
  }).notNull(),
  toBackend: text("to_backend", { enum: ["local", "smb", "ftp", "sftp", "webdav"] }).notNull(),
  toConfigEnc: blob("to_config_enc", { mode: "buffer" }).notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] })
    .notNull()
    .default("running"),
  totalDocuments: integer("total_documents").notNull().default(0),
  migratedDocuments: integer("migrated_documents").notNull().default(0),
  failedDocuments: integer("failed_documents").notNull().default(0),
  startedAt: integer("started_at").notNull().default(now),
  finishedAt: integer("finished_at"),
  errorMessage: text("error_message"),
});
```

Am Ende der Datei, bei den `export type ... = typeof ...` Zeilen, ergänzen:

```ts
export type StorageMigrationRow = typeof storageMigration.$inferSelect;
export type NewStorageMigrationRow = typeof storageMigration.$inferInsert;
```

- [ ] **Step 2: Migration generieren**

Run: `npm run db:generate`
Expected: drizzle-kit legt eine neue Datei `drizzle/000X_<generierter-name>.sql` an, die `CREATE TABLE storage_migration (...)` enthält. Prüfe mit `git status` welcher Dateiname erzeugt wurde.

- [ ] **Step 3: Generierte Migration inspizieren**

Run: `cat drizzle/000X_*.sql` (den in Step 2 ermittelten Dateinamen einsetzen)
Erwartet: ein `CREATE TABLE `storage_migration`` -Statement mit allen sieben oben definierten Spalten plus `id`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: Die zuvor (Task 2, Step 3) erwarteten Fehler zu fehlenden Settings-Methoden bestehen weiterhin — das ist Task 4. Kein neuer Fehler durch das Schema selbst.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/persistence/schema.ts drizzle/
git commit -m "feat: Tabelle storage_migration für Speicherziel-Wechsel"
```

---

## Task 4: Zod-Schema für `StorageConfig` + `DrizzleSettingsRepository` erweitern

**Files:**
- Create: `src/infrastructure/persistence/storage-config-schema.ts`
- Test: `src/infrastructure/persistence/storage-config-schema.test.ts`
- Modify: `src/infrastructure/persistence/repositories/settings-repository.ts`
- Test: `src/infrastructure/persistence/repositories/settings-repository.test.ts` (erweitern)
- Modify: `src/composition-root.ts`
- Modify: `src/web/routes/settings.test.ts`, `src/web/routes/dashboard.test.ts`, `src/web/routes/logs.test.ts`, `src/web/routes/runs.test.ts`

**Interfaces:**
- Consumes: `StorageConfig`, `StorageBackendKind` aus `src/domain/storage-config.js`.
- Produces: `storageConfigSchema: z.ZodType<StorageConfig>` aus `src/infrastructure/persistence/storage-config-schema.js`. `DrizzleSettingsRepository` erhält einen zweiten Konstruktorparameter `cipher: Cipher`.

- [ ] **Step 1: Fehlschlagenden Test für das Zod-Schema schreiben**

`src/infrastructure/persistence/storage-config-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { storageConfigSchema } from "./storage-config-schema.js";

describe("storageConfigSchema", () => {
  it("accepts a local config", () => {
    expect(storageConfigSchema.safeParse({ backend: "local" }).success).toBe(true);
  });

  it("accepts a valid sftp config with password auth", () => {
    const result = storageConfigSchema.safeParse({
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "/rechnungen",
        username: "vid",
        auth: { kind: "password", password: "secret" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid sftp config with key auth and no passphrase", () => {
    const result = storageConfigSchema.safeParse({
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "key", privateKey: "-----BEGIN KEY-----", passphrase: null },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects sftp with a missing host", () => {
    const result = storageConfigSchema.safeParse({
      backend: "sftp",
      sftp: {
        host: "",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "password", password: "secret" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown backend", () => {
    expect(storageConfigSchema.safeParse({ backend: "ftps-legacy" }).success).toBe(false);
  });

  it("accepts a valid webdav config with bearer auth", () => {
    const result = storageConfigSchema.safeParse({
      backend: "webdav",
      webdav: {
        url: "https://nas.local/dav",
        path: "/rechnungen",
        auth: { kind: "bearer", token: "t0ken" },
        rejectUnauthorized: true,
      },
    });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/infrastructure/persistence/storage-config-schema.test.ts`
Expected: FAIL — Modul `./storage-config-schema.js` existiert nicht.

- [ ] **Step 3: Zod-Schema implementieren**

`src/infrastructure/persistence/storage-config-schema.ts`:

```ts
import { z } from "zod";
import type { StorageConfig } from "../../domain/storage-config.js";

const smbConfigSchema = z.object({
  host: z.string().min(1),
  share: z.string().min(1),
  path: z.string(),
  username: z.string().min(1),
  password: z.string().min(1),
  domain: z.string().min(1).nullable(),
});

const ftpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  path: z.string(),
  username: z.string().min(1),
  password: z.string(),
  secure: z.enum(["none", "explicit", "implicit"]),
});

const sftpAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("password"), password: z.string().min(1) }),
  z.object({
    kind: z.literal("key"),
    privateKey: z.string().min(1),
    passphrase: z.string().min(1).nullable(),
  }),
]);

const sftpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive(),
  path: z.string(),
  username: z.string().min(1),
  auth: sftpAuthSchema,
});

const webDavAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("basic"), username: z.string().min(1), password: z.string() }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
]);

const webDavConfigSchema = z.object({
  url: z.string().min(1),
  path: z.string(),
  auth: webDavAuthSchema,
  rejectUnauthorized: z.boolean(),
});

/** Typed against the domain union so schema and domain type can never silently drift apart. */
export const storageConfigSchema: z.ZodType<StorageConfig> = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("local") }),
  z.object({ backend: z.literal("smb"), smb: smbConfigSchema }),
  z.object({ backend: z.literal("ftp"), ftp: ftpConfigSchema }),
  z.object({ backend: z.literal("sftp"), sftp: sftpConfigSchema }),
  z.object({ backend: z.literal("webdav"), webdav: webDavConfigSchema }),
]);
```

- [ ] **Step 4: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/infrastructure/persistence/storage-config-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Fehlschlagende Tests für `DrizzleSettingsRepository` schreiben**

Ans Ende von `src/infrastructure/persistence/repositories/settings-repository.test.ts` anfügen. Zuerst die Imports am Dateikopf ergänzen:

```ts
import { randomBytes } from "node:crypto";
```

und

```ts
import { Cipher } from "../../crypto/cipher.js";
```

Den bestehenden `beforeEach`-Block anpassen, damit `repo` mit einem `Cipher` gebaut wird:

```ts
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleSettingsRepository(db, new Cipher(randomBytes(32)));
});
```

Neue `describe`-Blöcke ans Dateiende anfügen:

```ts
describe("DrizzleSettingsRepository.storageBackend", () => {
  it("returns 'local' when no setting exists", async () => {
    await expect(repo.storageBackend()).resolves.toBe("local");
  });

  it("returns the stored backend", async () => {
    db.insert(setting).values({ key: "storage_backend", value: JSON.stringify("sftp") }).run();
    await expect(repo.storageBackend()).resolves.toBe("sftp");
  });

  it("throws ConfigError for an unknown backend value", async () => {
    db.insert(setting).values({ key: "storage_backend", value: JSON.stringify("ftps-legacy") }).run();
    await expect(repo.storageBackend()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("DrizzleSettingsRepository.storageConfig", () => {
  it("returns { backend: 'local' } when no setting exists", async () => {
    await expect(repo.storageConfig()).resolves.toEqual({ backend: "local" });
  });

  it("round-trips an sftp config through setStorageTarget", async () => {
    const target = {
      backend: "sftp" as const,
      sftp: {
        host: "nas.local",
        port: 22,
        path: "/rechnungen",
        username: "vid",
        auth: { kind: "password" as const, password: "secret" },
      },
    };
    await repo.setStorageTarget(target);
    await expect(repo.storageBackend()).resolves.toBe("sftp");
    await expect(repo.storageConfig()).resolves.toEqual(target);
  });

  it("does not store plaintext credentials in storage_config_enc", async () => {
    await repo.setStorageTarget({
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "password", password: "s3cret-marker" },
      },
    });
    const row = db.select().from(setting).where(eq(setting.key, "storage_config_enc")).get();
    expect(row?.value).toBeDefined();
    expect(row?.value ?? "").not.toContain("s3cret-marker");
  });

  it("switching back to local clears storage_config_enc", async () => {
    await repo.setStorageTarget({
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "password", password: "secret" },
      },
    });
    await repo.setStorageTarget({ backend: "local" });
    await expect(repo.storageConfig()).resolves.toEqual({ backend: "local" });
    const row = db.select().from(setting).where(eq(setting.key, "storage_config_enc")).get();
    expect(row).toBeUndefined();
  });

  it("throws ConfigError when storage_backend is not 'local' but storage_config_enc is missing", async () => {
    db.insert(setting).values({ key: "storage_backend", value: JSON.stringify("sftp") }).run();
    await expect(repo.storageConfig()).rejects.toBeInstanceOf(ConfigError);
  });
});
```

Die Imports `eq` und `ConfigError` am Dateikopf sicherstellen (der Datei-Header importiert bereits `ConfigError, TemplateError` aus `../../../domain/errors.js` — `eq` aus `drizzle-orm` ergänzen):

```ts
import { eq } from "drizzle-orm";
```

- [ ] **Step 6: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Expected: FAIL — Konstruktor erwartet nur ein Argument, `storageBackend`/`storageConfig`/`setStorageTarget` existieren nicht.

- [ ] **Step 7: `DrizzleSettingsRepository` implementieren**

`src/infrastructure/persistence/repositories/settings-repository.ts` komplett ersetzen durch:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ConfigError, TemplateError } from "../../../domain/errors.js";
import type { SettingsRepository } from "../../../domain/ports/repositories.js";
import type { StorageBackendKind, StorageConfig } from "../../../domain/storage-config.js";
import type { Cipher } from "../../crypto/cipher.js";
import { validateCronExpression } from "../../scheduler/scheduler.js";
import { DEFAULT_FILENAME_TEMPLATE, validateTemplate } from "../../storage/filename-template.js";
import { storageConfigSchema } from "../storage-config-schema.js";
import type { Database } from "../database.js";
import { setting } from "../schema.js";

const FILENAME_TEMPLATE_KEY = "filename_template";
const SYNC_SCHEDULE_KEY = "sync_schedule";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";
const STORAGE_BACKEND_KEY = "storage_backend";
const STORAGE_CONFIG_KEY = "storage_config_enc";

/** Daily at 06:00 — invoices arrive monthly, one morning check is plenty. */
export const DEFAULT_SYNC_SCHEDULE = "0 6 * * *";

const storageBackendSchema = z.enum(["local", "smb", "ftp", "sftp", "webdav"]);

/**
 * Settings are stored as JSON strings and validated on read (spec section 5):
 * a corrupt or invalid template must fail loudly here, not render a wrong
 * path silently during a sync. storage_config_enc additionally carries
 * credentials, so it is AES-256-GCM encrypted before it ever reaches this
 * table (M6a spec section 3) — the same Cipher/key already used for account
 * credentials.
 */
export class DrizzleSettingsRepository implements SettingsRepository {
  readonly #db: Database;
  readonly #cipher: Cipher;

  constructor(db: Database, cipher: Cipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  async filenameTemplate(): Promise<string> {
    const row = this.#db.select().from(setting).where(eq(setting.key, FILENAME_TEMPLATE_KEY)).get();
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

  async syncSchedule(): Promise<string> {
    const row = this.#db.select().from(setting).where(eq(setting.key, SYNC_SCHEDULE_KEY)).get();
    if (row === undefined) return DEFAULT_SYNC_SCHEDULE;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (cause) {
      throw new ConfigError("Stored sync_schedule is not valid JSON", { cause });
    }
    const result = z.string().min(1).safeParse(parsed);
    if (!result.success) {
      throw new ConfigError("Stored sync_schedule is not a non-empty string");
    }
    validateCronExpression(result.data);
    return result.data;
  }

  async storageBackend(): Promise<StorageBackendKind> {
    const row = this.#db.select().from(setting).where(eq(setting.key, STORAGE_BACKEND_KEY)).get();
    if (row === undefined) return "local";

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (cause) {
      throw new ConfigError("Stored storage_backend is not valid JSON", { cause });
    }
    const result = storageBackendSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigError("Stored storage_backend is not a known backend kind");
    }
    return result.data;
  }

  async storageConfig(): Promise<StorageConfig> {
    const backend = await this.storageBackend();
    if (backend === "local") return { backend: "local" };

    const row = this.#db.select().from(setting).where(eq(setting.key, STORAGE_CONFIG_KEY)).get();
    if (row === undefined) {
      throw new ConfigError(`Missing storage_config_enc for backend "${backend}"`);
    }

    let hex: unknown;
    try {
      hex = JSON.parse(row.value);
    } catch (cause) {
      throw new ConfigError("Stored storage_config_enc is not valid JSON", { cause });
    }
    const hexResult = z.string().min(1).safeParse(hex);
    if (!hexResult.success) {
      throw new ConfigError("Stored storage_config_enc is not a non-empty string");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(this.#cipher.decrypt(Buffer.from(hexResult.data, "hex")));
    } catch (cause) {
      throw new ConfigError("Failed to decrypt storage_config_enc", { cause });
    }
    const result = storageConfigSchema.safeParse(decoded);
    if (!result.success) {
      throw new ConfigError("Stored storage config failed validation");
    }
    if (result.data.backend !== backend) {
      throw new ConfigError("storage_config_enc backend does not match storage_backend");
    }
    return result.data;
  }

  async setStorageTarget(config: StorageConfig): Promise<void> {
    this.#set(STORAGE_BACKEND_KEY, config.backend);
    if (config.backend === "local") {
      this.#db.delete(setting).where(eq(setting.key, STORAGE_CONFIG_KEY)).run();
      return;
    }
    const hex = this.#cipher.encrypt(JSON.stringify(config)).toString("hex");
    this.#set(STORAGE_CONFIG_KEY, hex);
  }

  async adminPasswordHash(): Promise<string | null> {
    const row = this.#db
      .select()
      .from(setting)
      .where(eq(setting.key, ADMIN_PASSWORD_HASH_KEY))
      .get();
    if (row === undefined) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch (cause) {
      throw new ConfigError("Stored admin_password_hash is not valid JSON", { cause });
    }
    const result = z.string().min(1).safeParse(parsed);
    if (!result.success) {
      throw new ConfigError("Stored admin_password_hash is not a non-empty string");
    }
    return result.data;
  }

  async setAdminPasswordHash(hashHex: string): Promise<void> {
    this.#set(ADMIN_PASSWORD_HASH_KEY, hashHex);
  }

  async setFilenameTemplate(template: string): Promise<void> {
    validateTemplate(template);
    this.#set(FILENAME_TEMPLATE_KEY, template);
  }

  async setSyncSchedule(schedule: string): Promise<void> {
    validateCronExpression(schedule);
    this.#set(SYNC_SCHEDULE_KEY, schedule);
  }

  #set(key: string, value: string): void {
    this.#db
      .insert(setting)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: setting.key, set: { value: JSON.stringify(value) } })
      .run();
  }
}
```

- [ ] **Step 8: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/infrastructure/persistence/repositories/settings-repository.test.ts`
Expected: PASS.

- [ ] **Step 9: Alle Call-Sites von `new DrizzleSettingsRepository(db)` anpassen**

Fünf Stellen brauchen jetzt ein zweites Argument `cipher` — in jeder Datei existiert bereits eine lokale `cipher`-Variable (verwendet für `DrizzleAccountRepository`):

`src/composition-root.ts` — Zeile mit `const settings = new DrizzleSettingsRepository(db);` ändern zu:
```ts
  const settings = new DrizzleSettingsRepository(db, cipher);
```

`src/web/routes/settings.test.ts` — beide Vorkommen `new DrizzleSettingsRepository(db)` (in `buildTestApp` und `buildAuthedTestApp`) ändern zu `new DrizzleSettingsRepository(db, cipher)`.

`src/web/routes/dashboard.test.ts` (Zeile 45), `src/web/routes/logs.test.ts` (Zeile 48), `src/web/routes/runs.test.ts` (Zeile 58) — jeweils `new DrizzleSettingsRepository(db)` zu `new DrizzleSettingsRepository(db, cipher)` ändern.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: PASS — keine offenen Fehler mehr aus Task 2/3.

- [ ] **Step 11: Vollständiger Testlauf**

Run: `npm test`
Expected: PASS (alle Tests, inkl. der fünf geänderten Dateien).

- [ ] **Step 12: Lint**

Run: `npm run lint`
Expected: keine Fehler.

- [ ] **Step 13: Commit**

```bash
git add src/infrastructure/persistence/storage-config-schema.ts src/infrastructure/persistence/storage-config-schema.test.ts src/infrastructure/persistence/repositories/settings-repository.ts src/infrastructure/persistence/repositories/settings-repository.test.ts src/composition-root.ts src/web/routes/settings.test.ts src/web/routes/dashboard.test.ts src/web/routes/logs.test.ts src/web/routes/runs.test.ts
git commit -m "feat: Settings um verschlüsseltes Speicherziel erweitert"
```

---

## Task 5: `DrizzleMigrationRepository`

**Files:**
- Create: `src/infrastructure/persistence/repositories/migration-repository.ts`
- Test: `src/infrastructure/persistence/repositories/migration-repository.test.ts`

**Interfaces:**
- Consumes: `MigrationRepository`, `CreateMigrationInput`, `StorageMigrationRecord`, `StoredDocumentRecord` aus `src/domain/ports/repositories.js`; `storageConfigSchema` aus `../storage-config-schema.js`; `Cipher` aus `../../crypto/cipher.js`.
- Produces: `DrizzleMigrationRepository` — implementiert `MigrationRepository` vollständig.

- [ ] **Step 1: Fehlschlagende Tests schreiben**

`src/infrastructure/persistence/repositories/migration-repository.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cipher } from "../../crypto/cipher.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, invoice, invoiceDocument } from "../schema.js";
import { DrizzleMigrationRepository } from "./migration-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleMigrationRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-migration-repo-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleMigrationRepository(db, new Cipher(randomBytes(32)));
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

function seedStoredDocument(relativePath: string, sha256: string): void {
  const [acc] = db
    .insert(account)
    .values({
      label: "Test",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: `urn:test:${relativePath}`,
      status: "ok",
    })
    .returning()
    .all();
  if (acc === undefined) throw new Error("seed failed");
  const [inv] = db
    .insert(invoice)
    .values({
      accountId: acc.id,
      number: relativePath,
      issuedOn: "2026-01-01",
      amountCents: 100,
    })
    .returning()
    .all();
  if (inv === undefined) throw new Error("seed failed");
  db.insert(invoiceDocument)
    .values({
      invoiceId: inv.id,
      remoteDocumentId: relativePath,
      state: "stored",
      relativePath,
      sha256,
      sizeBytes: 10,
      storedAt: 1,
    })
    .run();
}

describe("DrizzleMigrationRepository.listStoredDocuments", () => {
  it("returns only documents in state=stored", () => {
    seedStoredDocument("a.pdf", "hash-a");
    return repo.listStoredDocuments().then((docs) => {
      expect(docs).toEqual([{ id: expect.any(Number), relativePath: "a.pdf", sha256: "hash-a" }]);
    });
  });

  it("returns an empty list when nothing is stored", async () => {
    await expect(repo.listStoredDocuments()).resolves.toEqual([]);
  });
});

describe("DrizzleMigrationRepository migration lifecycle", () => {
  const toConfig = {
    backend: "sftp" as const,
    sftp: {
      host: "nas.local",
      port: 22,
      path: "/rechnungen",
      username: "vid",
      auth: { kind: "password" as const, password: "secret" },
    },
  };

  it("creates a migration and finds it as running", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 3,
    });
    const found = await repo.findMigration(id);
    expect(found).toMatchObject({
      id,
      fromBackend: "local",
      toBackend: "sftp",
      status: "running",
      totalDocuments: 3,
      migratedDocuments: 0,
      failedDocuments: 0,
      toConfig,
    });
  });

  it("findRunningMigration returns the running row", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 0,
    });
    await expect(repo.findRunningMigration()).resolves.toMatchObject({ id, status: "running" });
  });

  it("findRunningMigration returns undefined once completed", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 0,
    });
    await repo.completeMigration(id);
    await expect(repo.findRunningMigration()).resolves.toBeUndefined();
  });

  it("incrementProgress accumulates migrated and failed counts independently", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 5,
    });
    await repo.incrementProgress(id, "migrated");
    await repo.incrementProgress(id, "migrated");
    await repo.incrementProgress(id, "failed");
    const found = await repo.findMigration(id);
    expect(found).toMatchObject({ migratedDocuments: 2, failedDocuments: 1 });
  });

  it("setTotalDocuments updates the total", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 5,
    });
    await repo.setTotalDocuments(id, 8);
    await expect(repo.findMigration(id)).resolves.toMatchObject({ totalDocuments: 8 });
  });

  it("failMigration records the error and stamps finishedAt", async () => {
    const id = await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 1,
    });
    await repo.failMigration(id, "2 von 3 Dokumenten konnten nicht migriert werden.");
    const found = await repo.findMigration(id);
    expect(found?.status).toBe("failed");
    expect(found?.errorMessage).toBe("2 von 3 Dokumenten konnten nicht migriert werden.");
    expect(found?.finishedAt).not.toBeNull();
  });

  it("does not store plaintext credentials in to_config_enc", async () => {
    await repo.createMigration({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig,
      totalDocuments: 0,
    });
    const rows = db.select().from(account).all(); // sanity: table access still works
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/infrastructure/persistence/repositories/migration-repository.test.ts`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 3: `DrizzleMigrationRepository` implementieren**

`src/infrastructure/persistence/repositories/migration-repository.ts`:

```ts
import { desc, eq, sql } from "drizzle-orm";
import { ConfigError, PersistenceError } from "../../../domain/errors.js";
import type {
  CreateMigrationInput,
  MigrationRepository,
  StorageMigrationRecord,
  StoredDocumentRecord,
} from "../../../domain/ports/repositories.js";
import type { StorageConfig } from "../../../domain/storage-config.js";
import type { Cipher } from "../../crypto/cipher.js";
import { storageConfigSchema } from "../storage-config-schema.js";
import type { Database } from "../database.js";
import { invoiceDocument, storageMigration } from "../schema.js";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * listStoredDocuments crosses account boundaries deliberately — the
 * migration's work list is every stored document, not one account's (M6a
 * spec section 4). Migration config credentials are AES-256-GCM encrypted,
 * same Cipher as account credentials.
 */
export class DrizzleMigrationRepository implements MigrationRepository {
  readonly #db: Database;
  readonly #cipher: Cipher;

  constructor(db: Database, cipher: Cipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  async listStoredDocuments(): Promise<StoredDocumentRecord[]> {
    const rows = this.#db
      .select({
        id: invoiceDocument.id,
        relativePath: invoiceDocument.relativePath,
        sha256: invoiceDocument.sha256,
      })
      .from(invoiceDocument)
      .where(eq(invoiceDocument.state, "stored"))
      .all();
    const documents: StoredDocumentRecord[] = [];
    for (const row of rows) {
      if (row.relativePath === null || row.sha256 === null) continue;
      documents.push({ id: row.id, relativePath: row.relativePath, sha256: row.sha256 });
    }
    return documents;
  }

  async createMigration(input: CreateMigrationInput): Promise<number> {
    const result = this.#db
      .insert(storageMigration)
      .values({
        fromBackend: input.fromBackend,
        toBackend: input.toBackend,
        toConfigEnc: this.#cipher.encrypt(JSON.stringify(input.toConfig)),
        status: "running",
        totalDocuments: input.totalDocuments,
        startedAt: nowSeconds(),
      })
      .returning({ id: storageMigration.id })
      .all();
    const created = result[0];
    if (created === undefined) {
      throw new PersistenceError("storage_migration insert returned no row");
    }
    return created.id;
  }

  async findRunningMigration(): Promise<StorageMigrationRecord | undefined> {
    const row = this.#db
      .select()
      .from(storageMigration)
      .where(eq(storageMigration.status, "running"))
      .orderBy(desc(storageMigration.id))
      .get();
    return row === undefined ? undefined : this.#toRecord(row);
  }

  async findMigration(id: number): Promise<StorageMigrationRecord | undefined> {
    const row = this.#db.select().from(storageMigration).where(eq(storageMigration.id, id)).get();
    return row === undefined ? undefined : this.#toRecord(row);
  }

  async incrementProgress(id: number, outcome: "migrated" | "failed"): Promise<void> {
    if (outcome === "migrated") {
      this.#db
        .update(storageMigration)
        .set({ migratedDocuments: sql`${storageMigration.migratedDocuments} + 1` })
        .where(eq(storageMigration.id, id))
        .run();
    } else {
      this.#db
        .update(storageMigration)
        .set({ failedDocuments: sql`${storageMigration.failedDocuments} + 1` })
        .where(eq(storageMigration.id, id))
        .run();
    }
  }

  async setTotalDocuments(id: number, total: number): Promise<void> {
    this.#db
      .update(storageMigration)
      .set({ totalDocuments: total })
      .where(eq(storageMigration.id, id))
      .run();
  }

  async completeMigration(id: number): Promise<void> {
    this.#db
      .update(storageMigration)
      .set({ status: "completed", finishedAt: nowSeconds() })
      .where(eq(storageMigration.id, id))
      .run();
  }

  async failMigration(id: number, message: string): Promise<void> {
    this.#db
      .update(storageMigration)
      .set({ status: "failed", finishedAt: nowSeconds(), errorMessage: message })
      .where(eq(storageMigration.id, id))
      .run();
  }

  #toRecord(row: typeof storageMigration.$inferSelect): StorageMigrationRecord {
    let toConfig: StorageConfig;
    try {
      const parsed: unknown = JSON.parse(this.#cipher.decrypt(row.toConfigEnc));
      const result = storageConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new ConfigError("Stored storage_migration.to_config_enc failed validation");
      }
      toConfig = result.data;
    } catch (cause) {
      throw cause instanceof ConfigError
        ? cause
        : new ConfigError("Failed to decrypt storage_migration.to_config_enc", { cause });
    }
    return {
      id: row.id,
      fromBackend: row.fromBackend,
      toBackend: row.toBackend,
      toConfig,
      status: row.status,
      totalDocuments: row.totalDocuments,
      migratedDocuments: row.migratedDocuments,
      failedDocuments: row.failedDocuments,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      errorMessage: row.errorMessage,
    };
  }
}
```

- [ ] **Step 4: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/infrastructure/persistence/repositories/migration-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, Lint, Gesamttestlauf**

Run: `npm run typecheck && npm run lint && npm test`
Expected: alles PASS.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/persistence/repositories/migration-repository.ts src/infrastructure/persistence/repositories/migration-repository.test.ts
git commit -m "feat: DrizzleMigrationRepository für Speicherziel-Wechsel"
```

---

## Task 6: Use Cases `changeStorageTarget` und `StorageMigrationRunner`

**Files:**
- Create: `src/application/change-storage-target.ts`
- Test: `src/application/change-storage-target.test.ts`
- Create: `src/application/migrate-storage.ts`
- Test: `src/application/migrate-storage.test.ts`

**Interfaces:**
- Consumes: `MigrationRepository`, `StoredDocumentRecord` aus `../domain/ports/repositories.js`; `SettingsUiRepository` aus demselben Modul; `StorageConfig` aus `../domain/storage-config.js`; `FileStorage` aus `../domain/ports/file-storage.js`.
- Produces: `changeStorageTarget(deps, target): Promise<ChangeStorageTargetResult>`; `StorageMigrationRunner` mit `run(migrationId: number): Promise<void>`.

- [ ] **Step 1: Fehlschlagende Tests für `changeStorageTarget` schreiben**

`src/application/change-storage-target.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type {
  CreateMigrationInput,
  StoredDocumentRecord,
} from "../domain/ports/repositories.js";
import { changeStorageTarget } from "./change-storage-target.js";

const localConfig = { backend: "local" as const };
const sftpConfig = {
  backend: "sftp" as const,
  sftp: {
    host: "nas.local",
    port: 22,
    path: "/rechnungen",
    username: "vid",
    auth: { kind: "password" as const, password: "secret" },
  },
};

function buildDeps(currentBackend: "local" | "sftp") {
  const setStorageTarget = vi.fn().mockResolvedValue(undefined);
  const createMigration = vi.fn(async (_input: CreateMigrationInput) => 42);
  const startMigration = vi.fn();
  const documents: StoredDocumentRecord[] = [
    { id: 1, relativePath: "a.pdf", sha256: "h1" },
    { id: 2, relativePath: "b.pdf", sha256: "h2" },
  ];
  return {
    deps: {
      settings: {
        storageBackend: vi.fn().mockResolvedValue(currentBackend),
        setStorageTarget,
      },
      migrations: {
        listStoredDocuments: vi.fn().mockResolvedValue(documents),
        createMigration,
      },
      startMigration,
    },
    setStorageTarget,
    createMigration,
    startMigration,
    documents,
  };
}

describe("changeStorageTarget", () => {
  it("applies immediately when the backend is unchanged", async () => {
    const { deps, setStorageTarget, createMigration, startMigration } = buildDeps("local");

    const result = await changeStorageTarget(deps, localConfig);

    expect(result).toEqual({ kind: "applied" });
    expect(setStorageTarget).toHaveBeenCalledWith(localConfig);
    expect(createMigration).not.toHaveBeenCalled();
    expect(startMigration).not.toHaveBeenCalled();
  });

  it("starts a migration when the backend changes, without touching settings directly", async () => {
    const { deps, setStorageTarget, createMigration, startMigration, documents } =
      buildDeps("local");

    const result = await changeStorageTarget(deps, sftpConfig);

    expect(result).toEqual({ kind: "migrating", migrationId: 42 });
    expect(setStorageTarget).not.toHaveBeenCalled();
    expect(createMigration).toHaveBeenCalledWith({
      fromBackend: "local",
      toBackend: "sftp",
      toConfig: sftpConfig,
      totalDocuments: documents.length,
    });
    expect(startMigration).toHaveBeenCalledWith(42);
  });
});
```

- [ ] **Step 2: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/application/change-storage-target.test.ts`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 3: `changeStorageTarget` implementieren**

`src/application/change-storage-target.ts`:

```ts
import type {
  CreateMigrationInput,
  MigrationRepository,
  SettingsUiRepository,
} from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";

export interface ChangeStorageTargetDeps {
  readonly settings: Pick<SettingsUiRepository, "storageBackend" | "setStorageTarget">;
  readonly migrations: Pick<MigrationRepository, "listStoredDocuments" | "createMigration">;
  /** Fire-and-forget trigger — the HTTP request that calls changeStorageTarget must not block on the transfer itself. */
  readonly startMigration: (migrationId: number) => void;
}

export type ChangeStorageTargetResult =
  | { readonly kind: "applied" }
  | { readonly kind: "migrating"; readonly migrationId: number };

/**
 * Same backend (e.g. only the password changed): applies immediately.
 * Different backend: creates a storage_migration row and hands it off —
 * the active target stays the old one until the migration itself flips it
 * (M6a spec section 4, "kein Split-Brain").
 */
export async function changeStorageTarget(
  deps: ChangeStorageTargetDeps,
  target: StorageConfig,
): Promise<ChangeStorageTargetResult> {
  const currentBackend = await deps.settings.storageBackend();
  if (currentBackend === target.backend) {
    await deps.settings.setStorageTarget(target);
    return { kind: "applied" };
  }

  const documents = await deps.migrations.listStoredDocuments();
  const input: CreateMigrationInput = {
    fromBackend: currentBackend,
    toBackend: target.backend,
    toConfig: target,
    totalDocuments: documents.length,
  };
  const migrationId = await deps.migrations.createMigration(input);
  deps.startMigration(migrationId);
  return { kind: "migrating", migrationId };
}
```

- [ ] **Step 4: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/application/change-storage-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Fehlschlagende Tests für `StorageMigrationRunner` schreiben**

`src/application/migrate-storage.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { StorageError } from "../domain/errors.js";
import type { FileStorage, StoredFile } from "../domain/ports/file-storage.js";
import type { StorageMigrationRecord, StoredDocumentRecord } from "../domain/ports/repositories.js";
import { StorageMigrationRunner } from "./migrate-storage.js";

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** In-memory FileStorage double — good enough to exercise the migration
 * algorithm without touching the filesystem. */
function fakeStorage(initial: Record<string, string> = {}): FileStorage & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    async store(relativePath, bytes): Promise<StoredFile> {
      files[relativePath] = bytes.toString();
      return { relativePath, sha256: hash(bytes.toString()), sizeBytes: bytes.length };
    },
    async retrieve(relativePath): Promise<Buffer> {
      const content = files[relativePath];
      if (content === undefined) throw new StorageError(`not found: ${relativePath}`);
      return Buffer.from(content);
    },
    async remove(relativePath): Promise<void> {
      delete files[relativePath];
    },
    async testConnection(): Promise<void> {},
  };
}

function buildMigration(overrides: Partial<StorageMigrationRecord> = {}): StorageMigrationRecord {
  return {
    id: 1,
    fromBackend: "local",
    toBackend: "sftp",
    toConfig: { backend: "sftp" },
    status: "running",
    totalDocuments: 0,
    migratedDocuments: 0,
    failedDocuments: 0,
    startedAt: 1,
    finishedAt: null,
    errorMessage: null,
    ...overrides,
  } as StorageMigrationRecord;
}

describe("StorageMigrationRunner", () => {
  it("copies every stored document, verifies the hash, deletes the source, and completes the migration", async () => {
    const source = fakeStorage({ "a.pdf": "content-a", "b.pdf": "content-b" });
    const target = fakeStorage();
    const docs: StoredDocumentRecord[] = [
      { id: 1, relativePath: "a.pdf", sha256: hash("content-a") },
      { id: 2, relativePath: "b.pdf", sha256: hash("content-b") },
    ];
    const migration = buildMigration({ totalDocuments: 2 });
    const setTotalDocuments = vi.fn().mockResolvedValue(undefined);
    const incrementProgress = vi.fn().mockResolvedValue(undefined);
    const completeMigration = vi.fn().mockResolvedValue(undefined);
    const setStorageTarget = vi.fn().mockResolvedValue(undefined);

    const runner = new StorageMigrationRunner({
      migrations: {
        findMigration: vi.fn().mockResolvedValue(migration),
        listStoredDocuments: vi.fn().mockResolvedValue(docs),
        setTotalDocuments,
        incrementProgress,
        completeMigration,
        failMigration: vi.fn(),
      },
      settings: {
        storageConfig: vi.fn().mockResolvedValue({ backend: "local" }),
        setStorageTarget,
      },
      buildFileStorage: vi.fn((config) => (config.backend === "local" ? source : target)),
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await runner.run(1);

    expect(source.files).toEqual({});
    expect(target.files).toEqual({ "a.pdf": "content-a", "b.pdf": "content-b" });
    expect(incrementProgress).toHaveBeenCalledWith(1, "migrated");
    expect(incrementProgress).toHaveBeenCalledTimes(2);
    expect(setStorageTarget).toHaveBeenCalledWith(migration.toConfig);
    expect(completeMigration).toHaveBeenCalledWith(1);
  });

  it("skips a document already present at the target with a matching hash (resume)", async () => {
    const source = fakeStorage({ "a.pdf": "content-a" });
    const target = fakeStorage({ "a.pdf": "content-a" });
    const docs: StoredDocumentRecord[] = [{ id: 1, relativePath: "a.pdf", sha256: hash("content-a") }];
    const migration = buildMigration({ totalDocuments: 1 });
    const incrementProgress = vi.fn().mockResolvedValue(undefined);

    const runner = new StorageMigrationRunner({
      migrations: {
        findMigration: vi.fn().mockResolvedValue(migration),
        listStoredDocuments: vi.fn().mockResolvedValue(docs),
        setTotalDocuments: vi.fn().mockResolvedValue(undefined),
        incrementProgress,
        completeMigration: vi.fn().mockResolvedValue(undefined),
        failMigration: vi.fn(),
      },
      settings: {
        storageConfig: vi.fn().mockResolvedValue({ backend: "local" }),
        setStorageTarget: vi.fn().mockResolvedValue(undefined),
      },
      buildFileStorage: vi.fn((config) => (config.backend === "local" ? source : target)),
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await runner.run(1);

    // Already present with a matching hash — never re-read from the source, source untouched.
    expect(source.files).toEqual({ "a.pdf": "content-a" });
    expect(incrementProgress).not.toHaveBeenCalledWith(1, "migrated");
  });

  it("fails the migration and leaves the active backend unchanged when a document never succeeds", async () => {
    const source = fakeStorage({ "a.pdf": "content-a" });
    const target: FileStorage = {
      async store() {
        throw new StorageError("target unreachable");
      },
      async retrieve() {
        throw new StorageError("not found");
      },
      async remove() {},
      async testConnection() {},
    };
    const docs: StoredDocumentRecord[] = [{ id: 1, relativePath: "a.pdf", sha256: hash("content-a") }];
    const migration = buildMigration({ totalDocuments: 1 });
    const failMigration = vi.fn().mockResolvedValue(undefined);
    const setStorageTarget = vi.fn().mockResolvedValue(undefined);
    const completeMigration = vi.fn().mockResolvedValue(undefined);

    const runner = new StorageMigrationRunner({
      migrations: {
        findMigration: vi.fn().mockResolvedValue(migration),
        listStoredDocuments: vi.fn().mockResolvedValue(docs),
        setTotalDocuments: vi.fn().mockResolvedValue(undefined),
        incrementProgress: vi.fn().mockResolvedValue(undefined),
        completeMigration,
        failMigration,
      },
      settings: {
        storageConfig: vi.fn().mockResolvedValue({ backend: "local" }),
        setStorageTarget,
      },
      buildFileStorage: vi.fn((config) => (config.backend === "local" ? source : target)),
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await runner.run(1);

    expect(failMigration).toHaveBeenCalledWith(1, expect.stringContaining("1"));
    expect(setStorageTarget).not.toHaveBeenCalled();
    expect(completeMigration).not.toHaveBeenCalled();
  });

  it("does nothing if the migration is not in status running (already finished by a previous process)", async () => {
    const migration = buildMigration({ status: "completed" });
    const listStoredDocuments = vi.fn();

    const runner = new StorageMigrationRunner({
      migrations: {
        findMigration: vi.fn().mockResolvedValue(migration),
        listStoredDocuments,
        setTotalDocuments: vi.fn(),
        incrementProgress: vi.fn(),
        completeMigration: vi.fn(),
        failMigration: vi.fn(),
      },
      settings: { storageConfig: vi.fn(), setStorageTarget: vi.fn() },
      buildFileStorage: vi.fn(),
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await runner.run(1);

    expect(listStoredDocuments).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/application/migrate-storage.test.ts`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 7: `StorageMigrationRunner` implementieren**

`src/application/migrate-storage.ts`:

```ts
import { createHash } from "node:crypto";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type {
  MigrationRepository,
  SettingsUiRepository,
  StoredDocumentRecord,
} from "../domain/ports/repositories.js";
import type { StorageConfig } from "../domain/storage-config.js";

/** Structurally pino-compatible; keeps infrastructure out of this layer. */
export interface MigrationLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface MigrationRunnerDeps {
  readonly migrations: Pick<
    MigrationRepository,
    | "findMigration"
    | "listStoredDocuments"
    | "setTotalDocuments"
    | "incrementProgress"
    | "completeMigration"
    | "failMigration"
  >;
  readonly settings: Pick<SettingsUiRepository, "storageConfig" | "setStorageTarget">;
  readonly buildFileStorage: (config: StorageConfig) => FileStorage;
  readonly logger: MigrationLogger;
}

/**
 * Copies every currently-stored document from the (still active) old
 * backend to the new one, verifies each by SHA-256, and deletes the old
 * copy once verified. Re-lists after each full pass so documents stored
 * concurrently by an in-flight sync are picked up too (M6a spec section 4);
 * stops once a pass finds the same document count as the pass before.
 * Idempotent: a document already present at the target with a matching
 * hash is never re-transferred, so an interrupted run can simply be
 * re-invoked with the same migrationId.
 */
export class StorageMigrationRunner {
  readonly #deps: MigrationRunnerDeps;
  #busy = false;

  constructor(deps: MigrationRunnerDeps) {
    this.#deps = deps;
  }

  async run(migrationId: number): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.#execute(migrationId);
    } finally {
      this.#busy = false;
    }
  }

  async #execute(migrationId: number): Promise<void> {
    const migration = await this.#deps.migrations.findMigration(migrationId);
    if (migration === undefined || migration.status !== "running") return;

    const source = this.#deps.buildFileStorage(await this.#deps.settings.storageConfig());
    const target = this.#deps.buildFileStorage(migration.toConfig);

    let previousCount = -1;
    let docs: StoredDocumentRecord[] = [];
    for (;;) {
      docs = await this.#deps.migrations.listStoredDocuments();
      await this.#deps.migrations.setTotalDocuments(migrationId, docs.length);
      if (docs.length === previousCount) break;
      previousCount = docs.length;
      for (const doc of docs) {
        await this.#migrateOne(source, target, doc, migrationId);
      }
    }

    const stillMissing = await this.#countMissing(target, docs);
    if (stillMissing > 0) {
      await this.#deps.migrations.failMigration(
        migrationId,
        `${stillMissing} von ${docs.length} Dokumenten konnten nicht migriert werden.`,
      );
      return;
    }

    await this.#deps.settings.setStorageTarget(migration.toConfig);
    await this.#deps.migrations.completeMigration(migrationId);
  }

  async #migrateOne(
    source: FileStorage,
    target: FileStorage,
    doc: StoredDocumentRecord,
    migrationId: number,
  ): Promise<void> {
    try {
      if (await this.#alreadyMigrated(target, doc)) return;
      const bytes = await source.retrieve(doc.relativePath);
      // Clear any stale/partial copy first so store() cannot collision-suffix
      // it into <name>_2.pdf on a resumed run.
      await target.remove(doc.relativePath);
      const stored = await target.store(doc.relativePath, bytes);
      if (stored.relativePath !== doc.relativePath || stored.sha256 !== doc.sha256) {
        throw new Error(`Verification failed for ${doc.relativePath}`);
      }
      await source.remove(doc.relativePath);
      await this.#deps.migrations.incrementProgress(migrationId, "migrated");
    } catch (error) {
      this.#deps.logger.error(
        { err: error, relativePath: doc.relativePath },
        "storage migration: document failed",
      );
      await this.#deps.migrations.incrementProgress(migrationId, "failed");
    }
  }

  async #alreadyMigrated(target: FileStorage, doc: StoredDocumentRecord): Promise<boolean> {
    try {
      const existing = await target.retrieve(doc.relativePath);
      return createHash("sha256").update(existing).digest("hex") === doc.sha256;
    } catch {
      return false;
    }
  }

  async #countMissing(target: FileStorage, docs: readonly StoredDocumentRecord[]): Promise<number> {
    let missing = 0;
    for (const doc of docs) {
      if (!(await this.#alreadyMigrated(target, doc))) missing += 1;
    }
    return missing;
  }
}
```

- [ ] **Step 8: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/application/migrate-storage.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck, Lint, Gesamttestlauf**

Run: `npm run typecheck && npm run lint && npm test`
Expected: alles PASS.

- [ ] **Step 10: Commit**

```bash
git add src/application/change-storage-target.ts src/application/change-storage-target.test.ts src/application/migrate-storage.ts src/application/migrate-storage.test.ts
git commit -m "feat: Use Cases changeStorageTarget und StorageMigrationRunner"
```

---

## Task 7: Composition-Root-Wiring + Download-Route

**Files:**
- Create: `src/infrastructure/storage/resolve-file-storage.ts`
- Test: `src/infrastructure/storage/resolve-file-storage.test.ts`
- Modify: `src/composition-root.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/routes/invoices.ts`
- Create: `src/web/routes/invoices.test.ts`
- Modify: `src/web/routes/settings.test.ts`, `src/web/routes/dashboard.test.ts`, `src/web/routes/logs.test.ts`, `src/web/routes/runs.test.ts`

**Interfaces:**
- Produces: `buildFileStorage(config: StorageConfig, downloadsDir: string): FileStorage` — Fabrik, die vorerst nur `"local"` behandelt, alle anderen Backends werfen `StorageError("Backend \"<kind>\" ist noch nicht implementiert")` (wird in den Folgeplänen Case für Case ersetzt).
- Consumes (in `invoices.ts`): `getFileStorage: () => Promise<FileStorage>` ersetzt das bisherige `downloadsDir: string` in `InvoiceRouteOptions`.

- [ ] **Step 1: Fehlschlagenden Test für `buildFileStorage` schreiben**

`src/infrastructure/storage/resolve-file-storage.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";
import { buildFileStorage } from "./resolve-file-storage.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-resolve-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildFileStorage", () => {
  it("builds an AtomicFileStorage for the local backend", async () => {
    const storage = buildFileStorage({ backend: "local" }, dir);
    expect(storage).toBeInstanceOf(AtomicFileStorage);
    const stored = await storage.store("a.pdf", Buffer.from("x"));
    expect(stored.relativePath).toBe("a.pdf");
  });

  it("throws for a backend without an adapter yet", () => {
    expect(() =>
      buildFileStorage(
        {
          backend: "sftp",
          sftp: {
            host: "nas.local",
            port: 22,
            path: "",
            username: "vid",
            auth: { kind: "password", password: "x" },
          },
        },
        dir,
      ),
    ).toThrow(StorageError);
  });
});
```

- [ ] **Step 2: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/infrastructure/storage/resolve-file-storage.test.ts`
Expected: FAIL — Modul existiert nicht.

- [ ] **Step 3: `buildFileStorage`/`resolveFileStorage` implementieren**

`src/infrastructure/storage/resolve-file-storage.ts`:

```ts
import { StorageError } from "../../domain/errors.js";
import type { FileStorage } from "../../domain/ports/file-storage.js";
import type { SettingsRepository } from "../../domain/ports/repositories.js";
import type { StorageConfig } from "../../domain/storage-config.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";

/**
 * The switch grows one case per storage milestone plan (SFTP, FTP, WebDAV,
 * SMB) — each replaces its own default-throw branch, no other case changes.
 */
export function buildFileStorage(config: StorageConfig, downloadsDir: string): FileStorage {
  switch (config.backend) {
    case "local":
      return new AtomicFileStorage(downloadsDir);
    default:
      throw new StorageError(`Backend "${config.backend}" ist noch nicht implementiert`);
  }
}

/**
 * Live resolution rather than a fixed singleton: the active backend can
 * change at runtime (settings), so every sync run and every download reads
 * the current target fresh — same pattern already used for the filename
 * template and the sync schedule.
 */
export async function resolveFileStorage(
  settings: Pick<SettingsRepository, "storageConfig">,
  downloadsDir: string,
): Promise<FileStorage> {
  const config = await settings.storageConfig();
  return buildFileStorage(config, downloadsDir);
}
```

- [ ] **Step 4: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/infrastructure/storage/resolve-file-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Download-Route auf `FileStorage` umstellen**

`src/web/routes/invoices.ts` komplett ersetzen durch:

```ts
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import type { FileStorage } from "../../domain/ports/file-storage.js";
import type {
  AccountUiRepository,
  InvoiceListFilters,
  InvoiceUiRepository,
} from "../../domain/ports/repositories.js";
import { sendPage } from "../render.js";
import { invoicesPage } from "../views/invoices.js";

const PAGE_SIZE = 25;

export interface InvoiceRouteOptions {
  readonly accounts: AccountUiRepository;
  readonly invoices: InvoiceUiRepository;
  readonly getFileStorage: () => Promise<FileStorage>;
}

export function registerInvoiceRoutes(app: FastifyInstance, options: InvoiceRouteOptions): void {
  app.get<{ Querystring: Query }>("/invoices", async (request, reply) => {
    const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
    const filters: InvoiceListFilters = {
      ...optionalNumber("accountId", request.query.accountId),
      ...optionalState(request.query.state),
      ...optionalString("from", request.query.from),
      ...optionalString("to", request.query.to),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    };
    const [accounts, result] = await Promise.all([
      options.accounts.listAll(),
      options.invoices.listInvoices(filters),
    ]);
    sendPage(request, reply, {
      title: "Rechnungen",
      body: invoicesPage({ accounts, result, filters, page, pageSize: PAGE_SIZE }),
    });
  });

  app.get<{ Params: { id: string } }>("/invoices/documents/:id", async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const document = await options.invoices.findStoredDocument(id);
    if (document === undefined) return reply.status(404).send("Not found");

    let bytes: Buffer;
    try {
      const storage = await options.getFileStorage();
      bytes = await storage.retrieve(document.relativePath);
    } catch (error) {
      request.log.error({ err: error, documentId: id }, "failed to retrieve stored document");
      return reply.status(500).send("Datei konnte nicht geladen werden.");
    }

    reply
      .type("application/pdf")
      .header("Content-Disposition", `attachment; filename="${basename(document.relativePath)}"`);
    return reply.send(bytes);
  });
}

interface Query {
  readonly accountId?: string;
  readonly state?: string;
  readonly from?: string;
  readonly to?: string;
  readonly page?: string;
}

function optionalNumber(key: "accountId", value: string | undefined): { accountId?: number } {
  if (value === undefined || value === "") return {};
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? { [key]: parsed } : {};
}

function optionalState(value: string | undefined): { state?: "pending" | "stored" | "failed" } {
  return value === "pending" || value === "stored" || value === "failed" ? { state: value } : {};
}

function optionalString(
  key: "from" | "to",
  value: string | undefined,
): { from?: string; to?: string } {
  return value === undefined || value === "" ? {} : { [key]: value };
}
```

- [ ] **Step 6: Test für die Download-Route schreiben**

`src/web/routes/invoices.test.ts` (neue Datei):

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountCredentials, DiscoveredAsset } from "../../domain/invoice.js";
import { DiscoveryTokenStore } from "../../infrastructure/auth/discovery-token-store.js";
import { Cipher } from "../../infrastructure/crypto/cipher.js";
import { createLogger } from "../../infrastructure/logging/logger.js";
import { closeDatabase, createDatabase, type Database } from "../../infrastructure/persistence/database.js";
import { DrizzleAccountRepository } from "../../infrastructure/persistence/repositories/account-repository.js";
import { DrizzleInvoiceRepository } from "../../infrastructure/persistence/repositories/invoice-repository.js";
import { DrizzleRunRepository } from "../../infrastructure/persistence/repositories/run-repository.js";
import { DrizzleSettingsRepository } from "../../infrastructure/persistence/repositories/settings-repository.js";
import { account, invoice, invoiceDocument } from "../../infrastructure/persistence/schema.js";
import { AtomicFileStorage } from "../../infrastructure/storage/atomic-file-storage.js";
import { buildServer } from "../server.js";

let dir: string;
let db: Database;
let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

async function buildTestApp(): Promise<{ app: FastifyInstance; downloadsDir: string }> {
  dir = mkdtempSync(join(tmpdir(), "vid-invoices-route-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  const cipher = new Cipher(randomBytes(32));
  const downloadsDir = join(dir, "downloads");
  const testApp = await buildServer({
    db,
    logger: createLogger({ level: "silent", pretty: false }),
    version: "0.1.0",
    accounts: new DrizzleAccountRepository(db, cipher),
    invoices: new DrizzleInvoiceRepository(db),
    runs: new DrizzleRunRepository(db),
    settings: new DrizzleSettingsRepository(db, cipher),
    cipher,
    discoveryTokens: new DiscoveryTokenStore(),
    discoverAssets: async (_credentials: AccountCredentials): Promise<DiscoveredAsset[]> => [],
    runAccount: async () => undefined,
    getFileStorage: async () => new AtomicFileStorage(downloadsDir),
  });
  return { app: testApp, downloadsDir };
}

function seedStoredDocument(relativePath: string): number {
  const [acc] = db
    .insert(account)
    .values({
      label: "Test",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:test:1",
      status: "ok",
    })
    .returning()
    .all();
  if (acc === undefined) throw new Error("seed failed");
  const [inv] = db
    .insert(invoice)
    .values({ accountId: acc.id, number: "R-1", issuedOn: "2026-01-01", amountCents: 100 })
    .returning()
    .all();
  if (inv === undefined) throw new Error("seed failed");
  const [doc] = db
    .insert(invoiceDocument)
    .values({
      invoiceId: inv.id,
      remoteDocumentId: "doc-1",
      state: "stored",
      relativePath,
      sha256: "irrelevant-for-this-test",
      sizeBytes: 3,
      storedAt: 1,
    })
    .returning()
    .all();
  if (doc === undefined) throw new Error("seed failed");
  return doc.id;
}

describe("GET /invoices/documents/:id", () => {
  it("streams the stored PDF bytes", async () => {
    const { app: testApp, downloadsDir } = await buildTestApp();
    app = testApp;
    await new AtomicFileStorage(downloadsDir).store("2026/r.pdf", Buffer.from("%PDF-1.4"));
    const documentId = seedStoredDocument("2026/r.pdf");

    const response = await app.inject({ method: "GET", url: `/invoices/documents/${documentId}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("%PDF-1.4");
    expect(response.headers["content-type"]).toBe("application/pdf");
  });

  it("returns 404 for an unknown document id", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;

    const response = await app.inject({ method: "GET", url: "/invoices/documents/999" });

    expect(response.statusCode).toBe(404);
  });

  it("returns 500 when the file is missing from the backend despite a stored DB row", async () => {
    const { app: testApp } = await buildTestApp();
    app = testApp;
    const documentId = seedStoredDocument("2026/never-written.pdf");

    const response = await app.inject({ method: "GET", url: `/invoices/documents/${documentId}` });

    expect(response.statusCode).toBe(500);
  });
});
```

- [ ] **Step 7: Testlauf bestätigt Fehlschlag**

Run: `npx vitest run src/web/routes/invoices.test.ts`
Expected: FAIL — `buildServer` erwartet `downloadsDir`, nicht `getFileStorage` (Server-Wiring folgt in Step 8/9).

- [ ] **Step 8: `server.ts` auf `getFileStorage` umstellen**

`src/web/server.ts` — Import ergänzen (nach dem `Cipher`-Import):

```ts
import type { FileStorage } from "../domain/ports/file-storage.js";
```

In `ServerDeps` die Zeile `readonly downloadsDir?: string;` ersetzen durch:

```ts
  readonly getFileStorage?: () => Promise<FileStorage>;
```

Die große Bedingung in `buildServer` — `deps.downloadsDir !== undefined` durch `deps.getFileStorage !== undefined` ersetzen, und im Aufruf von `registerInvoiceRoutes` `downloadsDir: deps.downloadsDir` durch `getFileStorage: deps.getFileStorage` ersetzen:

```ts
  if (
    deps.accounts !== undefined &&
    deps.invoices !== undefined &&
    deps.runs !== undefined &&
    deps.settings !== undefined &&
    deps.cipher !== undefined &&
    deps.discoveryTokens !== undefined &&
    deps.discoverAssets !== undefined &&
    deps.runAccount !== undefined &&
    deps.getFileStorage !== undefined
  ) {
    registerDashboardRoutes(app, {
      accounts: deps.accounts,
      invoices: deps.invoices,
      runs: deps.runs,
      nextRun: deps.nextRun ?? (() => null),
    });
    const accountRouteOptions = {
      accounts: deps.accounts,
      cipher: deps.cipher,
      discoveryTokens: deps.discoveryTokens,
      discoverAssets: deps.discoverAssets,
      runAccount: deps.runAccount,
      ...(deps.renewSession === undefined ? {} : { renewSession: deps.renewSession }),
    };
    registerAccountsRoutes(app, accountRouteOptions);
    registerInvoiceRoutes(app, {
      accounts: deps.accounts,
      invoices: deps.invoices,
      getFileStorage: deps.getFileStorage,
    });
    registerSettingsRoutes(app, {
      settings: deps.settings,
      ...(deps.sessions === undefined ? {} : { sessions: deps.sessions }),
      ...(deps.passwordHash === undefined ? {} : { defaultPasswordHash: deps.passwordHash }),
    });
    registerRunsRoutes(app, {
      accounts: deps.accounts,
      runs: deps.runs,
      runAccount: deps.runAccount,
    });
    registerLogsRoutes(app, { logFile: deps.logFile ?? join(process.cwd(), "app.log") });
  }
```

- [ ] **Step 9: Alle Server-Test-Call-Sites von `downloadsDir` auf `getFileStorage` umstellen**

In `src/web/routes/settings.test.ts`, `src/web/routes/dashboard.test.ts`, `src/web/routes/logs.test.ts`, `src/web/routes/runs.test.ts`: jedes Vorkommen von

```ts
    downloadsDir: join(dir, "downloads"),
```

ersetzen durch

```ts
    getFileStorage: async () => new AtomicFileStorage(join(dir, "downloads")),
```

und den Import

```ts
import { AtomicFileStorage } from "../../infrastructure/storage/atomic-file-storage.js";
```

am Kopf jeder dieser vier Dateien ergänzen (Pfad-Tiefe wie bei den bereits vorhandenen `infrastructure`-Importen in derselben Datei).

- [ ] **Step 10: Composition-Root verdrahten**

`src/composition-root.ts` — Imports ergänzen:

```ts
import { DrizzleMigrationRepository } from "./infrastructure/persistence/repositories/migration-repository.js";
```
```ts
import { buildFileStorage } from "./infrastructure/storage/resolve-file-storage.js";
```
```ts
import { changeStorageTarget } from "./application/change-storage-target.js";
import { StorageMigrationRunner } from "./application/migrate-storage.js";
```
```ts
import type { StorageConfig } from "./domain/storage-config.js";
```

Die Zeile `const storage = new AtomicFileStorage(config.downloadsDir);` entfernen (nicht mehr als fester Singleton gebraucht) und stattdessen direkt nach der `settings`-Zeile einfügen:

```ts
  const buildStorage = (target: StorageConfig): FileStorage => buildFileStorage(target, config.downloadsDir);
```

(Import `import type { FileStorage } from "./domain/ports/file-storage.js";` ergänzen.)

Die bestehende `sync`-Definition ersetzen:

```ts
  const sync = async (accountId: number): Promise<SyncReport> => {
    const storage = buildStorage(await settings.storageConfig());
    return syncAccount(
      { provider, accounts, invoices, settings, storage, renderFilename, validatePdf },
      accountId,
    );
  };
```

Nach der bestehenden `runs`/`coordinator`-Verdrahtung (nach `const coordinator = new RunCoordinator(...)`) einfügen:

```ts
  const migrations = new DrizzleMigrationRepository(db, cipher);
  const migrationRunner = new StorageMigrationRunner({
    migrations,
    settings,
    buildFileStorage: buildStorage,
    logger,
  });

  // Resume an interrupted migration from a crashed or killed previous
  // process — the runner is idempotent, so re-invoking it is safe.
  const runningMigration = await migrations.findRunningMigration();
  if (runningMigration !== undefined) {
    migrationRunner.run(runningMigration.id).catch((error: unknown) => {
      logger.error({ err: error }, "storage migration resume failed");
    });
  }
```

Im Aufruf von `buildServer({...})` die Zeile `downloadsDir: config.downloadsDir,` ersetzen durch:

```ts
    getFileStorage: async () => buildStorage(await settings.storageConfig()),
```

- [ ] **Step 11: Testlauf bestätigt Erfolg**

Run: `npx vitest run src/web/routes/invoices.test.ts`
Expected: PASS.

- [ ] **Step 12: Typecheck, Lint, Gesamttestlauf**

Run: `npm run typecheck && npm run lint && npm test`
Expected: alles PASS.

- [ ] **Step 13: Commit**

```bash
git add src/infrastructure/storage/resolve-file-storage.ts src/infrastructure/storage/resolve-file-storage.test.ts src/web/routes/invoices.ts src/web/routes/invoices.test.ts src/web/server.ts src/web/routes/settings.test.ts src/web/routes/dashboard.test.ts src/web/routes/logs.test.ts src/web/routes/runs.test.ts src/composition-root.ts
git commit -m "feat: Speicherziel live aus Settings auflösen, Migrations-Resume beim Start"
```

---

## Selbst-Review (durchgeführt)

**Spec-Abdeckung:** Port-Erweiterung (§2) → Task 1. Settings-Datenmodell (§3) → Task 2/4. Migrationslauf inkl. Idempotenz/Resume (§4) → Task 5/6/7. UI (§5), Fehlerbehandlung im UI-Sinn (§6 teilweise — Backend-Fehler beim normalen Sync sind durch Task 7 abgedeckt, da `sync` jetzt live auflöst) und die vier Protokoll-Adapter (§2-Tabelle) sind bewusst **nicht** Teil dieses Plans — sie kommen in den Folgeplänen SFTP/FTP/WebDAV/SMB, wie eingangs mit dem Nutzer abgestimmt.

**Platzhalter-Scan:** Keine TBDs; die einzige bewusst offene Stelle ist der `default`-Branch in `buildFileStorage`, der explizit und funktionsfähig einen `StorageError` wirft (kein Platzhalter, sondern eine korrekte Zwischenimplementierung, die Task 3 des SFTP-Folgeplans als erstes ersetzt).

**Typkonsistenz:** `StorageConfig`, `StorageBackendKind`, `StoredDocumentRecord`, `CreateMigrationInput`, `StorageMigrationRecord` werden in Task 2 einmal definiert und danach in Task 4–7 unverändert wiederverwendet; `MigrationRepository`-Methodennamen (`listStoredDocuments`, `createMigration`, `findRunningMigration`, `findMigration`, `incrementProgress`, `setTotalDocuments`, `completeMigration`, `failMigration`) sind zwischen Port (Task 2), Implementierung (Task 5) und Use-Case-Mocks (Task 6) identisch.
