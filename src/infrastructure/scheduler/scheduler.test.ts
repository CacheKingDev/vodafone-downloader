import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../domain/errors.js";
import type { Logger } from "../logging/logger.js";
import { SyncScheduler } from "./scheduler.js";

let artifactsDir: string;
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), "vid-scheduler-"));
});

afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function schedulerWith(schedule: string): SyncScheduler {
  return new SyncScheduler({
    schedule,
    artifactsDir,
    runAll: vi.fn(async () => undefined),
    logger,
  });
}

describe("SyncScheduler", () => {
  it("throws ConfigError on an invalid cron expression at start", () => {
    const scheduler = schedulerWith("not a cron");
    expect(() => scheduler.start()).toThrow(ConfigError);
  });

  it("reports the next sync run only while started", () => {
    const scheduler = schedulerWith("0 6 * * *");
    expect(scheduler.nextSyncRun()).toBeNull();
    scheduler.start();
    const next = scheduler.nextSyncRun();
    expect(next).toBeInstanceOf(Date);
    expect(next?.getTime()).toBeGreaterThan(Date.now());
    scheduler.stop();
    expect(scheduler.nextSyncRun()).toBeNull();
  });

  it("start and stop are idempotent", () => {
    const scheduler = schedulerWith("0 6 * * *");
    scheduler.start();
    scheduler.start();
    const next = scheduler.nextSyncRun();
    expect(next).toBeInstanceOf(Date);
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.nextSyncRun()).toBeNull();
  });
});
