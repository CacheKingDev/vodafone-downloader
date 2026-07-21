import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { SmbConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { findSmbClientError, SmbFileStorage, type SmbRunner } from "./smb-file-storage.js";

const config: SmbConfig = {
  host: "nas.local",
  port: 445,
  share: "Daten",
  path: "vodafone",
  username: "vid",
  password: "secret",
  domain: null,
};

const noopProbes: ConnectionProbes = {
  hostReachable: async () => undefined,
  portReachable: async () => undefined,
};

describe("SmbFileStorage", () => {
  it("passes host, port and credentials to smbclient", async () => {
    const state = new FakeSmbState();
    const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);
    await storage.store("2026/r.pdf", Buffer.from("%PDF-1.4"));
    expect(state.baseArgsSeen[0]).toContain("//nas.local/Daten");
    expect(state.baseArgsSeen[0]).toEqual(
      expect.arrayContaining(["-p", "445", "-U", "vid%secret"]),
    );
  });

  it("stores and reads back a file via put/get", async () => {
    const state = new FakeSmbState();
    const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);
    const bytes = Buffer.from("%PDF-1.4 smb");

    const stored = await storage.store("2026/r.pdf", bytes);
    expect(stored).toEqual({
      relativePath: "2026/r.pdf",
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    });
    expect(await storage.retrieve("2026/r.pdf")).toEqual(bytes);
  });

  it("rejects unsafe paths", async () => {
    const storage = new SmbFileStorage(config, makeRunner(new FakeSmbState()), noopProbes);
    await expect(storage.store("../evil.pdf", Buffer.from("x"))).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  describe("testConnection", () => {
    it("reports every step as ok on a healthy target", async () => {
      const state = new FakeSmbState();
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);
      const result = await storage.testConnection();
      expect(result.success).toBe(true);
      expect(result.steps.every((step) => step.status === "ok")).toBe(true);
    });

    it("reports an authentication failure and skips later steps", async () => {
      const state = new FakeSmbState();
      state.failAuth = true;
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(false);
      const authStep = result.steps.find((step) => step.id === "authenticated");
      expect(authStep?.status).toBe("failed");
      expect(authStep?.message).toMatch(/Anmeldung fehlgeschlagen/);
      expect(result.steps.find((step) => step.id === "write_access")?.status).toBe("skipped");
    });

    it("reports missing write access", async () => {
      const state = new FakeSmbState();
      state.failMkdir = true;
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      const result = await storage.testConnection();

      const writeStep = result.steps.find((step) => step.id === "write_access");
      expect(writeStep?.status).toBe("failed");
      expect(writeStep?.message).toMatch(/nicht beschreibbar/);
    });

    it("flags a missing target folder", async () => {
      const state = new FakeSmbState();
      state.directories.delete("vodafone");
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      const result = await storage.testConnection();

      expect(result.pathMissing).toBe(true);
    });

    it("actually deletes the marker file it created, not a doubled-root path", async () => {
      const state = new FakeSmbState();
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      const result = await storage.testConnection();

      expect(result.steps.find((step) => step.id === "delete_test_file")?.status).toBe("ok");
      expect(state.files.has("vodafone/.storage-test/marker.tmp")).toBe(false);
    });

    it("cleans up the test directory itself, not just the marker file, on success", async () => {
      const state = new FakeSmbState();
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      await storage.testConnection();

      expect(state.directories.has("vodafone/.storage-test")).toBe(false);
    });

    it("succeeds on a repeat run even if a prior run left the test directory behind", async () => {
      const state = new FakeSmbState();
      state.directories.add("vodafone/.storage-test");
      const storage = new SmbFileStorage(config, makeRunner(state), noopProbes);

      const result = await storage.testConnection();

      expect(result.success).toBe(true);
      expect(result.steps.find((step) => step.id === "write_access")?.status).toBe("ok");
    });
  });
});

class FakeSmbState {
  readonly files = new Map<string, Buffer>();
  readonly directories = new Set<string>(["vodafone"]);
  readonly baseArgsSeen: string[][] = [];
  failAuth = false;
  failMkdir = false;
}

