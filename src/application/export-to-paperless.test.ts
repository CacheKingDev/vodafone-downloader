import { describe, expect, it, vi } from "vitest";
import type { FileStorage } from "../domain/ports/file-storage.js";
import type { DocumentExportRepository, ExportCandidate } from "../domain/ports/repositories.js";
import type { StorageTarget } from "../domain/storage-target.js";
import { exportToPaperless, type PaperlessUploader } from "./export-to-paperless.js";

function makeTarget(overrides: Partial<StorageTarget> = {}): StorageTarget {
  return {
    id: 10,
    name: "Paperless",
    backend: "paperless",
    destination: "https://paperless.example.com",
    purpose: "export",
    description: null,
    isDefault: false,
    status: "connected",
    lastTestedAt: null,
    lastTestError: null,
    createdAt: 0,
    updatedAt: 0,
    config: {
      backend: "paperless",
      paperless: {
        url: "https://paperless.example.com",
        apiToken: "tok",
        rejectUnauthorized: true,
        deleteAfterUpload: false,
      },
    },
    ...overrides,
  };
}

function candidate(overrides: Partial<ExportCandidate> = {}): ExportCandidate {
  return {
    documentId: 1,
    relativePath: "2026/r-1.pdf",
    accountLabel: "Konto A",
    invoiceNumber: "R-1",
    issuedOn: "2026-06-01",
    ...overrides,
  };
}

function makeStorage(bytes: Buffer = Buffer.from("%PDF-1.4")): FileStorage {
  return {
    store: vi.fn(),
    retrieve: vi.fn(async () => bytes),
    remove: vi.fn(async () => undefined),
    testConnection: vi.fn(),
    checkReadAccess: vi.fn(),
    checkWriteAccess: vi.fn(),
    createDirectory: vi.fn(),
  };
}

function makeExports(
  candidates: ExportCandidate[] = [candidate()],
): DocumentExportRepository & { isFullyExported: ReturnType<typeof vi.fn> } {
  return {
    listExportCandidates: vi.fn(async () => candidates),
    recordSuccess: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    isFullyExported: vi.fn(async () => false),
  };
}

describe("exportToPaperless", () => {
  it("does nothing when there are no enabled paperless targets", async () => {
    const storage = makeStorage();
    const exports = makeExports();
    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => []) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(),
      logger: { warn: vi.fn() },
    });
    expect(storage.retrieve).not.toHaveBeenCalled();
  });

  it("uploads each candidate with a title and the real invoice date, then records success", async () => {
    const storage = makeStorage(Buffer.from("bytes"));
    const exports = makeExports([candidate()]);
    const upload = vi.fn<PaperlessUploader["upload"]>(async () => undefined);
    const uploader: PaperlessUploader = { upload };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 999,
    });

    expect(storage.retrieve).toHaveBeenCalledWith("2026/r-1.pdf");
    expect(upload).toHaveBeenCalledWith(
      Buffer.from("bytes"),
      expect.objectContaining({ filename: "r-1.pdf", createdOn: "2026-06-01" }),
    );
    expect(upload.mock.calls[0]![1].title).toContain("Konto A");
    expect(upload.mock.calls[0]![1].title).toContain("R-1");
    expect(exports.recordSuccess).toHaveBeenCalledWith(1, 10, 999);
  });

  it("records failure and continues when one upload throws", async () => {
    const storage = makeStorage();
    const exports = makeExports([candidate({ documentId: 1 }), candidate({ documentId: 2 })]);
    let call = 0;
    const uploader: PaperlessUploader = {
      upload: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("boom");
      }),
    };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.recordFailure).toHaveBeenCalledWith(1, 10, "boom", 1);
    expect(exports.recordSuccess).toHaveBeenCalledWith(2, 10, 1);
  });

  it("deletes the local file once all targets with deleteAfterUpload succeeded", async () => {
    const storage = makeStorage();
    const target = makeTarget({
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const exports = makeExports([candidate()]);
    exports.isFullyExported.mockResolvedValue(true);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [target]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.isFullyExported).toHaveBeenCalledWith(1, [10]);
    expect(storage.remove).toHaveBeenCalledWith("2026/r-1.pdf");
  });

  it("does not delete when deleteAfterUpload is off", async () => {
    const storage = makeStorage();
    const exports = makeExports([candidate()]);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [makeTarget()]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("does not delete when isFullyExported is still false (another target pending)", async () => {
    const storage = makeStorage();
    const target = makeTarget({
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const exports = makeExports([candidate()]);
    exports.isFullyExported.mockResolvedValue(false);
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: { listEnabledPaperlessTargets: vi.fn(async () => [target]) },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("deletes once the last missing target succeeds, even though THAT target's own deleteAfterUpload is off", async () => {
    // Regression test: target 10 (deleteAfterUpload=true) already succeeded in
    // an earlier run, so it has no candidate left; target 20
    // (deleteAfterUpload=false) is the one completing the set THIS run. The
    // delete must still fire — gating the check on "the just-succeeded
    // target's own flag" instead of "does any enabled target want delete"
    // would silently never re-trigger it here.
    const storage = makeStorage();
    const targetWithDelete = makeTarget({
      id: 10,
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless.example.com",
          apiToken: "tok",
          rejectUnauthorized: true,
          deleteAfterUpload: true,
        },
      },
    });
    const targetWithoutDelete = makeTarget({
      id: 20,
      config: {
        backend: "paperless",
        paperless: {
          url: "https://paperless2.example.com",
          apiToken: "tok2",
          rejectUnauthorized: true,
          deleteAfterUpload: false,
        },
      },
    });
    const exports: DocumentExportRepository & { isFullyExported: ReturnType<typeof vi.fn> } = {
      listExportCandidates: vi.fn(async (storageTargetId: number) =>
        storageTargetId === 20 ? [candidate()] : [],
      ),
      recordSuccess: vi.fn(async () => undefined),
      recordFailure: vi.fn(async () => undefined),
      isFullyExported: vi.fn(async () => true),
    };
    const uploader: PaperlessUploader = { upload: vi.fn(async () => undefined) };

    await exportToPaperless({
      targets: {
        listEnabledPaperlessTargets: vi.fn(async () => [targetWithDelete, targetWithoutDelete]),
      },
      exports,
      resolveDefaultStorage: vi.fn(async () => storage),
      buildPaperlessClient: vi.fn(() => uploader),
      logger: { warn: vi.fn() },
      now: () => 1,
    });

    expect(exports.isFullyExported).toHaveBeenCalledWith(1, [10, 20]);
    expect(storage.remove).toHaveBeenCalledWith("2026/r-1.pdf");
  });
});
