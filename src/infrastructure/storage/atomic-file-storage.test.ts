import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";

let root: string;
let storage: AtomicFileStorage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vid-storage-"));
  storage = new AtomicFileStorage(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const bytes = Buffer.from("%PDF-1.4 test content");

describe("AtomicFileStorage", () => {
  it("stores bytes at the relative path and reports hash and size", async () => {
    const stored = await storage.store("a/2026/rechnung.pdf", bytes);
    expect(stored.relativePath).toBe("a/2026/rechnung.pdf");
    expect(stored.sizeBytes).toBe(bytes.length);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(join(root, "a", "2026", "rechnung.pdf"))).toEqual(bytes);
  });

  it("appends _2 before the extension on collision", async () => {
    await storage.store("a/r.pdf", bytes);
    const second = await storage.store("a/r.pdf", Buffer.from("%PDF- other"));
    expect(second.relativePath).toBe("a/r_2.pdf");
    expect(existsSync(join(root, "a", "r.pdf"))).toBe(true);
    expect(existsSync(join(root, "a", "r_2.pdf"))).toBe(true);
  });

  it("continues the suffix sequence on repeated collisions", async () => {
    await storage.store("r.pdf", bytes);
    await storage.store("r.pdf", bytes);
    const third = await storage.store("r.pdf", bytes);
    expect(third.relativePath).toBe("r_3.pdf");
  });

  it("leaves no temp files behind after storing", async () => {
    await storage.store("x.pdf", bytes);
    expect(readdirSync(join(root, ".tmp"))).toEqual([]);
  });

  it("rejects paths that escape the root", async () => {
    await expect(storage.store("../evil.pdf", bytes)).rejects.toBeInstanceOf(StorageError);
  });

  it("rejects absolute paths", async () => {
    await expect(storage.store("/etc/evil.pdf", bytes)).rejects.toBeInstanceOf(StorageError);
  });
});
