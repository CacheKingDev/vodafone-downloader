import { desc, eq, sql } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type {
  RunListItem,
  RunRepository,
  RunResult,
  RunTrigger,
} from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { account, run } from "../schema.js";

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** One run row per account sync; started_at/finished_at are unix seconds. */
export class DrizzleRunRepository implements RunRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async startRun(accountId: number, trigger: RunTrigger): Promise<number> {
    const [row] = this.#db
      .insert(run)
      .values({ accountId, trigger, startedAt: nowSeconds() })
      .returning({ id: run.id })
      .all();
    if (row === undefined) {
      throw new PersistenceError("Run insert returned no row");
    }
    return row.id;
  }

  async finishRun(runId: number, result: RunResult): Promise<void> {
    this.#db
      .update(run)
      .set({
        finishedAt: nowSeconds(),
        outcome: result.outcome,
        invoicesSeen: result.invoicesSeen,
        documentsStored: result.documentsStored,
        errorMessage: result.errorMessage,
      })
      .where(eq(run.id, runId))
      .run();
  }

  /**
   * Marks runs that started more than `graceMs` ago without a finish timestamp.
   * Used at startup to reconcile interrupted syncs (e.g. process killed mid-run).
   */
  async orphanCleanup(graceMs: number): Promise<void> {
    const cutoff = Math.floor((Date.now() - graceMs) / 1000);
    this.#db
      .update(run)
      .set({
        finishedAt: cutoff,
        outcome: "failed" as const,
        errorMessage: "interrupted",
      })
      .where(sql`${run.finishedAt} IS NULL`)
      .run();
  }

  async listRecent(limit: number): Promise<RunListItem[]> {
    return this.#db
      .select({
        id: run.id,
        accountId: run.accountId,
        accountLabel: account.label,
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        invoicesSeen: run.invoicesSeen,
        documentsStored: run.documentsStored,
        errorMessage: run.errorMessage,
      })
      .from(run)
      .leftJoin(account, eq(run.accountId, account.id))
      .orderBy(desc(run.startedAt))
      .limit(limit)
      .all();
  }

  async findRun(id: number): Promise<RunListItem | undefined> {
    return this.#db
      .select({
        id: run.id,
        accountId: run.accountId,
        accountLabel: account.label,
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        invoicesSeen: run.invoicesSeen,
        documentsStored: run.documentsStored,
        errorMessage: run.errorMessage,
      })
      .from(run)
      .leftJoin(account, eq(run.accountId, account.id))
      .where(eq(run.id, id))
      .get();
  }
}
