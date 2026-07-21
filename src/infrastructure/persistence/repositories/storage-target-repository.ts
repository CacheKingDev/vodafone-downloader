import { eq, ne } from "drizzle-orm";
import { ConfigError, PersistenceError } from "../../../domain/errors.js";
import type { StorageTargetUiRepository } from "../../../domain/ports/repositories.js";
import { describeStorageDestination, type StorageConfig } from "../../../domain/storage-config.js";
import type {
  CreateStorageTargetInput,
  StorageTarget,
  StorageTargetStatus,
  StorageTargetSummary,
  UpdateStorageTargetInput,
} from "../../../domain/storage-target.js";
import type { Cipher } from "../../crypto/cipher.js";
import { storageConfigSchema } from "../../storage/storage-config-schema.js";
import type { Database } from "../database.js";
import { type NewStorageTargetRow, type StorageTargetRow, storageTarget } from "../schema.js";

/**
 * Secrets are AES-256-GCM (the same `Cipher`/key as account credentials,
 * spec section 14) and only ever decrypted server-side via `findById`/
 * `findDefault` — `list()` returns summaries without a config field at all.
 */
export class DrizzleStorageTargetRepository implements StorageTargetUiRepository {
  readonly #db: Database;
  readonly #cipher: Cipher;

  constructor(db: Database, cipher: Cipher) {
    this.#db = db;
    this.#cipher = cipher;
  }

  async list(): Promise<StorageTargetSummary[]> {
    const rows = this.#db.select().from(storageTarget).orderBy(storageTarget.createdAt).all();
    return rows.map((row) => this.#toSummary(row));
  }

  async findById(id: number): Promise<StorageTarget | undefined> {
    const row = this.#db.select().from(storageTarget).where(eq(storageTarget.id, id)).get();
    return row === undefined ? undefined : this.#toTarget(row);
  }

  async findDefault(): Promise<StorageTarget | undefined> {
    const row = this.#db
      .select()
      .from(storageTarget)
      .where(eq(storageTarget.isDefault, true))
      .get();
    return row === undefined ? undefined : this.#toTarget(row);
  }

  async nameExists(name: string, excludingId?: number): Promise<boolean> {
    const row = this.#db
      .select({ id: storageTarget.id })
      .from(storageTarget)
      .where(eq(storageTarget.name, name))
      .get();
    if (row === undefined) return false;
    return excludingId === undefined || row.id !== excludingId;
  }

  async create(input: CreateStorageTargetInput): Promise<number> {
    const [row] = this.#db
      .insert(storageTarget)
      .values({
        name: input.name,
        backend: input.config.backend,
        purpose: input.purpose,
        description: input.description,
        status: input.status,
        configEnc: this.#encryptConfig(input.config),
      })
      .returning({ id: storageTarget.id })
      .all();
    if (row === undefined) throw new PersistenceError("Storage target insert returned no row");
    return row.id;
  }

  async update(id: number, input: UpdateStorageTargetInput): Promise<void> {
    const values: Partial<NewStorageTargetRow> = { updatedAt: nowSeconds() };
    if (input.name !== undefined) values.name = input.name;
    if (input.purpose !== undefined) values.purpose = input.purpose;
    if (input.description !== undefined) values.description = input.description;
    if (input.config !== undefined) {
      values.backend = input.config.backend;
      values.configEnc = this.#encryptConfig(input.config);
      // Connection-relevant fields changed — a previous successful test no
      // longer says anything about the new values (spec section 10).
      values.status = "untested";
      values.lastTestedAt = null;
      values.lastTestError = null;
    }
    this.#db.update(storageTarget).set(values).where(eq(storageTarget.id, id)).run();
  }

  async setStatus(id: number, status: StorageTargetStatus): Promise<void> {
    this.#db
      .update(storageTarget)
      .set({ status, updatedAt: nowSeconds() })
      .where(eq(storageTarget.id, id))
      .run();
  }

  async recordTestResult(
    id: number,
    result: { success: boolean; errorMessage: string | null },
  ): Promise<void> {
    this.#db
      .update(storageTarget)
      .set({
        status: result.success ? "connected" : "failed",
        lastTestedAt: nowSeconds(),
        lastTestError: result.errorMessage,
        updatedAt: nowSeconds(),
      })
      .where(eq(storageTarget.id, id))
      .run();
  }

  async setDefault(id: number): Promise<void> {
    this.#db.transaction((tx) => {
      tx.update(storageTarget)
        .set({ isDefault: false, updatedAt: nowSeconds() })
        .where(ne(storageTarget.id, id))
        .run();
      tx.update(storageTarget)
        .set({ isDefault: true, updatedAt: nowSeconds() })
        .where(eq(storageTarget.id, id))
        .run();
    });
  }

  async setDisabled(id: number, disabled: boolean): Promise<void> {
    this.#db
      .update(storageTarget)
      .set({ status: disabled ? "disabled" : "untested", updatedAt: nowSeconds() })
      .where(eq(storageTarget.id, id))
      .run();
  }

  async delete(id: number): Promise<void> {
    this.#db.delete(storageTarget).where(eq(storageTarget.id, id)).run();
  }

  #encryptConfig(config: StorageConfig): Buffer | null {
    if (config.backend === "local") return null;
    return this.#cipher.encrypt(JSON.stringify(storageConfigSchema.parse(config)));
  }

  #toSummary(row: StorageTargetRow): StorageTargetSummary {
    return {
      id: row.id,
      name: row.name,
      backend: row.backend,
      destination: describeStorageDestination(this.#decryptConfig(row)),
      purpose: row.purpose,
      description: row.description,
      isDefault: row.isDefault,
      status: row.status,
      lastTestedAt: row.lastTestedAt,
      lastTestError: row.lastTestError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #toTarget(row: StorageTargetRow): StorageTarget {
    return { ...this.#toSummary(row), config: this.#decryptConfig(row) };
  }

  #decryptConfig(row: StorageTargetRow): StorageConfig {
    if (row.backend === "local") return { backend: "local" };
    if (row.configEnc === null) {
      throw new ConfigError(`Storage target ${row.id} is missing its encrypted config`);
    }
    try {
      return storageConfigSchema.parse(JSON.parse(this.#cipher.decrypt(row.configEnc)));
    } catch (cause) {
      throw new ConfigError(`Storage target ${row.id} config is invalid`, { cause });
    }
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
