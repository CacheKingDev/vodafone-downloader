import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logging/logger.js";

/** Traces hold tokens and cookies (design spec section 8) — keep them briefly. */
export const ARTIFACT_MAX_AGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort removal of artifact files older than the retention window.
 * A missing directory is fine (no failure has produced artifacts yet); a file
 * that cannot be removed is logged and skipped, never fatal.
 */
export async function cleanupArtifacts(
  dir: string,
  logger: Logger,
  nowMs: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = nowMs - ARTIFACT_MAX_AGE_DAYS * DAY_MS;
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      await rm(path);
      removed += 1;
    } catch (error) {
      logger.warn({ err: error, path }, "could not clean up artifact");
    }
  }
  if (removed > 0) {
    logger.info({ removed, dir }, "removed expired artifacts");
  }
  return removed;
}
