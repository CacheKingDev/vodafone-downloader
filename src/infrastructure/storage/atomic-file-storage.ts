import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";

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
    const target = resolve(this.#root, relativePath);
    if (!target.startsWith(this.#root + sep)) {
      throw new StorageError(`Path escapes the downloads root: ${relativePath}`);
    }
    const finalPath = this.resolveCollision(target);

    const tmpDir = join(this.#root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });

    const tmpPath = join(tmpDir, randomUUID());
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);

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
