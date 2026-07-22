import { describe, expect, it, vi } from "vitest";
import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { updateStorageTarget } from "./update-storage-target.js";

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 1,
    name: "NAS",
    backend: "sftp",
    destination: "nas.local",
    purpose: "document",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: 100,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config: {
      backend: "sftp",
      sftp: {
        host: "nas.local",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "password", password: "secret" },
      },
    },
    ...overrides,
  };
}

function makeTargets(
  target: StorageTarget | undefined,
  nameExists = false,
): StorageTargetUiRepository {
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => target),
    findDefault: vi.fn(async () => undefined),
    nameExists: vi.fn(async () => nameExists),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordTestResult: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    setDisabled: vi.fn(async () => undefined),
    listEnabledPaperlessTargets: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
  };
}

describe("updateStorageTarget", () => {
  it("throws when the target does not exist", async () => {
    await expect(updateStorageTarget({ targets: makeTargets(undefined) }, 1, {})).rejects.toThrow(
      "Speicherziel wurde nicht gefunden.",
    );
  });

  it("rejects a duplicate name", async () => {
    const targets = makeTargets(makeTarget(), true);
    await expect(updateStorageTarget({ targets }, 1, { name: "Belegt" })).rejects.toThrow(
      /existiert bereits/,
    );
  });

  it("rejects changing the backend type", async () => {
    const targets = makeTargets(makeTarget());
    await expect(
      updateStorageTarget({ targets }, 1, {
        config: {
          backend: "ftp",
          ftp: { host: "h", port: 21, path: "", username: "", password: "", secure: "none" },
        },
      }),
    ).rejects.toThrow(/Speichertyp/);
  });

  it("keeps the existing secret when no new config is supplied", async () => {
    const targets = makeTargets(makeTarget());
    await updateStorageTarget({ targets }, 1, { description: "neu" });
    expect(targets.update).toHaveBeenCalledWith(1, { description: "neu" });
  });

  it("passes a changed config straight through for status reset by the repository", async () => {
    const targets = makeTargets(makeTarget());
    const newConfig = {
      backend: "sftp" as const,
      sftp: {
        host: "nas2.local",
        port: 22,
        path: "",
        username: "vid",
        auth: { kind: "password" as const, password: "secret" },
      },
    };
    await updateStorageTarget({ targets }, 1, { config: newConfig });
    expect(targets.update).toHaveBeenCalledWith(1, { config: newConfig });
  });
});
