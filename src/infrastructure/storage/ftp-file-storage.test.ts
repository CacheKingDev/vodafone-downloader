import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { FtpConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { FtpFileStorage } from "./ftp-file-storage.js";

const config: FtpConfig = {
  host: "nas.local",
  port: 21,
  path: "vodafone",
  username: "vid",
  password: "secret",
  secure: "none",
};

const noopProbes: ConnectionProbes = {
  hostReachable: async () => undefined,
  portReachable: async () => undefined,
};

describe("FtpFileStorage", () => {
  it("stores via temp file plus rename and reads it back", async () => {
    const fake = new FakeFtpClient();
    const storage = new FtpFileStorage(config, () => fake, noopProbes);
    const bytes = Buffer.from("%PDF-1.4");

    const stored = await storage.store("2026/r.pdf", bytes);

    expect(fake.accessCalls[0]).toMatchObject({
      host: "nas.local",
      port: 21,
      user: "vid",
      password: "secret",
      secure: false,
    });
    expect(await storage.retrieve("2026/r.pdf")).toEqual(bytes);
    expect(stored).toEqual({
      relativePath: "2026/r.pdf",
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    });
    expect(fake.closeCalls).toBeGreaterThanOrEqual(2);
  });

  it("appends a suffix on collision", async () => {
    const fake = new FakeFtpClient();
    const storage = new FtpFileStorage(config, () => fake, noopProbes);

    await storage.store("r.pdf", Buffer.from("first"));
    const second = await storage.store("r.pdf", Buffer.from("second"));

    expect(second.relativePath).toBe("r_2.pdf");
  });

  it("rejects unsafe paths", async () => {
    const storage = new FtpFileStorage(config, () => new FakeFtpClient(), noopProbes);
    await expect(storage.store("../evil.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  describe("testConnection", () => {
    it("reports every step as ok on a healthy target", async () => {
      const fake = new FakeFtpClient();
      const storage = new FtpFileStorage(config, () => fake, noopProbes);
      const result = await storage.testConnection();
      expect(result.success).toBe(true);
      expect(result.steps.every((step) => step.status === "ok")).toBe(true);
    });

    it("reports an authentication failure and skips later steps", async () => {
      const fake = new FakeFtpClient();
      fake.failAccess = true;
      const storage = new FtpFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      const authStep = result.steps.find((step) => step.id === "authenticated");
      expect(authStep?.status).toBe("failed");
      expect(authStep?.message).toMatch(/Anmeldung fehlgeschlagen/);
      expect(result.steps.find((step) => step.id === "write_access")?.status).toBe("skipped");
    });

    it("reports missing write access", async () => {
      const fake = new FakeFtpClient();
      fake.failEnsureDir = true;
      const storage = new FtpFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      const writeStep = result.steps.find((step) => step.id === "write_access");
      expect(writeStep?.status).toBe("failed");
      expect(writeStep?.message).toMatch(/nicht beschreibbar/);
    });

    it("flags a missing target folder", async () => {
      const fake = new FakeFtpClient();
      fake.missingPaths.add("vodafone");
      const storage = new FtpFileStorage(config, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.pathMissing).toBe(true);
    });
  });
});

class FakeFtpClient {
  readonly files = new Map<string, Buffer>();
  readonly missingPaths = new Set<string>();
  readonly accessCalls: unknown[] = [];
  closeCalls = 0;
  failAccess = false;
  failEnsureDir = false;

  async access(options: unknown): Promise<void> {
    if (this.failAccess) throw new Error("530 Login incorrect");
    this.accessCalls.push(options);
  }

  async cd(path: string): Promise<void> {
    if (this.missingPaths.has(path)) throw new Error("550 No such directory");
  }

  async list(_path?: string): Promise<unknown[]> {
    return [];
  }

  async ensureDir(_dir: string): Promise<void> {
    if (this.failEnsureDir) throw new Error("550 Permission denied");
  }

  async uploadFrom(source: NodeJS.ReadableStream, remotePath: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.files.set(remotePath, Buffer.concat(chunks));
  }

  async downloadTo(destination: Writable, remotePath: string): Promise<void> {
    const bytes = this.files.get(remotePath);
    if (bytes === undefined) throw new Error("550 No such file");
    await new Promise<void>((resolve, reject) => {
      destination.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }

  async rename(fromRemotePath: string, toRemotePath: string): Promise<void> {
    const bytes = this.files.get(fromRemotePath);
    if (bytes === undefined) throw new Error("missing tmp");
    this.files.delete(fromRemotePath);
    this.files.set(toRemotePath, bytes);
  }

  async remove(remotePath: string, _ignoreErrorCodes?: boolean): Promise<void> {
    this.files.delete(remotePath);
  }

  async removeDir(_remotePath: string): Promise<void> {}

  async size(remotePath: string): Promise<number> {
    const bytes = this.files.get(remotePath);
    if (bytes === undefined) throw new Error("550 No such file");
    return bytes.length;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
