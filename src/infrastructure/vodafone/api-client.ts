import {
  PortalContractError,
  RateLimitedError,
  SessionExpiredError,
  TransientNetworkError,
} from "../../domain/errors.js";
import type { DiscoveredAsset, DocumentPayload, Invoice } from "../../domain/invoice.js";
import type { AuthSession } from "../../domain/vodafone-session.js";
import {
  invoiceDocumentSchema,
  invoiceListSchema,
  parsePortal,
  userinfoSchema,
} from "./schemas.js";

/** A narrow, injectable fetch: avoids the extra static members on `typeof fetch`. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Apigee gateway credentials for the portal's own "MyVFWeb" first-party
 * client. Found by comparing our bearer-only request (rejected with
 * `apigee.INVALID_CLIENT_CREDENTIALS`, HTTP 401, even with a fresh valid
 * token) against the real portal frontend's own request headers: the gateway
 * checks these independently of the OAuth token. Static per client, not
 * per-session — same values the public web app ships.
 */
const API_KEY = "aEIoMCae0A933wBL0bLlS6SwSBfkKwM5";
const CLIENT_ID = "MyVFWeb";

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly maxRetries?: number;
  readonly baseDelayMs?: number;
  readonly capDelayMs?: number;
}

/**
 * HTTP client for the Vodafone API. Every call goes through `request`, which
 * owns the status→error mapping and the retry policy (transient faults only).
 * Auth is never retried here; that is the authenticator's and the cascade's job.
 */
export class VodafoneApiClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #capDelayMs: number;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#fetch = options.fetchImpl ?? fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 500;
    this.#capDelayMs = options.capDelayMs ?? 10_000;
  }

  async discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]> {
    const raw = await this.request(session, "/tmf-api/openid/v4/userinfo");
    const info = parsePortal(userinfoSchema, raw, "userinfo");
    // userinfo is an array; the assets live on the first (only) entry.
    const first = info[0];
    if (first === undefined) return [];
    // Each product (broadband, TV, ...) under one billing account shares that
    // account's URN. We operate at the account level (listInvoices takes only
    // a customerUrn), so duplicates here are the same selectable account, not
    // distinct choices — collapse them to one.
    const seen = new Set<string>();
    const assets: DiscoveredAsset[] = [];
    for (const asset of first.userAssets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      assets.push({ urn: asset.id });
    }
    return assets;
  }

  async listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]> {
    const raw = await this.request(session, `/customer/${customerUrn}/invoice`);
    const response = parsePortal(invoiceListSchema, raw, "invoice");
    return response.invoices.map((portalInvoice) => ({
      number: portalInvoice.number,
      issuedOn: portalInvoice.date,
      dueOn: portalInvoice.dueDate ?? null,
      amountCents: Math.round(portalInvoice.amount * 100),
      // The portal omits a currency field; cable billing is EUR.
      currency: "EUR",
      subject: portalInvoice.about ?? null,
      contractNumber:
        portalInvoice.referencedBillingAccount?.productCategory?.[0]?.contractNumber?.[0] ?? null,
      documents: portalInvoice.documents.map((doc) => ({
        documentId: doc.documentId,
        category: doc.category ?? null,
        subType: doc.subType ?? null,
      })),
    }));
  }

  async fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload> {
    const raw = await this.request(
      session,
      `/customer/${customerUrn}/invoiceDocument/${documentId}`,
    );
    const doc = parsePortal(invoiceDocumentSchema, raw, "invoiceDocument");
    return { mime: doc.mime, bytes: Buffer.from(doc.data, "base64") };
  }

  /** Performs one GET with retries, returns parsed JSON, or throws a mapped error. */
  protected async request(session: AuthSession, path: string): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": API_KEY,
            "x-vf-clientid": CLIENT_ID,
            "x-vf-api": String(Date.now()),
            referer: "https://www.vodafone.de/",
          },
        });
        return await this.handleResponse(response);
      } catch (error) {
        const mapped =
          error instanceof TransientNetworkError
            ? error
            : this.isMappedError(error)
              ? error
              : new TransientNetworkError("Network request failed", { cause: error });
        if (mapped instanceof TransientNetworkError && attempt < this.#maxRetries) {
          await this.delay(attempt);
          attempt += 1;
          continue;
        }
        throw mapped;
      }
    }
  }

  private async handleResponse(response: Response): Promise<unknown> {
    if (response.status === 401 || response.status === 403) {
      throw new SessionExpiredError(`Portal rejected the token (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      throw new RateLimitedError("Portal returned HTTP 429");
    }
    if (response.status >= 500) {
      throw new TransientNetworkError(`Portal returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new PortalContractError(`Unexpected HTTP ${response.status} from portal`);
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new PortalContractError("Portal response was not valid JSON", { cause });
    }
  }

  private isMappedError(error: unknown): boolean {
    return (
      error instanceof SessionExpiredError ||
      error instanceof RateLimitedError ||
      error instanceof PortalContractError
    );
  }

  private async delay(attempt: number): Promise<void> {
    const exponential = this.#baseDelayMs * 2 ** attempt;
    const capped = Math.min(this.#capDelayMs, exponential);
    const jittered = capped / 2 + Math.random() * (capped / 2);
    await new Promise((resolve) => setTimeout(resolve, jittered));
  }
}
