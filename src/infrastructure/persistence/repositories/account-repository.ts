import { and, asc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Account, AccountStatus } from "../../../domain/account.js";
import type {
  AccountRepository,
  AccountSummary,
  CreateAccountInput,
} from "../../../domain/ports/repositories.js";
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

  async listSyncableIds(): Promise<number[]> {
    const rows = this.#db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.enabled, true), ne(account.status, "needs_action")))
      .all();
    return rows.map((row) => row.id);
  }

  async create(accountData: CreateAccountInput): Promise<number> {
    const result = this.#db
      .insert(account)
      .values({
        label: accountData.label,
        usernameEnc: this.#cipher.encrypt(accountData.credentials.username),
        passwordEnc: this.#cipher.encrypt(accountData.credentials.password),
        customerUrn: accountData.customerUrn,
        status: accountData.status,
        enabled: true,
        createdAt: nowSeconds(),
        updatedAt: nowSeconds(),
      })
      .returning({ id: account.id })
      .all();
    const created = result[0];
    if (created === undefined) {
      throw new Error("Account insert returned no row");
    }
    return created.id;
  }

  async listAll(): Promise<AccountSummary[]> {
    const rows = this.#db.select().from(account).orderBy(asc(account.label)).all();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      customerUrn: row.customerUrn,
      enabled: row.enabled,
      backfillFrom: row.backfillFrom,
      status: row.status,
      statusDetail: row.statusDetail,
      sessionRefreshedAt: row.sessionRefreshedAt,
    }));
  }

  async updateLabel(id: number, label: string): Promise<void> {
    this.#db
      .update(account)
      .set({ label, updatedAt: nowSeconds() })
      .where(eq(account.id, id))
      .run();
  }

  async delete(id: number): Promise<void> {
    this.#db.delete(account).where(eq(account.id, id)).run();
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    this.#db
      .update(account)
      .set({ enabled, updatedAt: nowSeconds() })
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
