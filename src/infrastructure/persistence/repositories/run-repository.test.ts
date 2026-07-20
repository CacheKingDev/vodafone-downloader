import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, createDatabase, type Database } from "../database.js";
import { account, run } from "../schema.js";
import { DrizzleRunRepository } from "./run-repository.js";

let dir: string;
let db: Database;
let repo: DrizzleRunRepository;
let accountId: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-runs-"));
  db = createDatabase({ file: join(dir, "test.sqlite"), migrationsFolder: "./drizzle" });
  repo = new DrizzleRunRepository(db);
  const [row] = db
    .insert(account)
    .values({
      label: "Privat",
      usernameEnc: Buffer.from("u"),
      passwordEnc: Buffer.from("p"),
      customerUrn: "urn:vf-de:cable:can:0000000001",
    })
    .returning()
    .all();
  if (row === undefined) throw new Error("account insert failed");
  accountId = row.id;
});

afterEach(() => {
  closeDatabase(db);
  rmSync(dir, { recursive: true, force: true });
});

describe("DrizzleRunRepository", () => {
  it("starts a run with started_at set and no outcome", async () => {
    const runId = await repo.startRun(accountId, "schedule");
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.accountId).toBe(accountId);
    expect(row?.trigger).toBe("schedule");
    expect(row?.startedAt).toBeTypeOf("number");
    expect(row?.finishedAt).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  it("finishes a run with outcome, counters and finished_at", async () => {
    const runId = await repo.startRun(accountId, "manual");
    await repo.finishRun(runId, {
      outcome: "partial",
      invoicesSeen: 5,
      documentsStored: 3,
      errorMessage: null,
    });
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.outcome).toBe("partial");
    expect(row?.invoicesSeen).toBe(5);
    expect(row?.documentsStored).toBe(3);
    expect(row?.finishedAt).toBeTypeOf("number");
    expect(row?.errorMessage).toBeNull();
  });

  it("persists the error message of a failed run", async () => {
    const runId = await repo.startRun(accountId, "schedule");
    await repo.finishRun(runId, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "portal down",
    });
    const row = db.select().from(run).where(eq(run.id, runId)).get();
    expect(row?.outcome).toBe("failed");
    expect(row?.errorMessage).toBe("portal down");
  });
});
