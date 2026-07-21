import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, TemplateError } from "../../../domain/errors.js";
import { DEFAULT_FILENAME_TEMPLATE } from "../../storage/filename-template.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { setting } from "../schema.js";
import { DEFAULT_SYNC_SCHEDULE, DrizzleSettingsRepository } from "./settings-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleSettingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-settings-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleSettingsRepository(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleSettingsRepository.filenameTemplate", () => {
  it("returns the default when no setting exists", async () => {
    await expect(repo.filenameTemplate()).resolves.toBe(DEFAULT_FILENAME_TEMPLATE);
  });

  it("returns a stored, valid template", async () => {
    db.insert(setting)
      .values({ key: "filename_template", value: JSON.stringify("{invoice_number}.pdf") })
      .run();
    await expect(repo.filenameTemplate()).resolves.toBe("{invoice_number}.pdf");
  });

  it("throws TemplateError for a stored template with unknown placeholders", async () => {
    db.insert(setting)
      .values({ key: "filename_template", value: JSON.stringify("{bogus}.pdf") })
      .run();
    await expect(repo.filenameTemplate()).rejects.toBeInstanceOf(TemplateError);
  });

  it("throws TemplateError when the stored value is not JSON for a string", async () => {
    db.insert(setting).values({ key: "filename_template", value: "not json{" }).run();
    await expect(repo.filenameTemplate()).rejects.toBeInstanceOf(TemplateError);
  });
});

describe("DrizzleSettingsRepository.syncSchedule", () => {
  it("returns the default when no setting exists", async () => {
    await expect(repo.syncSchedule()).resolves.toBe(DEFAULT_SYNC_SCHEDULE);
  });

  it("returns a stored schedule", async () => {
    db.insert(setting)
      .values({ key: "sync_schedule", value: JSON.stringify("0 7 * * 1") })
      .run();
    await expect(repo.syncSchedule()).resolves.toBe("0 7 * * 1");
  });

  it("throws ConfigError when the stored value is not JSON for a string", async () => {
    db.insert(setting).values({ key: "sync_schedule", value: "not json{" }).run();
    await expect(repo.syncSchedule()).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError for an empty string", async () => {
    db.insert(setting)
      .values({ key: "sync_schedule", value: JSON.stringify("") })
      .run();
    await expect(repo.syncSchedule()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("DrizzleSettingsRepository.setFilenameTemplate", () => {
  it("round-trips a valid template through filenameTemplate", async () => {
    await repo.setFilenameTemplate("{invoice_number}.pdf");
    await expect(repo.filenameTemplate()).resolves.toBe("{invoice_number}.pdf");
  });

  it("throws TemplateError for a template with unknown placeholders", async () => {
    await expect(repo.setFilenameTemplate("{bogus}.pdf")).rejects.toBeInstanceOf(TemplateError);
  });

  it("does not persist a value rejected by validation", async () => {
    await expect(repo.setFilenameTemplate("{bogus}.pdf")).rejects.toBeInstanceOf(TemplateError);
    await expect(repo.filenameTemplate()).resolves.toBe(DEFAULT_FILENAME_TEMPLATE);
  });

  it("overwrites a previously stored template (upsert)", async () => {
    await repo.setFilenameTemplate("{invoice_number}.pdf");
    await repo.setFilenameTemplate("{year}/{invoice_number}.pdf");
    await expect(repo.filenameTemplate()).resolves.toBe("{year}/{invoice_number}.pdf");
  });
});

describe("DrizzleSettingsRepository.setSyncSchedule", () => {
  it("round-trips a valid cron expression through syncSchedule", async () => {
    await repo.setSyncSchedule("0 7 * * 1");
    await expect(repo.syncSchedule()).resolves.toBe("0 7 * * 1");
  });

  it("throws ConfigError for an invalid cron expression", async () => {
    await expect(repo.setSyncSchedule("not a cron")).rejects.toBeInstanceOf(ConfigError);
  });

  it("does not persist a value rejected by validation", async () => {
    await expect(repo.setSyncSchedule("not a cron")).rejects.toBeInstanceOf(ConfigError);
    await expect(repo.syncSchedule()).resolves.toBe(DEFAULT_SYNC_SCHEDULE);
  });

  it("overwrites a previously stored schedule (upsert)", async () => {
    await repo.setSyncSchedule("0 7 * * 1");
    await repo.setSyncSchedule("0 8 * * 2");
    await expect(repo.syncSchedule()).resolves.toBe("0 8 * * 2");
  });
});

describe("DrizzleSettingsRepository.adminPasswordHash", () => {
  it("returns null when no override was ever set", async () => {
    await expect(repo.adminPasswordHash()).resolves.toBeNull();
  });

  it("returns a stored hash", async () => {
    db.insert(setting)
      .values({ key: "admin_password_hash", value: JSON.stringify("deadbeef") })
      .run();
    await expect(repo.adminPasswordHash()).resolves.toBe("deadbeef");
  });

  it("throws ConfigError when the stored value is not JSON for a string", async () => {
    db.insert(setting).values({ key: "admin_password_hash", value: "not json{" }).run();
    await expect(repo.adminPasswordHash()).rejects.toBeInstanceOf(ConfigError);
  });

  it("throws ConfigError for an empty string", async () => {
    db.insert(setting)
      .values({ key: "admin_password_hash", value: JSON.stringify("") })
      .run();
    await expect(repo.adminPasswordHash()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("DrizzleSettingsRepository.setAdminPasswordHash", () => {
  it("round-trips a hash through adminPasswordHash", async () => {
    await repo.setAdminPasswordHash("deadbeef");
    await expect(repo.adminPasswordHash()).resolves.toBe("deadbeef");
  });

  it("overwrites a previously stored hash (upsert)", async () => {
    await repo.setAdminPasswordHash("deadbeef");
    await repo.setAdminPasswordHash("cafef00d");
    await expect(repo.adminPasswordHash()).resolves.toBe("cafef00d");
  });
});
