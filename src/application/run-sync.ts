import type { AccountRepository, RunRepository, RunTrigger } from "../domain/ports/repositories.js";
import type { SyncReport } from "./sync-invoices.js";

export interface RunSummary {
  readonly runId: number;
  readonly accountId: number;
  readonly outcome: "success" | "partial" | "failed";
}

export interface RunAllResult {
  readonly started: boolean;
  readonly runs: readonly RunSummary[];
}

/** Structurally pino-compatible; keeps infrastructure out of this layer. */
export interface RunLogger {
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface CoordinatorDeps {
  readonly accounts: Pick<AccountRepository, "listSyncableIds">;
  readonly runs: RunRepository;
  readonly sync: (accountId: number) => Promise<SyncReport>;
  readonly logger: RunLogger;
}

/**
 * Owns run bookkeeping and the overlap guard. syncAccount deliberately
 * rethrows unexpected errors (bugs, TemplateError from settings); this is the
 * boundary that turns them into a failed run row instead of a crashed service.
 * A tick that fires while a run is active is skipped, never queued.
 */
export class RunCoordinator {
  readonly #deps: CoordinatorDeps;
  #busy = false;

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps;
  }

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
      return await this.#runOne(accountId, trigger);
    } finally {
      this.#busy = false;
    }
  }

  async #runOne(accountId: number, trigger: RunTrigger): Promise<RunSummary> {
    const runId = await this.#deps.runs.startRun(accountId, trigger);
    try {
      const report = await this.#deps.sync(accountId);
      await this.#deps.runs.finishRun(runId, {
        outcome: report.outcome,
        invoicesSeen: report.invoicesSeen,
        documentsStored: report.documentsStored,
        errorMessage: report.errorMessage,
      });
      return { runId, accountId, outcome: report.outcome };
    } catch (error) {
      // Unexpected by design: syncAccount maps all portal errors itself.
      const message = error instanceof Error ? error.message : String(error);
      this.#deps.logger.error({ err: error, accountId }, "sync run crashed");
      await this.#deps.runs.finishRun(runId, {
        outcome: "failed",
        invoicesSeen: 0,
        documentsStored: 0,
        errorMessage: message,
      });
      return { runId, accountId, outcome: "failed" };
    }
  }
}
