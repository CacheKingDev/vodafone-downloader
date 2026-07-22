import { describe, expect, it, vi } from "vitest";
import { StorageError } from "../../domain/errors.js";
import type { PaperlessConfig } from "../../domain/storage-config.js";
import type { ConnectionProbes } from "./connection-test-runner.js";
import { PaperlessFileStorage } from "./paperless-file-storage.js";

const config: PaperlessConfig = {
  url: "https://paperless.example.com",
  apiToken: "tok_abc123",
  rejectUnauthorized: true,
  deleteAfterUpload: false,
};

function okProbes(): ConnectionProbes {
  return {
    hostReachable: vi.fn(async () => undefined),
    portReachable: vi.fn(async () => undefined),
  };
}

/** Both PaperlessClientLike methods are required — overrides patch just the one under test. */
function stubClient(overrides: {
  checkAuth?: () => Promise<void>;
  upload?: (
    bytes: Buffer,
    meta: { filename: string; title: string; createdOn?: string },
  ) => Promise<void>;
}) {
  return {
    checkAuth: overrides.checkAuth ?? (async () => undefined),
    upload: overrides.upload ?? (async () => undefined),
  };
}

describe("PaperlessFileStorage.testConnection", () => {
  it("succeeds when host/port/auth all check out", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}), okProbes());
    const result = await storage.testConnection();
    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.id)).toEqual([
      "host_reachable",
      "port_reachable",
      "authenticated",
    ]);
  });

  it("reports a failed authentication step without throwing", async () => {
    const storage = new PaperlessFileStorage(
      config,
      () =>
        stubClient({
          checkAuth: async () => {
            throw new Error("HTTP 401");
          },
        }),
      okProbes(),
    );
    const result = await storage.testConnection();
    expect(result.success).toBe(false);
    expect(result.steps.find((s) => s.id === "authenticated")?.status).toBe("failed");
  });
});

describe("PaperlessFileStorage unsupported operations", () => {
  it("retrieve/remove throw StorageError", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}));
    await expect(storage.retrieve("a.pdf")).rejects.toBeInstanceOf(StorageError);
    await expect(storage.remove("a.pdf")).rejects.toBeInstanceOf(StorageError);
  });

  it("checkReadAccess/checkWriteAccess report false, createDirectory is a no-op", async () => {
    const storage = new PaperlessFileStorage(config, () => stubClient({}));
    expect(await storage.checkReadAccess()).toBe(false);
    expect(await storage.checkWriteAccess()).toBe(false);
    await expect(storage.createDirectory()).resolves.toBeUndefined();
  });
});

describe("PaperlessFileStorage.store (defensive fallback)", () => {
  it("uploads with a title derived from the filename", async () => {
    const upload = vi.fn(async () => undefined);
    const storage = new PaperlessFileStorage(config, () => stubClient({ upload }));
    const result = await storage.store("2026/rechnung-42.pdf", Buffer.from("%PDF-1.4"));
    expect(upload).toHaveBeenCalledWith(
      Buffer.from("%PDF-1.4"),
      expect.objectContaining({ filename: "rechnung-42.pdf", title: "rechnung-42" }),
    );
    expect(result.relativePath).toBe("2026/rechnung-42.pdf");
  });
});
