import { createHash, randomUUID } from "node:crypto";
import { dirname, posix } from "node:path";
import { Readable, Writable } from "node:stream";
import { Client } from "basic-ftp";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { FtpConfig } from "../../domain/storage-config.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";
import { collisionCandidate, normalizeRemoteRoot, resolveRemotePath } from "./remote-path.js";

interface FtpClientLike {
  access(options: {
    host: string;
    port: number;
    user: string;
    password: string;
    secure: boolean | "implicit";
  }): Promise<unknown>;
  cd(remoteDirPath: string): Promise<unknown>;
  list(remoteDirPath?: string): Promise<unknown[]>;
  ensureDir(remoteDirPath: string): Promise<unknown>;
  uploadFrom(source: Readable, remotePath: string): Promise<unknown>;
  downloadTo(destination: Writable, remotePath: string): Promise<unknown>;
  rename(fromRemotePath: string, toRemotePath: string): Promise<unknown>;
  remove(remotePath: string, ignoreErrorCodes?: boolean): Promise<unknown>;
  removeDir(remotePath: string): Promise<unknown>;
  size(remotePath: string): Promise<number>;
  close(): void;
}

export type FtpClientFactory = () => FtpClientLike;

export class FtpFileStorage implements FileStorage {
  readonly #config: FtpConfig;
  readonly #clientFactory: FtpClientFactory;
  readonly #probes: ConnectionProbes;
  readonly #root: string;

  constructor(
    config: FtpConfig,
    clientFactory: FtpClientFactory = () => new Client(),
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
        await client.ensureDir(dirname(finalPath));
        await client.ensureDir(dirname(tmpPath));
        await client.uploadFrom(Readable.from(bytes), tmpPath);
        await client.rename(tmpPath, finalPath);
      } catch (cause) {
        await client.remove(tmpPath, true).catch(() => undefined);
        throw new StorageError(`FTP-Speichern fehlgeschlagen: ${relativePath}`, { cause });
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
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      });
      try {
        await client.downloadTo(sink, this.#resolveSafe(relativePath));
        return Buffer.concat(chunks);
      } catch (cause) {
        throw new StorageError(`FTP-Lesen fehlgeschlagen: ${relativePath}`, { cause });
      }
    });
  }

  async remove(relativePath: string): Promise<void> {
    await this.#withClient(async (client) => {
      try {
        await client.remove(this.#resolveSafe(relativePath), true);
      } catch (cause) {
        throw new StorageError(`FTP-Löschen fehlgeschlagen: ${relativePath}`, { cause });
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
              await client.access({
                host: this.#config.host,
                port: this.#config.port,
                user: this.#config.username,
                password: this.#config.password,
                secure:
                  this.#config.secure === "implicit"
                    ? "implicit"
                    : this.#config.secure === "explicit",
              });
            } catch (cause) {
              throw new Error(
                "Anmeldung fehlgeschlagen. Benutzername oder Passwort sind ungültig.",
                { cause },
              );
            }
          },
        },
        {
          id: "path_exists",
          run: async () => {
            if (this.#root === ".") return;
            try {
              await client.cd(this.#root);
            } catch (cause) {
              throw new Error("Der Zielordner wurde nicht gefunden.", { cause });
            }
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
              await client.ensureDir(testDir);
            } catch (cause) {
              throw new Error("Der Zielordner ist vorhanden, aber nicht beschreibbar.", { cause });
            }
          },
        },
        {
          id: "create_test_file",
          run: async () => {
            await client.uploadFrom(Readable.from(Buffer.from("ok")), markerPath);
            const chunks: Buffer[] = [];
            const sink = new Writable({
              write(chunk, _encoding, callback) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                callback();
              },
            });
            await client.downloadTo(sink, markerPath);
            if (!Buffer.concat(chunks).equals(Buffer.from("ok"))) {
              throw new Error("Testdatei enthielt nach dem Schreiben unerwartete Daten.");
            }
          },
        },
        {
          id: "delete_test_file",
          run: async () => {
            await client.remove(markerPath, true);
            await client.removeDir(testDir).catch(() => undefined);
          },
        },
      ]);
    } finally {
      client.close();
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
      await this.#withClient((client) => client.ensureDir(posix.join(this.#root, ".storage-test")));
      return true;
    } catch {
      return false;
    }
  }

  async createDirectory(): Promise<void> {
    await this.#withClient((client) => client.ensureDir(this.#root === "." ? "/" : this.#root));
  }

  async #withClient<T>(operation: (client: FtpClientLike) => Promise<T>): Promise<T> {
    const client = this.#clientFactory();
    try {
      await client.access({
        host: this.#config.host,
        port: this.#config.port,
        user: this.#config.username,
        password: this.#config.password,
        secure:
          this.#config.secure === "implicit" ? "implicit" : this.#config.secure === "explicit",
      });
      return await operation(client);
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new StorageError("FTP-Verbindung fehlgeschlagen", { cause });
    } finally {
      client.close();
    }
  }

  #resolveSafe(relativePath: string): string {
    return resolveRemotePath(this.#root, relativePath, "FTP");
  }

  async #resolveCollision(client: FtpClientLike, target: string): Promise<string> {
    if (!(await exists(client, target))) return target;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = collisionCandidate(target, suffix);
      if (!(await exists(client, candidate))) return candidate;
    }
  }
}

async function exists(client: FtpClientLike, remotePath: string): Promise<boolean> {
  try {
    await client.size(remotePath);
    return true;
  } catch {
    return false;
  }
}
