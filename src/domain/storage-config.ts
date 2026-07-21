export type StorageBackendKind = "local" | "smb" | "ftp" | "sftp" | "webdav";

export interface SmbConfig {
  readonly host: string;
  readonly port: number;
  readonly share: string;
  readonly path: string;
  readonly username: string;
  readonly password: string;
  readonly domain: string | null;
}

export interface FtpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly username: string;
  readonly password: string;
  readonly secure: "none" | "explicit" | "implicit";
}

export interface SftpAuthPassword {
  readonly kind: "password";
  readonly password: string;
}

export interface SftpAuthKey {
  readonly kind: "key";
  readonly privateKey: string;
  readonly passphrase: string | null;
}

export type SftpAuth = SftpAuthPassword | SftpAuthKey;

export interface SftpConfig {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly username: string;
  readonly auth: SftpAuth;
}

export interface WebDavAuthBasic {
  readonly kind: "basic";
  readonly username: string;
  readonly password: string;
}

export interface WebDavAuthBearer {
  readonly kind: "bearer";
  readonly token: string;
}

export interface WebDavAuthNone {
  readonly kind: "none";
}

export type WebDavAuth = WebDavAuthBasic | WebDavAuthBearer | WebDavAuthNone;

export interface WebDavConfig {
  readonly url: string;
  readonly path: string;
  readonly auth: WebDavAuth;
  readonly rejectUnauthorized: boolean;
}

export type StorageConfig =
  | { readonly backend: "local" }
  | { readonly backend: "smb"; readonly smb: SmbConfig }
  | { readonly backend: "ftp"; readonly ftp: FtpConfig }
  | { readonly backend: "sftp"; readonly sftp: SftpConfig }
  | { readonly backend: "webdav"; readonly webdav: WebDavConfig };

/**
 * A non-secret, human-readable "where does this point" string (host/path) —
 * safe to show in the overview list (spec section 1) without ever touching
 * credentials.
 */
export function describeStorageDestination(config: StorageConfig): string {
  switch (config.backend) {
    case "local":
      return "Lokaler Ordner";
    case "smb":
      return joinNonEmpty([`${config.smb.host}/${config.smb.share}`, config.smb.path]);
    case "ftp":
      return joinNonEmpty([`${config.ftp.host}:${config.ftp.port}`, config.ftp.path]);
    case "sftp":
      return joinNonEmpty([`${config.sftp.host}:${config.sftp.port}`, config.sftp.path]);
    case "webdav":
      return joinNonEmpty([config.webdav.url, config.webdav.path]);
  }
}

function joinNonEmpty(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== "").join(" · ");
}
