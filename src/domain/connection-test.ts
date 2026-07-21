/**
 * The fixed vocabulary of connection-test steps (spec section 9). Not every
 * backend can perform every step — "local" has no host/port/auth, so it
 * reports only the steps that apply to it.
 */
export type ConnectionTestStepId =
  | "host_reachable"
  | "port_reachable"
  | "authenticated"
  | "path_exists"
  | "read_access"
  | "write_access"
  | "create_test_file"
  | "delete_test_file";

export interface ConnectionTestStep {
  readonly id: ConnectionTestStepId;
  readonly label: string;
  readonly status: "ok" | "failed" | "skipped";
  readonly message?: string;
}

export interface ConnectionTestResult {
  readonly success: boolean;
  readonly steps: readonly ConnectionTestStep[];
  /** True when the failing step was `path_exists` — lets the UI offer "Ordner automatisch erstellen". */
  readonly pathMissing: boolean;
}
