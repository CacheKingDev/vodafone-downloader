import { SessionExpiredError } from "../../domain/errors.js";
import type {
  AccountCredentials,
  DiscoveredAsset,
  DocumentPayload,
  Invoice,
} from "../../domain/invoice.js";
import type { VodafoneProvider } from "../../domain/ports/vodafone-provider.js";
import { type AuthSession, isSessionExpired } from "../../domain/vodafone-session.js";

/** The slice of the authenticator the facade needs. Keeps the facade testable. */
export interface AuthenticatorLike {
  fullLogin(credentials: AccountCredentials): Promise<AuthSession>;
  silentRenewal(existing: AuthSession): Promise<AuthSession>;
}

/** The slice of the API client the facade needs. */
export interface ApiClientLike {
  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]>;
  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]>;
  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload>;
}

export interface ProviderDeps {
  readonly authenticator: AuthenticatorLike;
  readonly apiClient: ApiClientLike;
  readonly silentRenewalSupported: boolean;
  readonly now?: () => number;
}

/**
 * The port implementation. Owns the auth cascade and hides the browser/HTTP
 * split from the application layer. The data methods delegate straight to the
 * API client — the facade adds no behaviour there beyond the shared session.
 */
export class VodafoneProviderFacade implements VodafoneProvider {
  readonly #deps: ProviderDeps;
  readonly #now: () => number;

  constructor(deps: ProviderDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async getSession(credentials: AccountCredentials, existing?: AuthSession): Promise<AuthSession> {
    if (existing !== undefined && !isSessionExpired(existing, this.#now())) {
      return existing;
    }
    if (existing !== undefined && this.#deps.silentRenewalSupported) {
      try {
        return await this.#deps.authenticator.silentRenewal(existing);
      } catch (error) {
        if (!(error instanceof SessionExpiredError)) throw error;
        // Session truly gone — fall through to a full login.
      }
    }
    return this.#deps.authenticator.fullLogin(credentials);
  }

  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]> {
    return this.#deps.apiClient.discoverAssets(session);
  }

  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]> {
    return this.#deps.apiClient.listInvoices(session, customerUrn);
  }

  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload> {
    return this.#deps.apiClient.fetchDocument(session, customerUrn, documentId);
  }
}
