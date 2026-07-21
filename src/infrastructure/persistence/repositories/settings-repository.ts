import { eq } from "drizzle-orm";
import { z } from "zod";
import { ConfigError, TemplateError } from "../../../domain/errors.js";
import type { SettingsUiRepository } from "../../../domain/ports/repositories.js";
import { validateCronExpression } from "../../scheduler/scheduler.js";
import { DEFAULT_FILENAME_TEMPLATE, validateTemplate } from "../../storage/filename-template.js";
import type { Database } from "../database.js";
import { setting } from "../schema.js";

const FILENAME_TEMPLATE_KEY = "filename_template";
const SYNC_SCHEDULE_KEY = "sync_schedule";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";

/** Daily at 06:00 — invoices arrive monthly, one morning check is plenty. */
export const DEFAULT_SYNC_SCHEDULE = "0 6 * * *";

/**
 * Settings are stored as JSON strings and validated on read (spec section 5):
 * a corrupt or invalid template must fail loudly here, not render a wrong
 * path silently during a sync.
 */
export class DrizzleSettingsRepository implements SettingsUiRepository {
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
    validateCronExpression(result.data);
    return result.data;
  }

  async setFilenameTemplate(template: string): Promise<void> {
    validateTemplate(template);
    this.#set(FILENAME_TEMPLATE_KEY, template);
  }

  async setSyncSchedule(schedule: string): Promise<void> {
    validateCronExpression(schedule);
    this.#set(SYNC_SCHEDULE_KEY, schedule);
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

  #set(key: string, value: string): void {
    this.#db
      .insert(setting)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: setting.key, set: { value: JSON.stringify(value) } })
      .run();
  }
}
