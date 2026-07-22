import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageTarget } from "../../domain/storage-target.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";
import { FtpFileStorage } from "./ftp-file-storage.js";
import { PaperlessFileStorage } from "./paperless-file-storage.js";
import { buildFileStorage, resolveDefaultFileStorage } from "./resolve-file-storage.js";
import { SftpFileStorage } from "./sftp-file-storage.js";
import { SmbFileStorage } from "./smb-file-storage.js";
import { WebDavFileStorage } from "./webdav-file-storage.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vid-resolve-storage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildFileStorage", () => {
  it("builds an AtomicFileStorage for the local backend", async () => {
    const storage = buildFileStorage({ backend: "local" }, dir);
    expect(storage).toBeInstanceOf(AtomicFileStorage);
    const stored = await storage.store("a.pdf", Buffer.from("x"));
    expect(stored.relativePath).toBe("a.pdf");
  });

  it("builds an SftpFileStorage for the sftp backend", () => {
    const storage = buildFileStorage(
      {
        backend: "sftp",
        sftp: {
          host: "nas.local",
          port: 22,
          path: "",
          username: "vid",
          auth: { kind: "password", password: "x" },
        },
      },
      dir,
    );
    expect(storage).toBeInstanceOf(SftpFileStorage);
  });

  it("builds the remaining network backends", () => {
    expect(
      buildFileStorage(
        {
          backend: "smb",
          smb: {
            host: "nas",
            port: 445,
            share: "docs",
            path: "",
            username: "",
            password: "",
            domain: null,
          },
        },
        dir,
      ),
    ).toBeInstanceOf(SmbFileStorage);
    expect(
      buildFileStorage(
        {
          backend: "ftp",
          ftp: {
            host: "nas.local",
            port: 21,
            path: "",
            username: "anonymous",
            password: "",
            secure: "none",
          },
        },
        dir,
      ),
    ).toBeInstanceOf(FtpFileStorage);
    expect(
      buildFileStorage(
        {
          backend: "webdav",
          webdav: {
            url: "https://nas.local/webdav",
            path: "",
            auth: { kind: "basic", username: "u", password: "p" },
            rejectUnauthorized: true,
          },
        },
        dir,
      ),
    ).toBeInstanceOf(WebDavFileStorage);
  });

  it("builds a PaperlessFileStorage for backend='paperless'", () => {
    const storage = buildFileStorage(
      {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: false,
        },
      },
      dir,
    );
    expect(storage).toBeInstanceOf(PaperlessFileStorage);
  });
});

describe("resolveDefaultFileStorage", () => {
  function target(overrides: Partial<StorageTarget> = {}): StorageTarget {
    return {
      id: 1,
      name: "Standard",
      backend: "local",
      destination: "Lokaler Ordner",
      purpose: "document",
      description: null,
      isDefault: true,
      status: "connected",
      lastTestedAt: null,
      lastTestError: null,
      createdAt: 0,
      updatedAt: 0,
      config: { backend: "local" },
      ...overrides,
    };
  }

  it("builds storage for the default target's config", async () => {
    const storage = await resolveDefaultFileStorage(
      { findDefault: vi.fn(async () => target()) },
      dir,
    );
    expect(storage).toBeInstanceOf(AtomicFileStorage);
  });

  it("falls back to local when no default target exists", async () => {
    const storage = await resolveDefaultFileStorage(
      { findDefault: vi.fn(async () => undefined) },
      dir,
    );
    expect(storage).toBeInstanceOf(AtomicFileStorage);
  });
});
