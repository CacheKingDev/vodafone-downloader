import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import type {
  ConnectionTestResult,
  ConnectionTestStep,
  ConnectionTestStepId,
} from "../../domain/connection-test.js";

const STEP_LABELS: Record<ConnectionTestStepId, string> = {
  host_reachable: "Host erreichbar",
  port_reachable: "Port erreichbar",
  authenticated: "Authentifizierung erfolgreich",
  path_exists: "Zielordner vorhanden",
  read_access: "Leserechte vorhanden",
  write_access: "Schreibrechte vorhanden",
  create_test_file: "Testdatei erstellen",
  delete_test_file: "Testdatei wieder löschen",
};

export interface ConnectionTestStepSpec {
  readonly id: ConnectionTestStepId;
  run(): Promise<void>;
}

/**
 * Runs steps in order and stops at the first failure — everything after it is
 * reported "skipped" rather than attempted, since e.g. testing write access
 * after auth failed would only produce a confusing second error.
 */
export async function runConnectionTestSteps(
  specs: readonly ConnectionTestStepSpec[],
): Promise<ConnectionTestResult> {
  const steps: ConnectionTestStep[] = [];
  let failed = false;
  let pathMissing = false;

  for (const spec of specs) {
    if (failed) {
      steps.push({ id: spec.id, label: STEP_LABELS[spec.id], status: "skipped" });
      continue;
    }
    try {
      await spec.run();
      steps.push({ id: spec.id, label: STEP_LABELS[spec.id], status: "ok" });
    } catch (error) {
      failed = true;
      if (spec.id === "path_exists") pathMissing = true;
      steps.push({
        id: spec.id,
        label: STEP_LABELS[spec.id],
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { success: !failed, steps, pathMissing };
}

/** Resolves the hostname. Throws with a German message on failure. */
export async function probeHostReachable(host: string): Promise<void> {
  try {
    await lookup(host);
  } catch (cause) {
    throw new Error("Der Host ist nicht erreichbar.", { cause });
  }
}

/** Opens a raw TCP connection to confirm the port accepts connections. */
export async function probePortReachable(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const fail = (message: string): void => {
      socket.destroy();
      reject(new Error(message));
    };
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("timeout", () => fail("Zeitüberschreitung beim Verbindungsaufbau zum Port."));
    socket.once("error", (cause) => fail(`Der Port ist nicht erreichbar: ${cause.message}`));
  });
}

/**
 * The real DNS/TCP probes, injected into each network adapter so tests can
 * substitute fakes instead of hitting real DNS/sockets (mirrors the
 * client-factory injection pattern already used for the protocol clients).
 */
export interface ConnectionProbes {
  hostReachable(host: string): Promise<void>;
  portReachable(host: string, port: number): Promise<void>;
}

export const defaultConnectionProbes: ConnectionProbes = {
  hostReachable: probeHostReachable,
  portReachable: probePortReachable,
};
