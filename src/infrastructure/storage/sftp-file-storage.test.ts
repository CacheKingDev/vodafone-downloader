import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { SftpConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { SftpFileStorage } from "./sftp-file-storage.js";

const passwordConfig: SftpConfig = {
  host: "nas.local",
  port: 22,
  path: "vodafone",
  username: "vid",
  auth: { kind: "password", password: "secret" },
};

const keyConfig: SftpConfig = {
  host: "nas.local",
  port: 2222,
  path: "",
  username: "key-user",
  auth: { kind: "key", privateKey: "PRIVATE", passphrase: "phrase" },
};

const noopProbes: ConnectionProbes = {
  hostReachable: async () => undefined,
  portReachable: async () => undefined,
};

describe("SftpFileStorage", () => {
  it("connects with password auth and stores via temp file plus rename", async () => {
    const fake = new FakeSftpClient();
    const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);
    const bytes = Buffer.from("%PDF-1.4");

    const stored = await storage.store("2026/r.pdf", bytes);

    expect(fake.connectOptions[0]).toMatchObject({
      host: "nas.local",
      port: 22,
      username: "vid",
      password: "secret",
    });
    expect(fake.renames).toHaveLength(1);
    expect(fake.renames[0]?.to).toBe("vodafone/2026/r.pdf");
    expect(await storage.retrieve("2026/r.pdf")).toEqual(bytes);
    expect(stored).toEqual({
      relativePath: "2026/r.pdf",
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    });
    expect(fake.endCalls).toBeGreaterThanOrEqual(2);
  });

  it("connects with private key auth", async () => {
    const fake = new FakeSftpClient();
    const storage = new SftpFileStorage(keyConfig, () => fake, noopProbes);

    const result = await storage.testConnection();

    expect(result.success).toBe(true);
    expect(fake.connectOptions[0]).toMatchObject({
      host: "nas.local",
      port: 2222,
      username: "key-user",
      privateKey: "PRIVATE",
      passphrase: "phrase",
    });
  });

  it("appends a suffix on collision", async () => {
    const fake = new FakeSftpClient();
    const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);

    await storage.store("r.pdf", Buffer.from("first"));
    const second = await storage.store("r.pdf", Buffer.from("second"));

    expect(second.relativePath).toBe("r_2.pdf");
    expect(await storage.retrieve("r.pdf")).toEqual(Buffer.from("first"));
    expect(await storage.retrieve("r_2.pdf")).toEqual(Buffer.from("second"));
  });

  it("rejects unsafe paths", async () => {
    const storage = new SftpFileStorage(passwordConfig, () => new FakeSftpClient(), noopProbes);

    await expect(storage.store("../evil.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(storage.retrieve("/etc/passwd")).rejects.toBeInstanceOf(StorageError);
    await expect(storage.remove(".tmp/internal.pdf")).rejects.toBeInstanceOf(StorageError);
  });

  it("wraps client errors as StorageError", async () => {
    const fake = new FakeSftpClient();
    fake.failGet = true;
    const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);

    await expect(storage.retrieve("missing.pdf")).rejects.toBeInstanceOf(StorageError);
  });

  describe("testConnection", () => {
    it("reports every step as ok on a healthy target", async () => {
      const fake = new FakeSftpClient();
      const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(true);
      expect(result.steps.map((step) => step.status)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);
    });

    it("stops at authentication and skips the remaining steps", async () => {
      const fake = new FakeSftpClient();
      fake.failConnect = true;
      const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      const authIndex = result.steps.findIndex((step) => step.id === "authenticated");
      const authStep = result.steps[authIndex];
      expect(authStep?.status).toBe("failed");
      expect(authStep?.message).toMatch(/Anmeldung fehlgeschlagen/);
      const laterSteps = result.steps.slice(authIndex + 1);
      expect(laterSteps.every((step) => step.status === "skipped")).toBe(true);
    });

    it("reports missing write access without touching later steps", async () => {
      const fake = new FakeSftpClient();
      fake.failMkdir = true;
      const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      const writeStep = result.steps.find((step) => step.id === "write_access");
      expect(writeStep?.status).toBe("failed");
      expect(writeStep?.message).toMatch(/nicht beschreibbar/);
    });

    it("flags a missing target path so the UI can offer to create it", async () => {
      const fake = new FakeSftpClient();
      const storage = new SftpFileStorage(passwordConfig, () => fake, noopProbes);
      fake.files.clear();
      fake.missingPaths.add("vodafone");

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      expect(result.pathMissing).toBe(true);
    });
  });
});

class FakeSftpClient {
  readonly files = new Map<string, Buffer>();
  readonly missingPaths = new Set<string>();
  /** Root paths that pre-exist on the fake server, as a real SFTP root would. */
  readonly directories = new Set<string>(["vodafone", "."]);
  readonly connectOptions: unknown[] = [];
  readonly renames: Array<{ from: string; to: string }> = [];
  endCalls = 0;
  failGet = false;
  failConnect = false;
  failMkdir = false;

  async connect(options: unknown): Promise<void> {
    if (this.failConnect) throw new Error("auth rejected");
    this.connectOptions.push(options);
  }

  async exists(remotePath: string): Promise<false | "d" | "-"> {
    if (this.missingPaths.has(remotePath)) return false;
    if (this.files.has(remotePath)) return "-";
    if (this.directories.has(remotePath)) return "d";
    return false;
  }

  async list(_remotePath: string): Promise<unknown[]> {
    return [];
  }

  async mkdir(_remotePath: string, _recursive?: boolean): Promise<string> {
    if (this.failMkdir) throw new Error("permission denied");
    return "ok";
  }

  async get(remotePath: string): Promise<Buffer> {
    if (this.failGet) throw new Error("boom");
    const bytes = this.files.get(remotePath);
    if (bytes === undefined) throw new Error("missing");
    return bytes;
  }

  async put(input: Buffer, remotePath: string): Promise<string> {
    this.files.set(remotePath, Buffer.from(input));
    return "ok";
  }

  async rename(remoteSourcePath: string, remoteDestPath: string): Promise<string> {
    const bytes = this.files.get(remoteSourcePath);
    if (bytes === undefined) throw new Error("missing tmp");
    this.files.delete(remoteSourcePath);
    this.files.set(remoteDestPath, bytes);
    this.renames.push({ from: remoteSourcePath, to: remoteDestPath });
    return "ok";
  }

  async delete(remotePath: string, _noErrorOK?: boolean): Promise<string> {
    this.files.delete(remotePath);
    return "ok";
  }

  async rmdir(_remotePath: string, _recursive?: boolean): Promise<string> {
    return "ok";
  }

  async end(): Promise<boolean> {
    this.endCalls += 1;
    return true;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
