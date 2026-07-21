import { describe, expect, it, vi } from "vitest";
import type { Account } from "../domain/account.js";
import {
  AuthenticationFailedError,
  DocumentValidationError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../domain/errors.js";
import type { Invoice } from "../domain/invoice.js";
import type { RetryableDocument } from "../domain/ports/repositories.js";
import type { AuthSession } from "../domain/vodafone-session.js";
import { type SyncDeps, syncAccount } from "./sync-invoices.js";

const session: AuthSession = { accessToken: "tok", expiresAt: 9_999_999_999, storageState: "{}" };

const baseAccount: Account = {
  id: 1,
  label: "Privat",
  credentials: { username: "u", password: "p" },
  customerUrn: "urn:vf-de:cable:can:0000000001",
  enabled: true,
  backfillFrom: null,
  status: "ok",
  session,
};

const invoiceOf = (number: string, issuedOn: string): Invoice => ({
  number,
  issuedOn,
  dueOn: null,
  amountCents: 4599,
  currency: "EUR",
  subject: null,
  contractNumber: null,
  documents: [{ documentId: `${number}-doc`, category: null, subType: "Rechnung" }],
});

const retryableOf = (id: number, remoteDocumentId: string): RetryableDocument => ({
  id,
  remoteDocumentId,
  subType: "Rechnung",
  invoiceNumber: "123456789012",
  issuedOn: "2026-03-01",
  contractNumber: null,
});

const pdfBytes = Buffer.from(`%PDF-1.4\n${"x".repeat(200)}`);

function makeDeps(overrides?: {
  account?: Account | undefined;
  invoices?: Invoice[];
  retryable?: RetryableDocument[];
  known?: Set<string>;
}): SyncDeps & {
  accounts: {
    findById: ReturnType<typeof vi.fn>;
    saveSession: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    listSyncableIds: ReturnType<typeof vi.fn>;
  };
  invoices: {
    existingNumbers: ReturnType<typeof vi.fn>;
    insertInvoice: ReturnType<typeof vi.fn>;
    listRetryableDocuments: ReturnType<typeof vi.fn>;
    markStored: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  provider: {
    getSession: ReturnType<typeof vi.fn>;
    discoverAssets: ReturnType<typeof vi.fn>;
    listInvoices: ReturnType<typeof vi.fn>;
    fetchDocument: ReturnType<typeof vi.fn>;
  };
  storage: {
    store: ReturnType<typeof vi.fn>;
    retrieve: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    testConnection: ReturnType<typeof vi.fn>;
  };
} {
  const account = overrides && "account" in overrides ? overrides.account : baseAccount;
  return {
    provider: {
      getSession: vi.fn(async () => session),
      discoverAssets: vi.fn(async () => []),
      listInvoices: vi.fn(async () => overrides?.invoices ?? []),
      fetchDocument: vi.fn(async () => ({ mime: "application/pdf", bytes: pdfBytes })),
    },
    accounts: {
      findById: vi.fn(async () => account),
      saveSession: vi.fn(async () => undefined),
      setStatus: vi.fn(async () => undefined),
      listSyncableIds: vi.fn(async () => []),
    },
    invoices: {
      existingNumbers: vi.fn(async () => overrides?.known ?? new Set<string>()),
      insertInvoice: vi.fn(async () => undefined),
      listRetryableDocuments: vi.fn(async () => overrides?.retryable ?? []),
      markStored: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      resetDocument: vi.fn(async () => undefined),
    },
    settings: {
      filenameTemplate: vi.fn(async () => "{invoice_number}.pdf"),
      syncSchedule: vi.fn(async () => "0 6 * * *"),
    },
    storage: {
      store: vi.fn(async (relativePath: string, bytes: Buffer) => ({
        relativePath,
        sha256: "hash",
        sizeBytes: bytes.length,
      })),
      retrieve: vi.fn(async () => Buffer.from("")),
      remove: vi.fn(async () => undefined),
      testConnection: vi.fn(async () => ({ success: true, steps: [], pathMissing: false })),
      checkReadAccess: vi.fn(async () => true),
      checkWriteAccess: vi.fn(async () => true),
      createDirectory: vi.fn(async () => undefined),
    },
    renderFilename: (_template, context) => `${context.invoiceNumber}.pdf`,
    validatePdf: () => undefined,
    now: () => 1_700_000_000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("syncAccount guards", () => {
  it("fails without touching the portal when the account does not exist", async () => {
    const deps = makeDeps({ account: undefined });
    const report = await syncAccount(deps, 42);
    expect(report.outcome).toBe("failed");
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });

  it("fails without portal contact when the account is disabled", async () => {
    const deps = makeDeps({ account: { ...baseAccount, enabled: false } });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(report.errorMessage).toMatch(/disabled/);
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });

  it("fails without portal contact when the account needs action", async () => {
    const deps = makeDeps({ account: { ...baseAccount, status: "needs_action" } });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.provider.getSession).not.toHaveBeenCalled();
  });
});

describe("syncAccount discovery", () => {
  it("persists a renewed session", async () => {
    const renewed: AuthSession = { ...session, accessToken: "new" };
    const deps = makeDeps();
    deps.provider.getSession.mockResolvedValue(renewed);
    await syncAccount(deps, 1);
    expect(deps.accounts.saveSession).toHaveBeenCalledWith(1, renewed);
  });

  it("does not re-persist an unchanged session", async () => {
    const deps = makeDeps();
    deps.provider.getSession.mockResolvedValue(session);
    await syncAccount(deps, 1);
    expect(deps.accounts.saveSession).not.toHaveBeenCalled();
  });

  it("skips known invoices and counts only new ones", async () => {
    const deps = makeDeps({
      invoices: [invoiceOf("111111111111", "2026-01-01"), invoiceOf("222222222222", "2026-02-01")],
      known: new Set(["111111111111"]),
    });
    const report = await syncAccount(deps, 1);
    expect(report.invoicesSeen).toBe(2);
    expect(report.invoicesNew).toBe(1);
    expect(deps.invoices.insertInvoice).toHaveBeenCalledTimes(1);
  });

  it("skips invoices issued before backfillFrom", async () => {
    const deps = makeDeps({
      account: { ...baseAccount, backfillFrom: "2026-02-01" },
      invoices: [invoiceOf("111111111111", "2026-01-31"), invoiceOf("222222222222", "2026-02-01")],
    });
    const report = await syncAccount(deps, 1);
    expect(report.invoicesNew).toBe(1);
  });

  it("inserts a number only once when the portal repeats it in one response", async () => {
    const deps = makeDeps({
      invoices: [invoiceOf("111111111111", "2026-01-01"), invoiceOf("111111111111", "2026-01-01")],
    });
    const report = await syncAccount(deps, 1);
    expect(report.invoicesNew).toBe(1);
    expect(deps.invoices.insertInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("syncAccount document download", () => {
  it("stores retryable documents and reports success", async () => {
    const deps = makeDeps({ retryable: [retryableOf(10, "doc-1")] });
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("success");
    expect(report.documentsStored).toBe(1);
    expect(deps.invoices.markStored).toHaveBeenCalledWith(
      10,
      { relativePath: "123456789012.pdf", sha256: "hash", sizeBytes: pdfBytes.length },
      1_700_000_000,
    );
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "ok");
  });

  it("marks a document failed and continues, reporting partial", async () => {
    // SyncDeps fields are readonly — build a variant instead of mutating.
    const base = makeDeps({ retryable: [retryableOf(10, "doc-1"), retryableOf(11, "doc-2")] });
    let call = 0;
    const deps = {
      ...base,
      validatePdf: (): void => {
        call += 1;
        if (call === 1) throw new DocumentValidationError("not a PDF");
      },
    };
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("partial");
    expect(report.documentsStored).toBe(1);
    expect(report.failures).toEqual([{ remoteDocumentId: "doc-1", message: "not a PDF" }]);
    expect(base.invoices.markFailed).toHaveBeenCalledWith(10, "not a PDF");
  });

  it("aborts the run when the session dies mid-download", async () => {
    const deps = makeDeps({ retryable: [retryableOf(10, "doc-1"), retryableOf(11, "doc-2")] });
    deps.provider.fetchDocument.mockRejectedValue(new SessionExpiredError("gone"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.invoices.markFailed).not.toHaveBeenCalled();
  });
});

describe("syncAccount logging", () => {
  it("logs start and finish of a successful sync", async () => {
    const deps = makeDeps({
      invoices: [invoiceOf("111111111111", "2026-01-01")],
      retryable: [retryableOf(10, "doc-1")],
    });
    await syncAccount(deps, 1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat" },
      "sync started",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      {
        accountId: 1,
        label: "Privat",
        outcome: "success",
        invoicesSeen: 1,
        invoicesNew: 1,
        documentsStored: 1,
        failedCount: 0,
      },
      "sync finished",
    );
  });

  it("logs a document failure with the remote document id", async () => {
    const deps = makeDeps({ retryable: [retryableOf(10, "doc-1")] });
    deps.provider.fetchDocument.mockRejectedValue(new Error("bad pdf"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("partial");
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 1, remoteDocumentId: "doc-1", message: "bad pdf" },
      "document download failed",
    );
  });

  it("logs a warning when an account is skipped as disabled", async () => {
    const deps = makeDeps({ account: { ...baseAccount, enabled: false } });
    await syncAccount(deps, 1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat" },
      "sync skipped: account disabled",
    );
  });

  it("logs a warning when an account is skipped as needs_action", async () => {
    const deps = makeDeps({ account: { ...baseAccount, status: "needs_action" } });
    await syncAccount(deps, 1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat" },
      "sync skipped: account needs action",
    );
  });

  it("logs a warning when the account does not exist", async () => {
    const deps = makeDeps({ account: undefined });
    await syncAccount(deps, 42);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 42 },
      "sync skipped: account not found",
    );
  });

  it("logs a warning when authentication is rejected", async () => {
    const deps = makeDeps();
    deps.provider.getSession.mockRejectedValue(new AuthenticationFailedError("rejected"));
    await syncAccount(deps, 1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat", err: expect.any(AuthenticationFailedError) },
      "sync failed: authentication rejected, account parked",
    );
  });

  it("logs an error when the portal contract changed", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new PortalContractError("changed"));
    await syncAccount(deps, 1);
    expect(deps.logger.error).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat", err: expect.any(PortalContractError) },
      "sync failed: portal contract changed",
    );
  });

  it("logs a warning on a transient error", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new TransientNetworkError("offline"));
    await syncAccount(deps, 1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      { accountId: 1, label: "Privat", err: expect.any(TransientNetworkError) },
      "sync failed: transient error",
    );
  });
});

describe("syncAccount error mapping", () => {
  it("sets needs_action on AuthenticationFailedError and never retries", async () => {
    const deps = makeDeps();
    deps.provider.getSession.mockRejectedValue(new AuthenticationFailedError("rejected"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "needs_action", "rejected");
    expect(deps.provider.getSession).toHaveBeenCalledTimes(1);
  });

  it("sets error on PortalContractError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new PortalContractError("changed"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).toHaveBeenCalledWith(1, "error", "changed");
  });

  it("keeps the status on TransientNetworkError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new TransientNetworkError("offline"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("keeps the status on RateLimitedError", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new RateLimitedError("429"));
    const report = await syncAccount(deps, 1);
    expect(report.outcome).toBe("failed");
    expect(deps.accounts.setStatus).not.toHaveBeenCalled();
  });

  it("rethrows unexpected errors — bugs must be loud", async () => {
    const deps = makeDeps();
    deps.provider.listInvoices.mockRejectedValue(new TypeError("bug"));
    await expect(syncAccount(deps, 1)).rejects.toBeInstanceOf(TypeError);
  });
});
