import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { WebDavConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { WebDavFileStorage } from "./webdav-file-storage.js";

const config: WebDavConfig = {
  url: "https://nas.local/webdav",
  path: "vodafone",
  auth: { kind: "basic", username: "vid", password: "secret" },
  rejectUnauthorized: true,
};

const noopProbes: ConnectionProbes = {
  hostReachable: async () => undefined,
  portReachable: async () => undefined,
};

describe("WebDavFileStorage", () => {
  it("authenticates with basic auth and stores/reads a file", async () => {
    const fake = new FakeWebDavClient();
    let seenOptions: unknown;
    const storage = new WebDavFileStorage(
      config,
      (_url, options) => {
        seenOptions = options;
        return fake;
      },
      noopProbes,
    );
    const bytes = Buffer.from("%PDF-1.4 webdav");

    const stored = await storage.store("2026/r.pdf", bytes);

    expect(seenOptions).toMatchObject({ username: "vid", password: "secret" });
    expect(stored).toEqual({
      relativePath: "2026/r.pdf",
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    });
    expect(await storage.retrieve("2026/r.pdf")).toEqual(bytes);
  });

  it("passes an insecure httpsAgent only when rejectUnauthorized is false", async () => {
    let seenOptions: Record<string, unknown> = {};
    new WebDavFileStorage(
      { ...config, rejectUnauthorized: false },
      (_url, options) => {
        seenOptions = options as unknown as Record<string, unknown>;
        return new FakeWebDavClient();
      },
      noopProbes,
    );
    expect(seenOptions.httpsAgent).toBeDefined();

    let secureOptions: Record<string, unknown> = {};
    new WebDavFileStorage(
      config,
      (_url, options) => {
        secureOptions = options as unknown as Record<string, unknown>;
        return new FakeWebDavClient();
      },
      noopProbes,
    );
    expect(secureOptions.httpsAgent).toBeUndefined();
  });

  it("rejects unsafe paths", async () => {
    const storage = new WebDavFileStorage(config, () => new FakeWebDavClient(), noopProbes);
    await expect(storage.store("../evil.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  describe("testConnection", () => {
    it("reports every step as ok on a healthy target", async () => {
      const fake = new FakeWebDavClient();
      const storage = new WebDavFileStorage(config, () => fake, noopProbes);
      const result = await storage.testConnection();
      expect(result.success).toBe(true);
      expect(result.steps.every((step) => step.status === "ok")).toBe(true);
    });

    it("reports an authentication failure and skips later steps", async () => {
      const fake = new FakeWebDavClient();
      fake.failExists = true;
      const storage = new WebDavFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      const authStep = result.steps.find((step) => step.id === "authenticated");
      expect(authStep?.status).toBe("failed");
      expect(authStep?.message).toMatch(/Anmeldung fehlgeschlagen/);
      expect(result.steps.find((step) => step.id === "write_access")?.status).toBe("skipped");
    });

    it("reports missing write access", async () => {
      const fake = new FakeWebDavClient();
      fake.failCreateDirectory = true;
      const storage = new WebDavFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      const writeStep = result.steps.find((step) => step.id === "write_access");
      expect(writeStep?.status).toBe("failed");
      expect(writeStep?.message).toMatch(/nicht beschreibbar/);
    });

    it("flags a missing target folder", async () => {
      const fake = new FakeWebDavClient();
      fake.missingPaths.add("vodafone");
      const storage = new WebDavFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.pathMissing).toBe(true);
    });
  });
});

class FakeWebDavClient {
  readonly files = new Map<string, Buffer>();
  readonly missingPaths = new Set<string>();
  /** Paths that pre-exist on the fake server, as a real WebDAV root/folder would. */
  readonly directories = new Set<string>(["/", "vodafone"]);
  failExists = false;
  failCreateDirectory = false;

  async exists(remotePath: string): Promise<boolean> {
    if (this.failExists) throw new Error("401 Unauthorized");
    if (this.missingPaths.has(remotePath)) return false;
    if (this.files.has(remotePath)) return true;
    return this.directories.has(remotePath);
  }

  async getDirectoryContents(_remotePath: string): Promise<unknown> {
    return [];
  }

  async createDirectory(_remotePath: string, _options?: { recursive?: boolean }): Promise<void> {
    if (this.failCreateDirectory) throw new Error("403 Forbidden");
  }

  async putFileContents(remotePath: string, data: Buffer): Promise<void> {
    this.files.set(remotePath, data);
  }

  async getFileContents(remotePath: string): Promise<Buffer> {
    const bytes = this.files.get(remotePath);
    if (bytes === undefined) throw new Error("404 Not Found");
    return bytes;
  }

  async deleteFile(remotePath: string): Promise<void> {
    this.files.delete(remotePath);
  }

  async moveFile(): Promise<void> {}
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
