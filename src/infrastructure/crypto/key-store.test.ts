import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CryptoError } from "../../domain/errors.js";
import { loadOrCreateKey } from "./key-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-keystore-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateKey", () => {
  it("prefers the provided key over any file", () => {
    const provided = "ab".repeat(32);
    expect(loadOrCreateKey(dir, provided).toString("hex")).toBe(provided);
  });

  it("generates a 32-byte key when none exists", () => {
    expect(loadOrCreateKey(dir)).toHaveLength(32);
  });

  it("persists the generated key to .secret", () => {
    const key = loadOrCreateKey(dir);
    const stored = readFileSync(join(dir, ".secret"), "utf8").trim();
    expect(stored).toBe(key.toString("hex"));
  });

  it("returns the same key on the next call", () => {
    const first = loadOrCreateKey(dir);
    const second = loadOrCreateKey(dir);
    // Regenerating would silently orphan every stored credential.
    expect(second.toString("hex")).toBe(first.toString("hex"));
  });

  it.skipIf(platform() === "win32")("stores the key with 0600 permissions", () => {
    loadOrCreateKey(dir);
    const mode = statSync(join(dir, ".secret")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a corrupt key file", () => {
    writeFileSync(join(dir, ".secret"), "not-a-key");
    expect(() => loadOrCreateKey(dir)).toThrow(CryptoError);
  });

  it("does not overwrite a corrupt key file", () => {
    writeFileSync(join(dir, ".secret"), "not-a-key");
    expect(() => loadOrCreateKey(dir)).toThrow(CryptoError);
    // Overwriting would destroy a possibly recoverable key.
    expect(readFileSync(join(dir, ".secret"), "utf8")).toBe("not-a-key");
  });
});
