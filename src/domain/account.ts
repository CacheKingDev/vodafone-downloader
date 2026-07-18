import type { AccountCredentials } from "./invoice.js";
import type { AuthSession } from "./vodafone-session.js";

export type AccountStatus = "ok" | "needs_action" | "error";

/**
 * The decrypted domain view of an account. Repositories decrypt on read;
 * this layer never sees ciphertext or the cipher.
 */
export interface Account {
  readonly id: number;
  readonly label: string;
  readonly credentials: AccountCredentials;
  readonly customerUrn: string;
  readonly enabled: boolean;
  /** 'YYYY-MM-DD' — invoices issued before this date are never synced. Null = all. */
  readonly backfillFrom: string | null;
  readonly status: AccountStatus;
  readonly session: AuthSession | null;
}
