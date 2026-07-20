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

  it("marks old unfinished runs as interrupted", async () => {
    // Insert a manual row with started_at in the past and finished_at = NULL.
    const now = Math.floor(Date.now() / 1000);
    db.insert(run)
      .values({
        accountId,
        trigger: "schedule",
        startedAt: now - 20 * 60, // 20 min ago (> 15 min grace window)
      })
      .run();

    await repo.orphanCleanup(15 * 60 * 1000);

    const rows = db.select().from(run).all();
    const interrupted = rows.filter((row) => row.finishedAt !== null && row.outcome === "failed");
    expect(interrupted.length).toBe(1);
  });
});

describe("DrizzleRunRepository.listRecent", () => {
  it("orders runs newest-first and respects the limit", async () => {
    // startRun stamps started_at from the wall clock, so three calls made back
    // to back could land in the same unix second; pin distinct values via a
    // direct update afterwards so the ordering assertion cannot flake.
    const baseSeconds = Math.floor(Date.now() / 1000);
    const firstId = await repo.startRun(accountId, "schedule");
    db.update(run).set({ startedAt: baseSeconds }).where(eq(run.id, firstId)).run();
    await repo.finishRun(firstId, {
      outcome: "success",
      invoicesSeen: 1,
      documentsStored: 1,
      errorMessage: null,
    });
    const secondId = await repo.startRun(accountId, "manual");
    db.update(run)
      .set({ startedAt: baseSeconds + 1 })
      .where(eq(run.id, secondId))
      .run();
    await repo.finishRun(secondId, {
      outcome: "success",
      invoicesSeen: 2,
      documentsStored: 2,
      errorMessage: null,
    });
    const thirdId = await repo.startRun(accountId, "schedule");
    db.update(run)
      .set({ startedAt: baseSeconds + 2 })
      .where(eq(run.id, thirdId))
      .run();
    await repo.finishRun(thirdId, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "portal down",
    });

    const all = await repo.listRecent(10);
    expect(all.map((item) => item.id)).toEqual([thirdId, secondId, firstId]);
    expect(all[0]?.accountLabel).toBe("Privat");

    const limited = await repo.listRecent(2);
    expect(limited.map((item) => item.id)).toEqual([thirdId, secondId]);
  });

  it("returns accountLabel null once the account has been deleted", async () => {
    const runId = await repo.startRun(accountId, "manual");
    await repo.finishRun(runId, {
      outcome: "success",
      invoicesSeen: 1,
      documentsStored: 1,
      errorMessage: null,
    });

    db.delete(account).where(eq(account.id, accountId)).run();

    const items = await repo.listRecent(10);
    expect(items).toHaveLength(1);
    expect(items[0]?.accountId).toBeNull();
    expect(items[0]?.accountLabel).toBeNull();
  });
});

describe("DrizzleRunRepository.findRun", () => {
  it("finds an existing run with the same projection as listRecent", async () => {
    const runId = await repo.startRun(accountId, "manual");
    await repo.finishRun(runId, {
      outcome: "partial",
      invoicesSeen: 4,
      documentsStored: 2,
      errorMessage: null,
    });

    const found = await repo.findRun(runId);
    expect(found?.id).toBe(runId);
    expect(found?.accountId).toBe(accountId);
    expect(found?.accountLabel).toBe("Privat");
    expect(found?.trigger).toBe("manual");
    expect(found?.outcome).toBe("partial");
    expect(found?.invoicesSeen).toBe(4);
    expect(found?.documentsStored).toBe(2);
  });

  it("returns undefined for an unknown id", async () => {
    await expect(repo.findRun(999999)).resolves.toBeUndefined();
  });
});
