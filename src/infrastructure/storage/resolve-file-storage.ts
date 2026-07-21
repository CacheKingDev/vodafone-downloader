import type { FileStorage } from "../../domain/ports/file-storage.js";
import type { StorageTargetRepository } from "../../domain/ports/repositories.js";
import type { StorageConfig } from "../../domain/storage-config.js";
import { AtomicFileStorage } from "./atomic-file-storage.js";
import { FtpFileStorage } from "./ftp-file-storage.js";
import { SftpFileStorage } from "./sftp-file-storage.js";
import { SmbFileStorage } from "./smb-file-storage.js";
import { WebDavFileStorage } from "./webdav-file-storage.js";

export function buildFileStorage(config: StorageConfig, downloadsDir: string): FileStorage {
  switch (config.backend) {
    case "local":
      return new AtomicFileStorage(downloadsDir);
    case "smb":
      return new SmbFileStorage(config.smb);
    case "ftp":
      return new FtpFileStorage(config.ftp);
    case "sftp":
      return new SftpFileStorage(config.sftp);
    case "webdav":
      return new WebDavFileStorage(config.webdav);
  }
}

export async function resolveDefaultFileStorage(
  targets: Pick<StorageTargetRepository, "findDefault">,
  downloadsDir: string,
): Promise<FileStorage> {
  const target = await targets.findDefault();
  const config: StorageConfig = target === undefined ? { backend: "local" } : target.config;
  return buildFileStorage(config, downloadsDir);
}
