import { eq } from "drizzle-orm";
import type { StorageTargetUiRepository } from "../../domain/ports/repositories.js";
import type { StorageBackendKind, StorageConfig } from "../../domain/storage-config.js";
import type { Cipher } from "../crypto/cipher.js";
import type { Database } from "../persistence/database.js";
import { setting } from "../persistence/schema.js";
import { storageConfigSchema } from "./storage-config-schema.js";

const LEGACY_BACKENDS: readonly StorageBackendKind[] = ["local", "smb", "ftp", "sftp", "webdav"];

const TARGET_NAME: Record<StorageBackendKind, string> = {
  local: "Lokaler Speicher",
  smb: "SMB/CIFS",
  ftp: "FTP/FTPS",
  sftp: "SFTP",
  webdav: "WebDAV",
  paperless: "Paperless-ngx",
};

/**
 * One-time, idempotent upgrade path (spec section 15): milestone 6a stored
 * exactly one active backend under two `setting` keys. The first boot after
 * this feature ships carries that single backend forward as the initial,
 * default storage target — nothing is lost, and a fresh install with no
 * legacy keys just gets a "Lokaler Speicher" default pointing at the
 * downloads directory. Runs only while the storage_target table is empty, so
 * it never re-fires or clobbers targets a user already created.
 */
export async function ensureInitialStorageTarget(
  db: Database,
  cipher: Cipher,
  targets: StorageTargetUiRepository,
): Promise<void> {
  const existing = await targets.list();
  if (existing.length > 0) return;

  const config = readLegacyStorageConfig(db, cipher);
  const targetId = await targets.create({
    name: TARGET_NAME[config.backend],
    purpose: "document",
    description: null,
    config,
    status: config.backend === "local" ? "connected" : "untested",
  });
  await targets.setDefault(targetId);
}

function readLegacyStorageConfig(db: Database, cipher: Cipher): StorageConfig {
  const backendRow = db.select().from(setting).where(eq(setting.key, "storage_backend")).get();
  if (backendRow === undefined) return { backend: "local" };

  let backend: unknown;
  try {
    backend = JSON.parse(backendRow.value);
  } catch {
    return { backend: "local" };
  }
  if (typeof backend !== "string" || !LEGACY_BACKENDS.includes(backend as StorageBackendKind)) {
    return { backend: "local" };
  }
  if (backend === "local") return { backend: "local" };

  const configRow = db.select().from(setting).where(eq(setting.key, "storage_config_enc")).get();
  if (configRow === undefined) return { backend: "local" };

  try {
    const hex = JSON.parse(configRow.value);
    if (typeof hex !== "string") return { backend: "local" };
    const plaintext = cipher.decrypt(Buffer.from(hex, "hex"));
    return storageConfigSchema.parse(JSON.parse(plaintext));
  } catch {
    // Corrupt legacy secret — fail open to local rather than block startup;
    // the user re-enters connection details for a fresh remote target.
    return { backend: "local" };
  }
}
