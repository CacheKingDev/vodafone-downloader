import { eq } from "drizzle-orm";
import { PersistenceError } from "../../../domain/errors.js";
import type { RunRepository, RunResult, RunTrigger } from "../../../domain/ports/repositories.js";
import type { Database } from "../database.js";
import { run } from "../schema.js";

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
}
