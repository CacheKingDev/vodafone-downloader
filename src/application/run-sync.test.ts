import { describe, expect, it, vi } from "vitest";
import { RunCoordinator } from "./run-sync.js";
import type { SyncReport } from "./sync-invoices.js";

const reportOf = (outcome: SyncReport["outcome"]): SyncReport => ({
  outcome,
  invoicesSeen: 4,
  invoicesNew: 2,
  documentsStored: 2,
  failures: [],
  errorMessage: outcome === "failed" ? "boom" : null,
});

function makeDeps(overrides?: {
  syncableIds?: number[];
  sync?: (accountId: number) => Promise<SyncReport>;
}) {
  let nextRunId = 100;
  return {
    accounts: { listSyncableIds: vi.fn(async () => overrides?.syncableIds ?? [1, 2]) },
    runs: {
      startRun: vi.fn(async () => nextRunId++),
      finishRun: vi.fn(async () => undefined),
    },
    sync: vi.fn(overrides?.sync ?? (async () => reportOf("success"))),
    logger: { warn: vi.fn(), error: vi.fn() },
  };
}

describe("RunCoordinator.runAll", () => {
  it("runs every syncable account and records one run each", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.started).toBe(true);
    expect(result.runs.map((r) => r.accountId)).toEqual([1, 2]);
    expect(deps.runs.startRun).toHaveBeenCalledTimes(2);
    expect(deps.runs.finishRun).toHaveBeenCalledTimes(2);
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "success",
      invoicesSeen: 4,
      documentsStored: 2,
      errorMessage: null,
    });
  });

  it("maps a failed report into the run row", async () => {
    const deps = makeDeps({ syncableIds: [1], sync: async () => reportOf("failed") });
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.runs[0]?.outcome).toBe("failed");
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "failed",
      invoicesSeen: 4,
      documentsStored: 2,
      errorMessage: "boom",
    });
  });

  it("continues with the next account when one sync throws unexpectedly", async () => {
    const deps = makeDeps({
      sync: async (accountId) => {
        if (accountId === 1) throw new TypeError("bug");
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const result = await coordinator.runAll("schedule");
    expect(result.runs.map((r) => r.outcome)).toEqual(["failed", "success"]);
    expect(deps.runs.finishRun).toHaveBeenCalledWith(100, {
      outcome: "failed",
      invoicesSeen: 0,
      documentsStored: 0,
      errorMessage: "bug",
    });
    expect(deps.logger.error).toHaveBeenCalledOnce();
  });

  it("skips a tick while a run is already in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      syncableIds: [1],
      sync: async () => {
        await gate;
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const first = coordinator.runAll("schedule");
    const second = await coordinator.runAll("schedule");
    expect(second.started).toBe(false);
    expect(second.runs).toEqual([]);
    expect(deps.logger.warn).toHaveBeenCalledOnce();
    release();
    await expect(first).resolves.toMatchObject({ started: true });
    // After the first run finished, a new one may start again.
    const third = await coordinator.runAll("schedule");
    expect(third.started).toBe(true);
  });
});

describe("RunCoordinator.runAccount", () => {
  it("runs a single account with the manual trigger", async () => {
    const deps = makeDeps();
    const coordinator = new RunCoordinator(deps);
    const summary = await coordinator.runAccount(7, "manual");
    expect(summary).toMatchObject({ accountId: 7, outcome: "success" });
    expect(deps.runs.startRun).toHaveBeenCalledWith(7, "manual");
    expect(deps.accounts.listSyncableIds).not.toHaveBeenCalled();
  });

  it("returns null while a run is in progress", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      syncableIds: [1],
      sync: async () => {
        await gate;
        return reportOf("success");
      },
    });
    const coordinator = new RunCoordinator(deps);
    const all = coordinator.runAll("schedule");
    await expect(coordinator.runAccount(1, "manual")).resolves.toBeNull();
    release();
    await all;
  });
});
