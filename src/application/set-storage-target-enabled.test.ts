import { describe, expect, it, vi } from "vitest";
import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { setStorageTargetEnabled } from "./set-storage-target-enabled.js";

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 1,
    name: "NAS",
    backend: "local",
    destination: "Lokaler Ordner",
    purpose: "document",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: null,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config: { backend: "local" },
    ...overrides,
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

describe("setStorageTargetEnabled", () => {
  it("throws when the target is missing", async () => {
    await expect(
      setStorageTargetEnabled({ targets: makeTargets(undefined) }, 1, false),
    ).rejects.toThrow("Speicherziel wurde nicht gefunden.");
  });

  it("refuses to disable the default target", async () => {
    const targets = makeTargets(makeTarget({ isDefault: true }));
    await expect(setStorageTargetEnabled({ targets }, 1, false)).rejects.toThrow(
      /Standardspeicher/,
    );
  });

  it("disables a non-default target", async () => {
    const targets = makeTargets(makeTarget());
    await setStorageTargetEnabled({ targets }, 1, false);
    expect(targets.setDisabled).toHaveBeenCalledWith(1, true);
  });

  it("re-enables a disabled target", async () => {
    const targets = makeTargets(makeTarget({ status: "disabled" }));
    await setStorageTargetEnabled({ targets }, 1, true);
    expect(targets.setDisabled).toHaveBeenCalledWith(1, false);
  });
});
