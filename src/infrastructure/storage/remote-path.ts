import { extname, posix } from "node:path";
import { StorageError } from "../../domain/errors.js";

export function normalizeRemoteRoot(path: string): string {
  const normalized = posix.normalize(path.split("\\").join("/"));
  if (normalized === "." || normalized === "/") return ".";
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function resolveRemotePath(root: string, relativePath: string, label: string): string {
  const normalizedInput = relativePath.split("\\").join("/");
  if (posix.isAbsolute(normalizedInput)) {
    throw new StorageError(`Refusing absolute path: ${relativePath}`);
  }
  const normalized = posix.normalize(normalizedInput);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new StorageError(`Path escapes the ${label} root: ${relativePath}`);
  }
  if (normalized.split("/").includes(".tmp")) {
    throw new StorageError(`Directory name ".tmp" is reserved for internal use`);
  }
  return posix.join(root, normalized);
}

export function collisionCandidate(target: string, suffix: number): string {
  const ext = extname(target);
  const base = ext === "" ? target : target.slice(0, -ext.length);
  return `${base}_${suffix}${ext}`;
}