function makeRunner(state: FakeSmbState): SmbRunner {
  return async (args: readonly string[]) => {
    if (state.failAuth) throw new Error("NT_STATUS_LOGON_FAILURE");
    state.baseArgsSeen.push([...args]);

    const cIndex = args.indexOf("-c");
    const script = args[cIndex + 1] ?? "";
    for (const segment of script.split(";")) {
      // quoteSmbCommandPart doubles backslashes and escapes quotes — reverse
      // that so extracted tokens are real filesystem paths again.
      const tokens = [...segment.matchAll(/"([^"]*)"/g)].map((match) =>
        (match[1] ?? "").replaceAll('\\"', '"').replaceAll("\\\\", "\\"),
      );
      const [name, ...rest] = tokens;
      switch (name) {
        case "put": {
          const [localPath, remotePath] = rest;
          if (localPath !== undefined && remotePath !== undefined) {
            state.files.set(remotePath, await readFile(localPath));
          }
          break;
        }
        case "get": {
          const [remotePath, localPath] = rest;
          const bytes = remotePath === undefined ? undefined : state.files.get(remotePath);
          if (bytes === undefined) throw new Error("NT_STATUS_OBJECT_NAME_NOT_FOUND");
          if (localPath !== undefined) await writeFile(localPath, bytes);
          break;
        }
        case "del": {
          const [remotePath] = rest;
          if (remotePath !== undefined) state.files.delete(remotePath);
          break;
        }
        case "allinfo": {
          const [remotePath] = rest;
          if (
            remotePath !== undefined &&
            !state.directories.has(remotePath) &&
            !state.files.has(remotePath)
          ) {
            throw new Error("NT_STATUS_OBJECT_NAME_NOT_FOUND");
          }
          break;
        }
        case "mkdir": {
          if (state.failMkdir) throw new Error("NT_STATUS_ACCESS_DENIED");
          const [dir] = rest;
          if (dir !== undefined) {
            if (state.directories.has(dir)) throw new Error("NT_STATUS_OBJECT_NAME_COLLISION");
            state.directories.add(dir);
          }
          break;
        }
        case "rmdir": {
          const [dir] = rest;
          if (dir !== undefined) state.directories.delete(dir);
          break;
        }
        default:
          break;
      }
    }
    return { stdout: "", stderr: "" };
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// smbclient's "-c" batch mode exits 0 even when an individual command in the
// script failed — it only prints the failure to stdout. These are the exact
// outputs observed against a real server for "allinfo" on a missing file and
// "mkdir" on an existing directory, both with exit code 0.
describe("findSmbClientError", () => {
  it("extracts the error from an allinfo-on-missing-file output (exit 0)", () => {
    const output = "NT_STATUS_OBJECT_NAME_NOT_FOUND getting alt name for \\Test\\missing.tmp\n";
    expect(findSmbClientError(output)).toBe(
      "NT_STATUS_OBJECT_NAME_NOT_FOUND getting alt name for \\Test\\missing.tmp",
    );
  });

  it("extracts the error from a mkdir-on-existing-directory output (exit 0)", () => {
    const output = "NT_STATUS_OBJECT_NAME_COLLISION making remote directory \\Test\n";
    expect(findSmbClientError(output)).toBe(
      "NT_STATUS_OBJECT_NAME_COLLISION making remote directory \\Test",
    );
  });

  it("returns undefined for a normal directory listing", () => {
    const output = [
      "  .                                   D        0  Tue Jul 21 01:20:09 2026",
      "  ..                                  D        0  Mon Jul 20 22:18:35 2026",
      "",
      "\t\t3905121376 blocks of size 1024. 1566287840 blocks available",
    ].join("\n");
    expect(findSmbClientError(output)).toBeUndefined();
  });

  it("returns undefined for a normal allinfo listing", () => {
    const output = [
      "altname: Test",
      "create_time:    Mon Jul 20 22:18:33 2026 CEST",
      "attributes: D (10)",
    ].join("\n");
    expect(findSmbClientError(output)).toBeUndefined();
  });
});
