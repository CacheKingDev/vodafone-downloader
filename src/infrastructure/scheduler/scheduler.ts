import { Cron } from "croner";
import { ConfigError } from "../../domain/errors.js";
import type { Logger } from "../logging/logger.js";
import { cleanupArtifacts } from "./artifact-cleanup.js";

/** Daily at 03:30 — cheap, and artifacts only need coarse retention. */
const CLEANUP_SCHEDULE = "30 3 * * *";

export function validateCronExpression(expression: string): void {
  try {
    new Cron(expression, { paused: true }).stop();
  } catch (cause) {
    throw new ConfigError(`Invalid cron expression: ${expression}`, { cause });
  }
}

export interface SchedulerOptions {
  readonly schedule: string;
  readonly artifactsDir: string;
  readonly runAll: () => Promise<unknown>;
  readonly logger: Logger;
}

/**
 * Thin Croner wrapper. A broken cron expression fails loudly at start —
 * a container with a bad schedule must not come up silently jobless. The
 * coordinator owns overlap protection; this class only fires ticks.
 */
export class SyncScheduler {
  readonly #options: SchedulerOptions;
  #syncJob: Cron | undefined;
  #cleanupJob: Cron | undefined;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#syncJob !== undefined) return;
    const onJobError = (error: unknown): void => {
      this.#options.logger.error({ err: error }, "scheduled job failed");
    };
    try {
      validateCronExpression(this.#options.schedule);
      this.#syncJob = new Cron(this.#options.schedule, { catch: onJobError }, async () => {
        await this.#options.runAll();
      });
    } catch (cause) {
      throw new ConfigError(`Invalid sync_schedule cron expression: ${this.#options.schedule}`, {
        cause,
      });
    }
    this.#cleanupJob = new Cron(CLEANUP_SCHEDULE, { catch: onJobError }, async () => {
      await cleanupArtifacts(this.#options.artifactsDir, this.#options.logger);
    });
    // Run the cleanup once at startup too, so a long-stopped container catches up.
    void cleanupArtifacts(this.#options.artifactsDir, this.#options.logger);
    this.#options.logger.info(
      { schedule: this.#options.schedule, nextRun: this.nextSyncRun() },
      "scheduler started",
    );
  }

  stop(): void {
    this.#syncJob?.stop();
    this.#cleanupJob?.stop();
    this.#syncJob = undefined;
    this.#cleanupJob = undefined;
  }

  nextSyncRun(): Date | null {
    return this.#syncJob?.nextRun() ?? null;
  }
}
