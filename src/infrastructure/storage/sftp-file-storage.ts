import { createHash, randomUUID } from "node:crypto";
import { dirname, posix } from "node:path";
import SftpClient from "ssh2-sftp-client";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { SftpConfig } from "../../domain/storage-config.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";
import { collisionCandidate, normalizeRemoteRoot, resolveRemotePath } from "./remote-path.js";

interface SftpClientLike {
  connect(options: SftpClient.ConnectOptions): Promise<unknown>;
  exists(remotePath: string): Promise<false | "d" | "-" | "l">;
  list(remotePath: string): Promise<unknown[]>;
  mkdir(remotePath: string, recursive?: boolean): Promise<unknown>;
  get(remotePath: string): Promise<string | NodeJS.WritableStream | Buffer>;
  put(input: Buffer, remotePath: string): Promise<unknown>;
  rename(remoteSourcePath: string, remoteDestPath: string): Promise<unknown>;
  delete(remotePath: string, noErrorOK?: boolean): Promise<unknown>;
  rmdir(remotePath: string, recursive?: boolean): Promise<unknown>;
  end(): Promise<unknown>;
}

export type SftpClientFactory = () => SftpClientLike;

export class SftpFileStorage implements FileStorage {
  readonly #config: SftpConfig;
  readonly #clientFactory: SftpClientFactory;
  readonly #probes: ConnectionProbes;
  readonly #root: string;

  constructor(
    config: SftpConfig,
    clientFactory: SftpClientFactory = () => new SftpClient(),
    probes: ConnectionProbes = defaultConnectionProbes,
  ) {
    this.#config = config;
    this.#clientFactory = clientFactory;
    this.#probes = probes;
    this.#root = normalizeRemoteRoot(config.path);
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    return this.#withClient(async (client) => {
      const target = this.#resolveSafe(relativePath);
      const finalPath = await this.#resolveCollision(client, target);
      const tmpPath = posix.join(this.#root, ".tmp", randomUUID());

      try {
        await client.mkdir(dirname(finalPath), true);
        await client.mkdir(dirname(tmpPath), true);
        await client.put(bytes, tmpPath);
        await client.rename(tmpPath, finalPath);
      } catch (cause) {
        await client.delete(tmpPath, true).catch(() => undefined);
        throw new StorageError(`SFTP-Speichern fehlgeschlagen: ${relativePath}`, { cause });
      }

      return {
        relativePath: posix.relative(this.#root, finalPath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
      };
    });
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    return this.#withClient(async (client) => {
      const target = this.#resolveSafe(relativePath);
      try {
        const data = await client.get(target);
        if (!Buffer.isBuffer(data)) {
          throw new StorageError(`SFTP-Lesen lieferte keine Bytes: ${relativePath}`);
        }
        return data;
      } catch (cause) {
        if (cause instanceof StorageError) throw cause;
        throw new StorageError(`SFTP-Lesen fehlgeschlagen: ${relativePath}`, { cause });
      }
    });
  }

  async remove(relativePath: string): Promise<void> {
    await this.#withClient(async (client) => {
      const target = this.#resolveSafe(relativePath);
      try {
        await client.delete(target, true);
      } catch (cause) {
        throw new StorageError(`SFTP-Löschen fehlgeschlagen: ${relativePath}`, { cause });
      }
    });
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const client = this.#clientFactory();
    const testDir = posix.join(this.#root, ".storage-test");
    const markerPath = posix.join(testDir, "marker.tmp");
    try {
      return await runConnectionTestSteps([
        { id: "host_reachable", run: () => this.#probes.hostReachable(this.#config.host) },
        {
          id: "port_reachable",
          run: () => this.#probes.portReachable(this.#config.host, this.#config.port),
        },
        {
          id: "authenticated",
          run: async () => {
            try {
              await client.connect(this.#connectOptions());
            } catch (cause) {
              throw new Error(
                "Anmeldung fehlgeschlagen. Benutzername, Passwort oder Schlüssel sind ungültig.",
                { cause },
              );
            }
          },
        },
        {
          id: "path_exists",
          run: async () => {
            if (this.#root === ".") return;
            const kind = await client.exists(this.#root);
            if (kind === false) throw new Error("Der Zielordner wurde nicht gefunden.");
          },
        },
        {
          id: "read_access",
          run: async () => {
            try {
              await client.list(this.#root === "." ? "/" : this.#root);
            } catch (cause) {
              throw new Error("Der Zielordner ist nicht lesbar.", { cause });
            }
          },
        },
        {
          id: "write_access",
          run: async () => {
            try {
              await client.mkdir(testDir, true);
            } catch (cause) {
              throw new Error("Der Zielordner ist vorhanden, aber nicht beschreibbar.", { cause });
            }
          },
        },
        {
          id: "create_test_file",
          run: async () => {
            await client.put(Buffer.from("ok"), markerPath);
            const data = await client.get(markerPath);
            if (!Buffer.isBuffer(data) || !data.equals(Buffer.from("ok"))) {
              throw new Error("Testdatei enthielt nach dem Schreiben unerwartete Daten.");
            }
          },
        },
        {
          id: "delete_test_file",
          run: async () => {
            await client.delete(markerPath, true);
            await client.rmdir(testDir, true).catch(() => undefined);
          },
        },
      ]);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async checkReadAccess(): Promise<boolean> {
    try {
      await this.#withClient((client) => client.list(this.#root === "." ? "/" : this.#root));
      return true;
    } catch {
      return false;
    }
  }

  async checkWriteAccess(): Promise<boolean> {
    try {
      await this.#withClient((client) =>
        client.mkdir(posix.join(this.#root, ".storage-test"), true),
      );
      return true;
    } catch {
      return false;
    }
  }

  async createDirectory(): Promise<void> {
    await this.#withClient((client) => client.mkdir(this.#root === "." ? "/" : this.#root, true));
  }

  async #withClient<T>(operation: (client: SftpClientLike) => Promise<T>): Promise<T> {
    const client = this.#clientFactory();
    try {
      await client.connect(this.#connectOptions());
      return await operation(client);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("SFTP-Verbindung fehlgeschlagen", { cause });
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  #connectOptions(): SftpClient.ConnectOptions {
    const base = {
      host: this.#config.host,
      port: this.#config.port,
      username: this.#config.username,
    };
    if (this.#config.auth.kind === "password") {
      return { ...base, password: this.#config.auth.password };
    }
    return {
      ...base,
      privateKey: this.#config.auth.privateKey,
      ...(this.#config.auth.passphrase === null
        ? {}
        : { passphrase: this.#config.auth.passphrase }),
    };
  }

  #resolveSafe(relativePath: string): string {
    return resolveRemotePath(this.#root, relativePath, "SFTP");
  }

  async #resolveCollision(client: SftpClientLike, target: string): Promise<string> {
    if ((await client.exists(target)) === false) return target;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = collisionCandidate(target, suffix);
      if ((await client.exists(candidate)) === false) return candidate;
    }
  }
}
