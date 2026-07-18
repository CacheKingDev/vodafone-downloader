/**
 * Domain shapes the provider returns. Deliberately not the persistence rows
 * (those live in the Drizzle schema): this layer knows nothing about SQLite.
 *
 * Conventions (design spec section 5): money is integer cents, calendar dates
 * are TEXT 'YYYY-MM-DD'.
 */

/** Plaintext credentials handed to the authenticator. Never persisted here. */
export interface AccountCredentials {
  readonly username: string;
  readonly password: string;
}

/** One document belonging to an invoice (e.g. the bill, the itemised record). */
export interface InvoiceDocumentMeta {
  readonly documentId: string;
  readonly category: string | null;
  readonly subType: string | null;
}

/** An invoice as returned by the portal, mapped into domain terms. */
export interface Invoice {
  readonly number: string;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly subject: string | null;
  readonly contractNumber: string | null;
  readonly documents: readonly InvoiceDocumentMeta[];
}

/** A customer asset discovered via userinfo, e.g. urn:vf-de:cable:can:<CAN>. */
export interface DiscoveredAsset {
  readonly urn: string;
}

/** A downloaded document: decoded bytes plus the MIME type the portal reported. */
export interface DocumentPayload {
  readonly mime: string;
  readonly bytes: Buffer;
}
