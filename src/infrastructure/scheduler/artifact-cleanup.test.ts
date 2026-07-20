import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger.js";
import { ARTIFACT_MAX_AGE_DAYS, cleanupArtifacts } from "./artifact-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-artifacts-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileAgedDays(name: string, ageDays: number, nowMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "artifact");
  const mtime = new Date(nowMs - ageDays * DAY_MS);
  utimesSync(path, mtime, mtime);
  return path;
}

describe("cleanupArtifacts", () => {
  it("removes files older than the retention and keeps younger ones", async () => {
    const now = Date.now();
    const old = fileAgedDays("old-trace.zip", ARTIFACT_MAX_AGE_DAYS + 1, now);
    const fresh = fileAgedDays("fresh-trace.zip", ARTIFACT_MAX_AGE_DAYS - 1, now);
    const removed = await cleanupArtifacts(dir, logger, now);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("returns 0 for a missing directory", async () => {
    await expect(cleanupArtifacts(join(dir, "nope"), logger)).resolves.toBe(0);
  });

  it("skips subdirectories", async () => {
    const now = Date.now();
    mkdirSync(join(dir, "subdir"));
    const old = fileAgedDays("old.zip", ARTIFACT_MAX_AGE_DAYS + 1, now);
    const removed = await cleanupArtifacts(dir, logger, now);
    expect(removed).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(dir, "subdir"))).toBe(true);
  });
});
