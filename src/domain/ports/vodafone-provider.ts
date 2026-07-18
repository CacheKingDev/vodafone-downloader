import type { AccountCredentials, DiscoveredAsset, DocumentPayload, Invoice } from "../invoice.js";
import type { AuthSession } from "../vodafone-session.js";

/**
 * The provider seen by the application layer. The two-part implementation
 * (browser authenticator + HTTP client) is hidden behind this port; use cases
 * never learn there is a browser involved.
 */
export interface VodafoneProvider {
  /** Runs the auth cascade and returns a valid session. */
  getSession(credentials: AccountCredentials, existing?: AuthSession): Promise<AuthSession>;

  /** Lists the customer assets (URNs) available to the authenticated user. */
  discoverAssets(session: AuthSession): Promise<DiscoveredAsset[]>;

  /** Lists the invoices for one customer URN. */
  listInvoices(session: AuthSession, customerUrn: string): Promise<Invoice[]>;

  /** Downloads one document as decoded bytes. */
  fetchDocument(
    session: AuthSession,
    customerUrn: string,
    documentId: string,
  ): Promise<DocumentPayload>;
}
