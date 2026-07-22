import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { PaperlessConfig } from "../../domain/storage-config.js";
import { PaperlessClient } from "../paperless/paperless-client.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";

interface PaperlessClientLike {
  checkAuth(): Promise<void>;
  upload(
    bytes: Buffer,
    meta: { filename: string; title: string; createdOn?: string },
  ): Promise<void>;
}

export type PaperlessClientFactory = (config: PaperlessConfig) => PaperlessClientLike;

/**
 * Exists solely so the generic "Verbindung testen" wiring
 * (buildFileStorage(config).testConnection()) works for Paperless targets
 * unchanged. The real export path (application/export-to-paperless.ts) talks
 * to PaperlessClient directly instead, because it needs richer metadata
 * (real invoice date, descriptive title) that this port's store(relativePath,
 * bytes) signature cannot carry. retrieve/remove/checkReadAccess/
 * checkWriteAccess/createDirectory are unreachable in practice — Paperless
 * targets can never become the default or a migration participant (spec
 * section 2) — and are implemented defensively rather than left unsafe.
 */
export class PaperlessFileStorage implements FileStorage {
  readonly #config: PaperlessConfig;
  readonly #client: PaperlessClientLike;
  readonly #probes: ConnectionProbes;

  constructor(
    config: PaperlessConfig,
    clientFactory: PaperlessClientFactory = (cfg) => new PaperlessClient(cfg),
    probes: ConnectionProbes = defaultConnectionProbes,
  ) {
    this.#config = config;
    this.#client = clientFactory(config);
    this.#probes = probes;
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    const filename = basename(relativePath);
    const title = filename.replace(/\.[^./]+$/, "");
    try {
      await this.#client.upload(bytes, { filename, title });
    } catch (cause) {
      throw new StorageError(`Paperless-Upload fehlgeschlagen: ${relativePath}`, { cause });
    }
    return {
      relativePath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  async retrieve(_relativePath: string): Promise<Buffer> {
    throw new StorageError("Paperless-Ziele unterstützen kein Lesen einzelner Dokumente.");
  }

  async remove(_relativePath: string): Promise<void> {
    throw new StorageError("Paperless-Ziele unterstützen kein Löschen einzelner Dokumente.");
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const url = new URL(this.#config.url);
    return runConnectionTestSteps([
      { id: "host_reachable", run: () => this.#probes.hostReachable(url.hostname) },
      {
        id: "port_reachable",
        run: () =>
          this.#probes.portReachable(
            url.hostname,
            url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
          ),
      },
      {
        id: "authenticated",
        run: async () => {
          try {
            await this.#client.checkAuth();
          } catch (cause) {
            throw new Error("Anmeldung fehlgeschlagen. API-Token ist ungültig.", { cause });
          }
        },
      },
    ]);
  }

  async checkReadAccess(): Promise<boolean> {
    return false;
  }

  async checkWriteAccess(): Promise<boolean> {
    return false;
  }

  async createDirectory(): Promise<void> {
    // No-op: Paperless has no directory concept to create.
  }
}
