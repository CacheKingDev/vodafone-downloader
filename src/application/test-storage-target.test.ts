import { describe, expect, it, vi } from "vitest";
import type { ConnectionTestResult } from "../domain/connection-test.js";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { testStorageConfig, testStorageTarget } from "./test-storage-target.js";

function fakeStorage(result: ConnectionTestResult): FileStorage {
  return {
    store: vi.fn(),
    retrieve: vi.fn(),
    remove: vi.fn(),
    testConnection: vi.fn(async () => result),
    checkReadAccess: vi.fn(async () => true),
    checkWriteAccess: vi.fn(async () => true),
    createDirectory: vi.fn(async () => undefined),
  } as unknown as FileStorage;
}

function makeTarget(): StorageTarget {
  return {
    id: 1,
    name: "NAS",
    backend: "sftp",
    destination: "nas.local",
    purpose: "document",
    description: null,
    isDefault: false,
    status: "untested",
    lastTestedAt: null,
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
  };
}

function makeTargets(target: StorageTarget | undefined): StorageTargetUiRepository {
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => target),
    findDefault: vi.fn(async () => undefined),
    nameExists: vi.fn(async () => false),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordTestResult: vi.fn(async () => undefined),
    setDefault: vi.fn(async () => undefined),
    setDisabled: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("testStorageConfig", () => {
  it("delegates straight to the built FileStorage's testConnection", async () => {
    const result: ConnectionTestResult = { success: true, steps: [], pathMissing: false };
    const storage = fakeStorage(result);
    await expect(
      testStorageConfig({ buildFileStorage: () => storage }, { backend: "local" }),
    ).resolves.toBe(result);
  });
});

describe("testStorageTarget", () => {
  it("records a successful test", async () => {
    const target = makeTarget();
    const targets = makeTargets(target);
    const result: ConnectionTestResult = { success: true, steps: [], pathMissing: false };

    await testStorageTarget({ targets, buildFileStorage: () => fakeStorage(result) }, 1);

    expect(targets.setStatus).toHaveBeenCalledWith(1, "testing");
    expect(targets.recordTestResult).toHaveBeenCalledWith(1, { success: true, errorMessage: null });
  });

  it("records an authentication failure with the failing step's message", async () => {
    const target = makeTarget();
    const targets = makeTargets(target);
    const result: ConnectionTestResult = {
      success: false,
      pathMissing: false,
      steps: [
        { id: "host_reachable", label: "Host erreichbar", status: "ok" },
        {
          id: "authenticated",
          label: "Authentifizierung erfolgreich",
          status: "failed",
          message: "Anmeldung fehlgeschlagen. Benutzername oder Passwort sind ungültig.",
        },
        { id: "path_exists", label: "Zielordner vorhanden", status: "skipped" },
      ],
    };

    await testStorageTarget({ targets, buildFileStorage: () => fakeStorage(result) }, 1);

    expect(targets.recordTestResult).toHaveBeenCalledWith(1, {
      success: false,
      errorMessage: "Anmeldung fehlgeschlagen. Benutzername oder Passwort sind ungültig.",
    });
  });

  it("records a missing-write-access failure", async () => {
    const target = makeTarget();
    const targets = makeTargets(target);
    const result: ConnectionTestResult = {
      success: false,
      pathMissing: false,
      steps: [
        {
          id: "write_access",
          label: "Schreibrechte vorhanden",
          status: "failed",
          message: "Der Zielordner ist vorhanden, aber nicht beschreibbar.",
        },
      ],
    };

    await testStorageTarget({ targets, buildFileStorage: () => fakeStorage(result) }, 1);

    expect(targets.recordTestResult).toHaveBeenCalledWith(1, {
      success: false,
      errorMessage: "Der Zielordner ist vorhanden, aber nicht beschreibbar.",
    });
  });

  it("throws when the target does not exist", async () => {
    await expect(
      testStorageTarget({ targets: makeTargets(undefined), buildFileStorage: vi.fn() }, 1),
    ).rejects.toThrow("Speicherziel wurde nicht gefunden.");
  });
});
