import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";

/** Reserved Windows device names — any segment matching these is rejected. */
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** Characters in the range U+007F (DEL) and U+0080…U+009F (C1 control). */
const CONTROL_RANGE = /[-]/g;

/**
 * Strips DEL/C1 control characters from a filename segment so the resulting
 * name is safe on Windows, Linux and macOS without changing the visible text.
 */
function sanitizeFileName(name: string): string {
  return name.replace(CONTROL_RANGE, "");
}

/**
 * Throws if any path segment is a reserved Windows device name (case-insensitive)
 * or the directory name `.tmp` (collides with the storage's internal temp folder).
 */
function validateReservedName(relativePath: string): void {
  // Normalize forward-slashes to platform sep so tests (and Linux-origin paths)
  // work on Windows too. Split AFTER normalization — we must not re-join yet.
  const normalized = relativePath.split("/").join(sep);
  const parts = normalized.split(sep);
  // The last part is the filename; every intermediate part is a directory.
  for (const part of parts) {
    if (!part) continue; // skip empty strings from leading/trailing slashes
    if (part === ".tmp") {
      throw new StorageError(`Directory name ".tmp" is reserved for internal use`);
    }
    const upper = part.toUpperCase();
    if (RESERVED_NAMES.has(upper)) {
      throw new StorageError(`Reserved device name in path: ${part}`);
    }
  }
}

/**
 * Writes below a fixed root only. The write is atomic: bytes go to
 * root/.tmp/<uuid>, are fsynced, then renamed to the target — same
 * filesystem, so a crashed run never leaves a half-written PDF in place.
 * Collisions resolve by appending _2, _3, … before the extension.
 */
export class AtomicFileStorage implements FileStorage {
  readonly #root: string;

  constructor(rootDir: string) {
    this.#root = resolve(rootDir);
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    if (isAbsolute(relativePath)) {
      throw new StorageError(`Refusing absolute path: ${relativePath}`);
    }

    // Sanitize invisible control characters so filenames are portable.
    const sanitized = relativePath.split(sep).map(sanitizeFileName).join(sep);
    if (sanitized !== relativePath) {
      relativePath = sanitized;
    }

    validateReservedName(relativePath);

    const target = resolve(this.#root, relativePath);
    if (!target.startsWith(this.#root + sep)) {
      throw new StorageError(`Path escapes the downloads root: ${relativePath}`);
    }
    const finalPath = this.resolveCollision(target);

    const tmpDir = join(this.#root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = join(tmpDir, randomUUID());
    try {
      const handle = await open(tmpPath, "w");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      // Best-effort cleanup: a failed store must not leak tmp debris.
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw error;
    }

    return {
      relativePath: relative(this.#root, finalPath).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  private resolveCollision(target: string): string {
    if (!existsSync(target)) return target;
    const ext = extname(target);
    const base = ext === "" ? target : target.slice(0, -ext.length);
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}_${suffix}${ext}`;
      if (!existsSync(candidate)) return candidate;
    }
  }
}
