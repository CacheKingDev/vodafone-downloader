import { eq } from "drizzle-orm";
import { z } from "zod";
import { ConfigError, TemplateError } from "../../../domain/errors.js";
import type { SettingsRepository } from "../../../domain/ports/repositories.js";
import { DEFAULT_FILENAME_TEMPLATE, validateTemplate } from "../../storage/filename-template.js";
import type { Database } from "../database.js";
import { setting } from "../schema.js";

const FILENAME_TEMPLATE_KEY = "filename_template";
const SYNC_SCHEDULE_KEY = "sync_schedule";

/** Daily at 06:00 — invoices arrive monthly, one morning check is plenty. */
export const DEFAULT_SYNC_SCHEDULE = "0 6 * * *";

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
    // Whether the expression is valid cron is the scheduler's call (Croner
    // parses it at start) — this layer only guarantees shape.
    return result.data;
  }
}
