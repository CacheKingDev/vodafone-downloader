import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ConnectionTestResult } from "../../domain/connection-test.js";
import { StorageError } from "../../domain/errors.js";
import type { FileStorage, StoredFile } from "../../domain/ports/file-storage.js";
import type { SmbConfig } from "../../domain/storage-config.js";
import {
  type ConnectionProbes,
  defaultConnectionProbes,
  runConnectionTestSteps,
} from "./connection-test-runner.js";
import { collisionCandidate, normalizeRemoteRoot, resolveRemotePath } from "./remote-path.js";

const CONNECTION_TEST_MARKER = ".storage-test/marker.tmp";

/** Thrown when the "smbclient" binary itself cannot be started — a setup problem, not a login failure. */
class SmbToolMissingError extends Error {}

export type SmbRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export class SmbFileStorage implements FileStorage {
  readonly #config: SmbConfig;
  readonly #runner: SmbRunner;
  readonly #probes: ConnectionProbes;
  readonly #root: string;

  constructor(
    config: SmbConfig,
    runner: SmbRunner = runSmbClient,
    probes: ConnectionProbes = defaultConnectionProbes,
  ) {
    this.#config = config;
    this.#runner = runner;
    this.#probes = probes;
    this.#root = normalizeRemoteRoot(config.path);
  }

  async store(relativePath: string, bytes: Buffer): Promise<StoredFile> {
    const target = this.#resolveSafe(relativePath);
    const finalPath = await this.#resolveCollision(target);
    const tempDir = await mkdtemp(join(tmpdir(), "vid-smb-"));
    const localPath = join(tempDir, randomUUID());
    try {
      await writeFile(localPath, bytes);
      await this.#mkdirp(posix.dirname(finalPath));
      await this.#run(["put", localPath, finalPath]);
    } catch (cause) {
      throw new StorageError(`SMB-Speichern fehlgeschlagen: ${relativePath}`, { cause });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return {
      relativePath: posix.relative(this.#root, finalPath),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    };
  }

  async retrieve(relativePath: string): Promise<Buffer> {
    const target = this.#resolveSafe(relativePath);
    const tempDir = await mkdtemp(join(tmpdir(), "vid-smb-"));
    const localPath = join(tempDir, randomUUID());
    try {
      await this.#run(["get", target, localPath]);
      return await readFile(localPath);
    } catch (cause) {
      throw new StorageError(`SMB-Lesen fehlgeschlagen: ${relativePath}`, { cause });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async remove(relativePath: string): Promise<void> {
    try {
      await this.#run(["del", this.#resolveSafe(relativePath)]);
    } catch {
      return;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const testDir = posix.join(this.#root, ".storage-test");
    return runConnectionTestSteps([
      { id: "host_reachable", run: () => this.#probes.hostReachable(this.#config.host) },
      {
        id: "port_reachable",
        run: () => this.#probes.portReachable(this.#config.host, this.#config.port),
      },
      {
        id: "authenticated",
        run: async () => {
          try {
            await this.#run(["quit"]);
          } catch (cause) {
            if (cause instanceof SmbToolMissingError) throw cause;
            throw new Error(
              "Anmeldung fehlgeschlagen. Benutzername, Passwort oder Freigabe sind ungültig.",
              { cause },
            );
          }
        },
      },
      {
        id: "path_exists",
        run: async () => {
          if (this.#root === ".") return;
          if (!(await this.#exists(this.#root))) {
            throw new Error("Der Zielordner wurde nicht gefunden.");
          }
        },
      },
      {
        id: "read_access",
        run: async () => {
          try {
            await this.#runCommands(this.#root === "." ? [["ls"]] : [["cd", this.#root], ["ls"]]);
          } catch (cause) {
            throw new Error("Der Zielordner ist nicht lesbar.", { cause });
          }
        },
      },
      {
        id: "write_access",
        run: async () => {
          try {
            await this.#run(["mkdir", testDir]);
          } catch (cause) {
            // The test directory is left behind (its marker file is removed, but
            // not the directory itself) after every prior test run, so a repeat
            // test — e.g. clicking "Speichern" right after "Verbindung testen" —
            // always hits this. That collision proves nothing about write access
            // either way, so it isn't treated as a failure.
            if (
              cause instanceof Error &&
              cause.message.includes("NT_STATUS_OBJECT_NAME_COLLISION")
            ) {
              return;
            }
            throw new Error("Der Zielordner ist vorhanden, aber nicht beschreibbar.", { cause });
          }
        },
      },
      {
        id: "create_test_file",
        run: async () => {
          await this.store(CONNECTION_TEST_MARKER, Buffer.from("ok"));
          const bytes = await this.retrieve(CONNECTION_TEST_MARKER);
          if (!bytes.equals(Buffer.from("ok"))) {
            throw new Error("Testdatei enthielt nach dem Schreiben unerwartete Daten.");
          }
        },
      },
      {
        id: "delete_test_file",
        run: async () => {
          // remove() takes a root-relative path and prefixes the root itself —
          // passing an already-root-prefixed path here would double it up and
          // silently delete nothing (remove() swallows "not found" errors).
          await this.remove(CONNECTION_TEST_MARKER);
          // Best-effort: also remove the (now empty) test directory itself, so a
          // successful run leaves nothing behind. Failure here doesn't fail the
          // step — write_access already tolerates a leftover directory from a
          // run that couldn't clean up after itself.
          await this.#run(["rmdir", testDir]).catch(() => undefined);
        },
      },
    ]);
  }

  async checkReadAccess(): Promise<boolean> {
    try {
      await this.#runCommands(this.#root === "." ? [["ls"]] : [["cd", this.#root], ["ls"]]);
      return true;
    } catch {
      return false;
    }
  }

  async checkWriteAccess(): Promise<boolean> {
    try {
      await this.#run(["mkdir", posix.join(this.#root, ".storage-test")]);
      return true;
    } catch {
      return false;
    }
  }

  async createDirectory(): Promise<void> {
    await this.#mkdirp(this.#root === "." ? "" : this.#root);
  }

  #resolveSafe(relativePath: string): string {
    return resolveRemotePath(this.#root, relativePath, "SMB");
  }

  async #resolveCollision(target: string): Promise<string> {
    if (!(await this.#exists(target))) return target;
    for (let suffix = 2; ; suffix += 1) {
      const candidate = collisionCandidate(target, suffix);
      if (!(await this.#exists(candidate))) return candidate;
    }
  }

  async #exists(remotePath: string): Promise<boolean> {
    try {
      await this.#run(["allinfo", remotePath]);
      return true;
    } catch {
      return false;
    }
  }

  async #mkdirp(remoteDir: string): Promise<void> {
    if (remoteDir === "." || remoteDir === "") return;
    let current = "";
    for (const part of remoteDir.split("/")) {
      if (part === "" || part === ".") continue;
      current = current === "" ? part : `${current}/${part}`;
      await this.#run(["mkdir", current]).catch(() => undefined);
    }
  }

  async #run(command: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return this.#runCommands([command]);
  }

  async #runCommands(
    commands: readonly (readonly string[])[],
  ): Promise<{ stdout: string; stderr: string }> {
    const script = commands.map((command) => command.map(quoteSmbCommandPart).join(" ")).join(";");
    return this.#runner([...this.#baseArgs(), "-c", script]);
  }

  #baseArgs(): string[] {
    const args = [`//${this.#config.host}/${this.#config.share}`, "-p", String(this.#config.port)];
    if (this.#config.username === "" && this.#config.password === "") {
      args.push("-N");
    } else {
      args.push("-U", `${this.#config.username}%${this.#config.password}`);
    }
    if (this.#config.domain !== null && this.#config.domain !== "") {
      args.push("-W", this.#config.domain);
    }
    return args;
  }
}

function quoteSmbCommandPart(part: string): string {
  return `"${part.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function runSmbClient(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("smbclient", args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new SmbToolMissingError(
            'Das Programm "smbclient" wurde auf diesem System nicht gefunden. SMB-Speicherziele benötigen den Samba-Client (smbclient) installiert und im PATH.',
            { cause: error },
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      const ntStatusError = findSmbClientError(`${result.stdout}\n${result.stderr}`);
      if (code === 0 && ntStatusError === undefined) {
        resolve(result);
      } else {
        reject(new Error(ntStatusError ?? (result.stderr || `smbclient exited with code ${code}`)));
      }
    });
  });
}

/**
 * smbclient's "-c" batch mode only reflects connection-level failures in its
 * exit code — individual commands within the script (e.g. "allinfo" on a
 * missing file, "mkdir" on an existing one) print an NT_STATUS_* line to
 * stdout but still exit 0. Without this check, callers like #exists() would
 * treat every such failure as success (e.g. #resolveCollision looping
 * forever because it never sees a "file doesn't exist" result).
 */
export function findSmbClientError(output: string): string | undefined {
  const match = output.match(/NT_STATUS_(?!OK\b)\S.*$/m);
  return match?.[0].trim();
}
