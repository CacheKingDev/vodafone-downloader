import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateError } from "../../../domain/errors.js";
import { DEFAULT_FILENAME_TEMPLATE } from "../../storage/filename-template.js";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { setting } from "../schema.js";
import { DrizzleSettingsRepository } from "./settings-repository.js";

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
