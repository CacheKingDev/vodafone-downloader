import { desc, eq, sql } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type {
  CreateMigrationInput,
  MigrationRepository,
  StorageMigrationRecord,
  StoredDocumentRecord,
} from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { invoiceDocument, type StorageMigrationRow, storageMigration } from "../schema.js";

export class DrizzleMigrationRepository implements MigrationRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async listStoredDocuments(): Promise<StoredDocumentRecord[]> {
    const rows = this.#db
      .select({
        id: invoiceDocument.id,
        relativePath: invoiceDocument.relativePath,
        sha256: invoiceDocument.sha256,
      })
      .from(invoiceDocument)
      .where(
        sql`${invoiceDocument.state} = 'stored' and ${invoiceDocument.relativePath} is not null and ${invoiceDocument.sha256} is not null`,
      )
      .all();
    return rows.map((row) => {
      if (row.relativePath === null || row.sha256 === null) {
        throw new PersistenceError("Stored document row is missing path or hash");
      }
      return { id: row.id, relativePath: row.relativePath, sha256: row.sha256 };
    });
  }

  async createMigration(input: CreateMigrationInput): Promise<number> {
    const [row] = this.#db
      .insert(storageMigration)
      .values({
        fromTargetId: input.fromTargetId,
        toTargetId: input.toTargetId,
        mode: input.mode,
        totalDocuments: input.totalDocuments,
      })
      .returning({ id: storageMigration.id })
      .all();
    if (row === undefined) throw new PersistenceError("Storage migration insert returned no row");
    return row.id;
  }

  async findRunningMigration(): Promise<StorageMigrationRecord | undefined> {
    const row = this.#db
      .select()
      .from(storageMigration)
      .where(eq(storageMigration.status, "running"))
      .orderBy(desc(storageMigration.startedAt))
      .get();
    return row === undefined ? undefined : this.#toRecord(row);
  }

  async findMigration(id: number): Promise<StorageMigrationRecord | undefined> {
    const row = this.#db.select().from(storageMigration).where(eq(storageMigration.id, id)).get();
    return row === undefined ? undefined : this.#toRecord(row);
  }

  async incrementProgress(id: number, outcome: "migrated" | "failed"): Promise<void> {
    const column =
      outcome === "migrated"
        ? storageMigration.migratedDocuments
        : storageMigration.failedDocuments;
    this.#db
      .update(storageMigration)
      .set({
        [outcome === "migrated" ? "migratedDocuments" : "failedDocuments"]: sql`${column} + 1`,
      })
      .where(eq(storageMigration.id, id))
      .run();
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
      .set({ status: "completed", finishedAt: nowSeconds(), errorMessage: null })
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

  #toRecord(row: StorageMigrationRow): StorageMigrationRecord {
    return {
      id: row.id,
      fromTargetId: row.fromTargetId,
      toTargetId: row.toTargetId,
      mode: row.mode,
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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
