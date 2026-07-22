import { describe, expect, it, vi } from "vitest";
import type { StorageTargetUiRepository } from "../domain/ports/repositories.js";
import { createStorageTarget } from "./create-storage-target.js";

function makeTargets(nameExists = false): StorageTargetUiRepository {
  return {
    list: vi.fn(async () => []),
    findById: vi.fn(async () => undefined),
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

describe("createStorageTarget", () => {
  it("rejects an empty name", async () => {
    await expect(
      createStorageTarget(
        { targets: makeTargets() },
        {
          name: "  ",
          purpose: "document",
          description: null,
          config: { backend: "local" },
          tested: false,
        },
      ),
    ).rejects.toThrow("Name ist erforderlich.");
  });

  it("rejects a duplicate name", async () => {
    await expect(
      createStorageTarget(
        { targets: makeTargets(true) },
        {
          name: "NAS",
          purpose: "document",
          description: null,
          config: { backend: "local" },
          tested: false,
        },
      ),
    ).rejects.toThrow(/existiert bereits/);
  });

  it("stores status connected when the config was already tested", async () => {
    const targets = makeTargets();
    await createStorageTarget(
      { targets },
      {
        name: "NAS",
        purpose: "document",
        description: null,
        config: { backend: "local" },
        tested: true,
      },
    );
    expect(targets.create).toHaveBeenCalledWith(expect.objectContaining({ status: "connected" }));
  });

  it("stores status untested when saved without a successful test", async () => {
    const targets = makeTargets();
    await createStorageTarget(
      { targets },
      {
        name: "NAS",
        purpose: "document",
        description: null,
        config: { backend: "local" },
        tested: false,
      },
    );
    expect(targets.create).toHaveBeenCalledWith(expect.objectContaining({ status: "untested" }));
  });
});
