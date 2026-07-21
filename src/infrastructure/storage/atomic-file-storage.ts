import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import { runConnectionTestSteps } from "./connection-test-runner.js";

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
const CONNECTION_TEST_MARKER = ".storage-test/marker.tmp";

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
    const target = this.#resolveSafe(relativePath);
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

  async retrieve(relativePath: string): Promise<Buffer> {
    const target = this.#resolveSafe(relativePath);
    try {
      return await readFile(target);
    } catch (cause) {
      throw new StorageError(`Failed to read ${relativePath}`, { cause });
    }
  }

  async remove(relativePath: string): Promise<void> {
    const target = this.#resolveSafe(relativePath);
    try {
      await rm(target, { force: true });
    } catch (cause) {
      throw new StorageError(`Failed to remove ${relativePath}`, { cause });
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return runConnectionTestSteps([
      { id: "path_exists", run: () => access(this.#root, constants.F_OK) },
      {
        id: "read_access",
        run: async () => {
          if (!(await this.checkReadAccess())) throw new Error("Der Zielordner ist nicht lesbar.");
        },
      },
      {
        id: "write_access",
        run: async () => {
          if (!(await this.checkWriteAccess())) {
            throw new Error("Der Zielordner ist nicht beschreibbar.");
          }
        },
      },
      {
        id: "create_test_file",
        run: async () => {
          const written = await this.store(CONNECTION_TEST_MARKER, Buffer.from("ok"));
          const bytes = await this.retrieve(written.relativePath);
          if (!bytes.equals(Buffer.from("ok"))) {
            throw new Error("Testdatei enthielt nach dem Schreiben unerwartete Daten.");
          }
        },
      },
      {
        id: "delete_test_file",
        run: async () => {
          await this.remove(CONNECTION_TEST_MARKER);
          await rm(join(this.#root, ".storage-test"), { recursive: true, force: true });
        },
      },
    ]);
  }

  async checkReadAccess(): Promise<boolean> {
    try {
      await access(this.#root, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async checkWriteAccess(): Promise<boolean> {
    try {
      await access(this.#root, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  async createDirectory(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  #resolveSafe(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new StorageError(`Refusing absolute path: ${relativePath}`);
    }

    const sanitized = relativePath.split(sep).map(sanitizeFileName).join(sep);
    validateReservedName(sanitized);

    const target = resolve(this.#root, sanitized);
    if (!target.startsWith(this.#root + sep)) {
      throw new StorageError(`Path escapes the downloads root: ${relativePath}`);
    }
    return target;
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
