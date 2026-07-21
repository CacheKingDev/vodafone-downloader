import { createHash } from "node:crypto";
import { Agent } from "node:https";
import { dirname, posix } from "node:path";
import type { WebDAVClientOptions } from "webdav";
import { AuthType, createClient } from "webdav";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { WebDavConfig } from "../../domain/storage-config.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";
import { collisionCandidate, normalizeRemoteRoot, resolveRemotePath } from "./remote-path.js";

interface WebDavClientLike {
  exists(remotePath: string): Promise<boolean>;
  getDirectoryContents(remotePath: string): Promise<unknown>;
  createDirectory(remotePath: string, options?: { recursive?: boolean }): Promise<unknown>;
  putFileContents(
    remotePath: string,
    data: Buffer,
    options?: { overwrite?: boolean },
  ): Promise<unknown>;
  getFileContents(remotePath: string): Promise<Buffer | string | ArrayBuffer>;
  deleteFile(remotePath: string): Promise<unknown>;
  moveFile(
    fromRemotePath: string,
    toRemotePath: string,
    options?: { overwrite?: boolean },
  ): Promise<unknown>;
}

export type WebDavClientFactory = (url: string, options: WebDAVClientOptions) => WebDavClientLike;

export class WebDavFileStorage implements FileStorage {
  readonly #config: WebDavConfig;
  readonly #client: WebDavClientLike;
  readonly #probes: ConnectionProbes;
  readonly #root: string;

  constructor(
    config: WebDavConfig,
    clientFactory: WebDavClientFactory = (url, options) =>
      createClient(url, options) as unknown as WebDavClientLike,
    probes: ConnectionProbes = defaultConnectionProbes,
  ) {
    this.#config = config;
    this.#client = clientFactory(config.url, this.#clientOptions());
    this.#probes = probes;
    this.#root = normalizeRemoteRoot(config.path);
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    const target = this.#resolveSafe(relativePath);
    const finalPath = await this.#resolveCollision(target);
    try {
      await this.#client.createDirectory(dirname(finalPath), { recursive: true });
      await this.#client.putFileContents(finalPath, bytes, { overwrite: true });
    } catch (cause) {
      throw new StorageError(`WebDAV-Speichern fehlgeschlagen: ${relativePath}`, { cause });
    }
    return {
      relativePath: posix.relative(this.#root, finalPath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    try {
      const data = await this.#client.getFileContents(this.#resolveSafe(relativePath));
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") return Buffer.from(data);
      return Buffer.from(data);
    } catch (cause) {
      throw new StorageError(`WebDAV-Lesen fehlgeschlagen: ${relativePath}`, { cause });
    }
  }

  async remove(relativePath: string): Promise<void> {
    try {
      await this.#client.deleteFile(this.#resolveSafe(relativePath));
    } catch {
      return;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const testDir = posix.join(this.#root, ".storage-test");
    const markerPath = posix.join(testDir, "marker.tmp");
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
            await this.#client.exists("/");
          } catch (cause) {
            throw new Error("Anmeldung fehlgeschlagen. Zugangsdaten sind ungültig.", { cause });
          }
        },
      },
      {
        id: "path_exists",
        run: async () => {
          if (this.#root === ".") return;
          if (!(await this.#client.exists(this.#root))) {
            throw new Error("Der Zielordner wurde nicht gefunden.");
          }
        },
      },
      {
        id: "read_access",
        run: async () => {
          try {
            await this.#client.getDirectoryContents(this.#root === "." ? "/" : this.#root);
          } catch (cause) {
            throw new Error("Der Zielordner ist nicht lesbar.", { cause });
          }
        },
      },
      {
        id: "write_access",
        run: async () => {
          try {
            await this.#client.createDirectory(testDir, { recursive: true });
          } catch (cause) {
            throw new Error("Der Zielordner ist vorhanden, aber nicht beschreibbar.", { cause });
          }
        },
      },
      {
        id: "create_test_file",
        run: async () => {
          await this.#client.putFileContents(markerPath, Buffer.from("ok"), { overwrite: true });
          const data = await this.#client.getFileContents(markerPath);
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          if (!bytes.equals(Buffer.from("ok"))) {
            throw new Error("Testdatei enthielt nach dem Schreiben unerwartete Daten.");
          }
        },
      },
      {
        id: "delete_test_file",
        run: async () => {
          await this.#client.deleteFile(markerPath);
          await this.#client.deleteFile(testDir).catch(() => undefined);
        },
      },
    ]);
  }

  async checkReadAccess(): Promise<boolean> {
    try {
      await this.#client.getDirectoryContents(this.#root === "." ? "/" : this.#root);
      return true;
    } catch {
      return false;
    }
  }

  async checkWriteAccess(): Promise<boolean> {
    try {
      await this.#client.createDirectory(posix.join(this.#root, ".storage-test"), {
        recursive: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createDirectory(): Promise<void> {
    await this.#client.createDirectory(this.#root === "." ? "/" : this.#root, { recursive: true });
  }

  #clientOptions(): WebDAVClientOptions {
    // The webdav package only lets TLS verification be disabled by supplying a
    // custom https.Agent — there is no top-level "insecure" flag.
    const httpsAgent =
      this.#config.rejectUnauthorized === false
        ? new Agent({ rejectUnauthorized: false })
        : undefined;
    if (this.#config.auth.kind === "basic") {
      return {
        authType: AuthType.Password,
        username: this.#config.auth.username,
        password: this.#config.auth.password,
        ...(httpsAgent === undefined ? {} : { httpsAgent }),
      };
    }
    if (this.#config.auth.kind === "bearer") {
      return {
        authType: AuthType.Token,
        token: { access_token: this.#config.auth.token, token_type: "Bearer" },
        ...(httpsAgent === undefined ? {} : { httpsAgent }),
      };
    }
    return {
      authType: AuthType.None,
      ...(httpsAgent === undefined ? {} : { httpsAgent }),
    };
  }

  #resolveSafe(relativePath: string): string {
    return resolveRemotePath(this.#root, relativePath, "WebDAV");
  }

  async #resolveCollision(target: string): Promise<string> {
    if (!(await this.#client.exists(target))) return target;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = collisionCandidate(target, suffix);
      if (!(await this.#client.exists(candidate))) return candidate;
    }
  }
}
