import type { StorageBackendKind, StorageConfig } from "./storage-config.js";

export type StoragePurpose = "document" | "backup" | "export";

/**
 * draft/untested/testing/connected/failed track a target's own connection
 * state; disabled is a user choice; migration_pending/migrating/migration_failed
 * track a target becoming (or having tried to become) the default (spec
 * section 12). A target's status is independent of whether it IS the default —
 * `isDefault` is a separate flag so the previous default can stay "connected"
 * and active while a migration to a new default is still in flight.
 */
export type StorageTargetStatus =
  | "draft"
  | "untested"
  | "testing"
  | "connected"
  | "failed"
  | "disabled"
  | "migration_pending"
  | "migrating"
  | "migration_failed";

/** Everything the overview list and API responses may expose. Never includes secrets. */
export interface StorageTargetSummary {
  readonly id: number;
  readonly name: string;
  readonly backend: StorageBackendKind;
  /** Non-secret host/path hint, e.g. "nas.example.com/share · rechnungen" (see describeStorageDestination). */
  readonly destination: string;
  readonly purpose: StoragePurpose;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly status: StorageTargetStatus;
  readonly lastTestedAt: number | null;
  readonly lastTestError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The full record including decrypted connection config — server-side only. */
export interface StorageTarget extends StorageTargetSummary {
  readonly config: StorageConfig;
}

export interface CreateStorageTargetInput {
  readonly name: string;
  readonly purpose: StoragePurpose;
  readonly description: string | null;
  readonly config: StorageConfig;
  readonly status: StorageTargetStatus;
}

/**
 * `config: undefined` means "keep the existing encrypted config as-is" — the
 * secret-retention path for editing without re-entering a password (spec
 * section 11). Passing a config always resets status to "untested".
 */
export interface UpdateStorageTargetInput {
  readonly name?: string;
  readonly purpose?: StoragePurpose;
  readonly description?: string | null;
  readonly config?: StorageConfig;
}
