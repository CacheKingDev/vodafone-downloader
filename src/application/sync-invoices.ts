import {
  AuthenticationFailedError,
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../domain/errors.js";
import type { FilenameRenderer, FileStorage, PdfValidator } from "../domain/ports/file-storage.js";
import type {
  AccountRepository,
  InvoiceRepository,
  SettingsRepository,
} from "../domain/ports/repositories.js";
import type { VodafoneProvider } from "../domain/ports/vodafone-provider.js";

export interface DocumentFailure {
  readonly remoteDocumentId: string;
  readonly message: string;
}

export interface SyncReport {
  readonly outcome: "success" | "partial" | "failed";
  readonly invoicesSeen: number;
  readonly invoicesNew: number;
  readonly documentsStored: number;
  readonly failures: DocumentFailure[];
  readonly errorMessage: string | null;
}

export interface SyncDeps {
  readonly provider: VodafoneProvider;
  readonly accounts: AccountRepository;
  readonly invoices: InvoiceRepository;
  readonly settings: SettingsRepository;
  readonly storage: FileStorage;
  readonly renderFilename: FilenameRenderer;
  readonly validatePdf: PdfValidator;
  readonly now?: () => number;
}

/**
 * One sync for one account: discover new invoices, then store every document
 * still in pending or failed (only `stored` is final). Returns a report; run
 * persistence is milestone 4's job. Error policy (spec section 3): auth
 * failures park the account as needs_action and are NEVER retried; a changed
 * portal parks it as error; network faults leave the status alone. Unexpected
 * errors are rethrown — a bug must not masquerade as a failed run.
 */
export async function syncAccount(deps: SyncDeps, accountId: number): Promise<SyncReport> {
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  let invoicesSeen = 0;
  let invoicesNew = 0;
  let documentsStored = 0;
  const failures: DocumentFailure[] = [];

  const failed = (errorMessage: string): SyncReport => ({
    outcome: "failed",
    invoicesSeen,
    invoicesNew,
    documentsStored,
    failures,
    errorMessage,
  });

  const account = await deps.accounts.findById(accountId);
  if (account === undefined) return failed(`Account ${accountId} does not exist`);
  if (!account.enabled) return failed(`Account "${account.label}" is disabled`);
  if (account.status === "needs_action") {
    return failed(
      `Account "${account.label}" needs action; skipping to protect the portal account`,
    );
  }

  try {
    const session = await deps.provider.getSession(
      account.credentials,
      account.session ?? undefined,
    );
    // The facade returns the identical object when the existing session is
    // still valid — only a genuinely new session is worth re-encrypting.
    if (session !== account.session) {
      await deps.accounts.saveSession(accountId, session);
    }

    const invoices = await deps.provider.listInvoices(session, account.customerUrn);
    invoicesSeen = invoices.length;
    const known = await deps.invoices.existingNumbers(accountId);
    for (const entry of invoices) {
      if (known.has(entry.number)) continue;
      if (account.backfillFrom !== null && entry.issuedOn < account.backfillFrom) continue;
      await deps.invoices.insertInvoice(accountId, entry);
      invoicesNew += 1;
      known.add(entry.number);
    }

    const template = await deps.settings.filenameTemplate();
    const retryable = await deps.invoices.listRetryableDocuments(accountId);
    for (const doc of retryable) {
      try {
        const payload = await deps.provider.fetchDocument(
          session,
          account.customerUrn,
          doc.remoteDocumentId,
        );
        deps.validatePdf(payload.bytes);
        const relativePath = deps.renderFilename(template, {
          accountLabel: account.label,
          invoiceNumber: doc.invoiceNumber,
          issuedOn: doc.issuedOn,
          subType: doc.subType,
          contractNumber: doc.contractNumber,
        });
        const stored = await deps.storage.store(relativePath, payload.bytes);
        await deps.invoices.markStored(doc.id, stored, now());
        documentsStored += 1;
      } catch (error) {
        // A dead session or a rate limit dooms every remaining download —
        // abort the run. Anything else is local to this one document.
        if (error instanceof SessionExpiredError || error instanceof RateLimitedError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ remoteDocumentId: doc.remoteDocumentId, message });
        await deps.invoices.markFailed(doc.id, message);
      }
    }

    await deps.accounts.setStatus(accountId, "ok");
    return {
      outcome: failures.length === 0 ? "success" : "partial",
      invoicesSeen,
      invoicesNew,
      documentsStored,
      failures,
      errorMessage: null,
    };
  } catch (error) {
    if (error instanceof AuthenticationFailedError) {
      await deps.accounts.setStatus(accountId, "needs_action", error.message);
      return failed(error.message);
    }
    if (error instanceof PortalContractError) {
      await deps.accounts.setStatus(accountId, "error", error.message);
      return failed(error.message);
    }
    if (
      error instanceof SessionExpiredError ||
      error instanceof TransientNetworkError ||
      error instanceof RateLimitedError
    ) {
      return failed(error.message);
    }
    throw error;
  }
}
